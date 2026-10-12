from __future__ import annotations

import ctypes
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import sys
import time
import winreg

ROOT = Path(__file__).resolve().parent
ADAPTER = ROOT / "adapter.py"
LOG_DIR = ROOT / "logs"
LOG_PATH = LOG_DIR / "supervisor.log"
MUTEX_NAME = r"Local\CoveWeChatAdapterSupervisor"
RESTART_DELAY_SECONDS = 5
WECHAT_WAIT_SECONDS = 5
REQUIRED_ENV = (
    "COVE_WECHAT_BRIDGE_URL",
    "COVE_WECHAT_AGENT_TOKEN",
    "COVE_WECHAT_TARGET",
)


def configure_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("cove-wechat-supervisor")
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(
        LOG_PATH,
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return logger


def acquire_mutex() -> object:
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise OSError("failed to create supervisor mutex")
    if ctypes.windll.kernel32.GetLastError() == 183:
        ctypes.windll.kernel32.CloseHandle(handle)
        raise SystemExit(0)
    return handle


def load_user_environment() -> None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as key:
            for name in REQUIRED_ENV:
                if os.environ.get(name):
                    continue
                try:
                    value, _ = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    continue
                os.environ[name] = str(value)
    except OSError:
        pass


def wechat_running() -> bool:
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/NH"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        creationflags=subprocess.CREATE_NO_WINDOW,
        check=False,
    )
    return "Weixin.exe" in result.stdout


def main() -> int:
    logger = configure_logging()
    mutex = acquire_mutex()
    load_user_environment()

    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        logger.error("missing required user environment variables: %s", ", ".join(missing))
        return 2

    logger.info("supervisor started")

    try:
        while True:
            if not wechat_running():
                logger.info("WeChat is not running; waiting")
                time.sleep(WECHAT_WAIT_SECONDS)
                continue

            logger.info("starting adapter")
            proc = subprocess.Popen(
                [sys.executable, "-u", str(ADAPTER)],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )

            assert proc.stdout is not None
            for line in proc.stdout:
                logger.info("[adapter] %s", line.rstrip())

            code = proc.wait()
            logger.warning(
                "adapter exited with code %s; restarting in %ss",
                code,
                RESTART_DELAY_SECONDS,
            )
            time.sleep(RESTART_DELAY_SECONDS)
    finally:
        ctypes.windll.kernel32.ReleaseMutex(mutex)
        ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
