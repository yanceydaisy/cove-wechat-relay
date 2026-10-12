import ctypes
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import winreg
from pathlib import Path

from wechatauto import WeChatDB
from wechatauto.db import Listener
from wechatauto.guia import WeChatGUI


MUTEX_NAME = "Global\\CoveWechatAdapter"
JOURNAL_PATH = Path(__file__).resolve().parent / ".local" / "delivered_commands.json"
JOURNAL_LIMIT = 2_000
ACK_DELAYS = (0.0, 0.5, 1.0, 2.0, 4.0, 8.0, 8.0)
RECEIPT_RETRY_SECONDS = 3.0

# Caddy/OpenSSL can occasionally close an otherwise complete HTTPS response
# without a TLS close_notify. Python 3.12 + OpenSSL 3 reports that as
# SSLEOFError by default. Ignore only that shutdown framing defect; certificate
# and hostname verification remain fully enabled.
HTTP_SSL_CONTEXT = ssl.create_default_context()
if hasattr(ssl, "OP_IGNORE_UNEXPECTED_EOF"):
    HTTP_SSL_CONTEXT.options |= ssl.OP_IGNORE_UNEXPECTED_EOF


def user_setting(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value:
        return value
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value)
    except OSError:
        return default


def required_setting(name: str) -> str:
    value = user_setting(name).strip()
    if not value:
        raise RuntimeError(f"{name} is not configured")
    return value


BRIDGE = required_setting("COVE_WECHAT_BRIDGE_URL").rstrip("/")
TOKEN = required_setting("COVE_WECHAT_AGENT_TOKEN")
TARGET = required_setting("COVE_WECHAT_TARGET")

_mutex = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
if ctypes.windll.kernel32.GetLastError() == 183:
    print("[adapter] already running", flush=True)
    sys.exit(0)


def http_json(method: str, path: str, payload=None, timeout: int = 35):
    data = None
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        BRIDGE + path,
        data=data,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout, context=HTTP_SSL_CONTEXT) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def retry_json(method: str, path: str, payload=None, timeout: int = 12, attempts: int = 5):
    last_error = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(min(0.5 * (2 ** (attempt - 1)), 4.0))
        try:
            return http_json(method, path, payload, timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise RuntimeError("request_failed")


class DeliveryJournal:
    """Durable sent-command journal plus positive-ACK outbox.

    The old on-disk format was a JSON list of delivered command ids. The new
    format keeps that dedupe history and, in the same atomic file replacement,
    records which successful delivery receipts still need to reach Bridge.
    """

    def __init__(self, path: Path):
        self.path = path
        self._items: list[str] = []
        self._set: set[str] = set()
        self._pending: set[str] = set()
        self._lock = threading.RLock()
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                # Backward-compatible migration from the v1 journal. Old
                # commands are already historical, so do not replay all of
                # their ACKs merely because the format changed.
                items = [str(item) for item in raw if item]
                pending: list[str] = []
            elif isinstance(raw, dict):
                items = [str(item) for item in raw.get("delivered", []) if item]
                pending = [str(item) for item in raw.get("pendingReceipts", []) if item]
            else:
                items = []
                pending = []

            self._items = items[-JOURNAL_LIMIT:]
            self._set = set(self._items)
            self._pending = {item for item in pending if item in self._set}
        except (OSError, ValueError, TypeError):
            self._items = []
            self._set = set()
            self._pending = set()

    def _persist_locked(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(
                {
                    "delivered": self._items,
                    "pendingReceipts": sorted(self._pending),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        temp.replace(self.path)

    def contains(self, command_id: str) -> bool:
        with self._lock:
            return command_id in self._set

    def remember(self, command_id: str) -> None:
        """Atomically remember a successful send and queue its ACK."""
        with self._lock:
            if command_id not in self._set:
                self._items.append(command_id)
                self._set.add(command_id)

            self._pending.add(command_id)
            if len(self._items) > JOURNAL_LIMIT:
                removed = self._items[:-JOURNAL_LIMIT]
                self._items = self._items[-JOURNAL_LIMIT:]
                live = set(self._items)
                for item in removed:
                    if item not in live:
                        self._set.discard(item)
                        self._pending.discard(item)

            self._persist_locked()

    def queue_receipt(self, command_id: str) -> None:
        with self._lock:
            if command_id not in self._set:
                return
            if command_id in self._pending:
                return
            self._pending.add(command_id)
            self._persist_locked()

    def mark_acknowledged(self, command_id: str) -> None:
        with self._lock:
            if command_id not in self._pending:
                return
            self._pending.discard(command_id)
            self._persist_locked()

    def pending_receipts(self) -> list[str]:
        with self._lock:
            return list(self._pending)


journal = DeliveryJournal(JOURNAL_PATH)
receipt_wake = threading.Event()


def acknowledge_once(command_id: str) -> bool:
    try:
        result = http_json(
            "POST",
            "/wechat/agent/result",
            {"commandId": command_id, "ok": True},
            timeout=8,
        )
        if result.get("ok"):
            print("[receipt:ack]", command_id, flush=True)
            return True
        print("[receipt:deferred]", command_id, repr(result), flush=True)
    except Exception as exc:
        print("[receipt:deferred]", command_id, repr(exc), flush=True)
    return False


def receipt_loop() -> None:
    print(
        "[receipt] outbox ready; pending=",
        len(journal.pending_receipts()),
        sep="",
        flush=True,
    )
    while True:
        pending = journal.pending_receipts()
        for command_id in pending:
            if acknowledge_once(command_id):
                journal.mark_acknowledged(command_id)

        receipt_wake.wait(RECEIPT_RETRY_SECONDS)
        receipt_wake.clear()


def queue_success_receipt(command_id: str) -> None:
    journal.queue_receipt(command_id)
    receipt_wake.set()


def acknowledge(command_id: str, ok: bool, error: str = "") -> bool:
    payload = {"commandId": command_id, "ok": ok}
    if error:
        payload["error"] = error[:1000]

    last_error = None
    for delay in ACK_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            result = http_json("POST", "/wechat/agent/result", payload, timeout=12)
            if result.get("ok"):
                print("[ack]", command_id, "ok=" + str(ok), flush=True)
                return True
            last_error = RuntimeError(f"ack_rejected:{result!r}")
        except Exception as exc:
            last_error = exc
            print("[ack:retry]", command_id, repr(exc), flush=True)

    print("[ack:failed]", command_id, repr(last_error), flush=True)
    return False


def main() -> None:
    db = WeChatDB()
    self_info = db.get_self_info()
    target_name = db.get_nickname(TARGET) or TARGET

    print("[adapter] bridge:", BRIDGE, flush=True)
    print("[adapter] self:", self_info.get("nick_name"), self_info.get("username"), flush=True)
    print("[adapter] target:", target_name, TARGET, flush=True)
    print(
        "[adapter] delivery journal:",
        len(journal._items),
        "delivered;",
        len(journal.pending_receipts()),
        "receipt(s) pending",
        flush=True,
    )

    def on_message(msg, listener) -> None:
        if msg.get("sender_username") != TARGET:
            return
        if msg.get("type") != "\u6587\u672c":
            return

        text = str(msg.get("content") or "").strip()
        if not text:
            return

        event_id = "wechat:{}:{}:{}".format(
            TARGET,
            msg.get("create_time") or 0,
            msg.get("local_id") or 0,
        )
        payload = {
            "eventId": event_id,
            "conversationId": TARGET,
            "text": text,
        }
        try:
            result = retry_json("POST", "/wechat/agent/events", payload, timeout=12, attempts=5)
            print(
                "[inbound]",
                event_id,
                "created=" + str(result.get("created")),
                repr(text),
                flush=True,
            )
        except Exception as exc:
            print("[inbound:error]", event_id, repr(exc), flush=True)

    def outbound_loop() -> None:
        gui = WeChatGUI()
        print("[outbound] sender ready", flush=True)

        while True:
            try:
                packet = http_json("GET", "/wechat/agent/next", timeout=35)
                command = packet.get("command")
                if not command:
                    continue

                command_id = str(command.get("id") or "")
                conversation_id = str(command.get("conversationId") or "")
                text = str(command.get("text") or "")

                if conversation_id != TARGET:
                    print("[outbound:reject]", conversation_id, flush=True)
                    acknowledge(command_id, False, "conversation_not_whitelisted")
                    continue

                if journal.contains(command_id):
                    print("[outbound:dedupe]", command_id, flush=True)
                    queue_success_receipt(command_id)
                    continue

                display_name = db.get_nickname(conversation_id) or conversation_id
                print(
                    "[outbound]",
                    command_id,
                    "to=" + display_name,
                    repr(text),
                    flush=True,
                )

                before_rows = db.get_messages(conversation_id, limit=1)
                before_sort_seq = int(before_rows[0].get("sort_seq") or 0) if before_rows else 0
                response = gui.send_msg(text, display_name, verify=True)

                # A long-lived WeChat UIA object can go stale after hours of idle time.
                # If the UI action was attempted but DB verification failed, wait once more,
                # prove that no matching outgoing row appeared after our watermark, then
                # rebuild the GUI driver and retry exactly once. This avoids both silent loss
                # and blind duplicate sends.
                if not response:
                    error_text = (
                        str(response.get("message") or "")
                        if isinstance(response, dict)
                        else ""
                    )
                    if "数据库未确认" in error_text:
                        time.sleep(2)
                        recent = db.get_messages(conversation_id, limit=12)
                        confirmed = any(
                            int(row.get("sort_seq") or 0) > before_sort_seq
                            and int(row.get("sender_id") or 0) == 2
                            and str(row.get("content") or "") == text
                            for row in recent
                        )
                        if confirmed:
                            response = {"status": "success", "message": "confirmed_after_wait"}
                            print("[outbound:late-confirm]", command_id, flush=True)
                        else:
                            print("[outbound:retry-fresh-gui]", command_id, flush=True)
                            gui = WeChatGUI()
                            response = gui.send_msg(text, display_name, verify=True)

                if response:
                    # Persist the receipt before ACK. If the network dies here, a retry of
                    # the same command id will ACK only and will never send WeChat twice.
                    journal.remember(command_id)
                    print("[outbound:sent]", command_id, flush=True)
                    receipt_wake.set()
                else:
                    error = (
                        str(response.get("message") or "send_failed")
                        if isinstance(response, dict)
                        else "send_failed"
                    )
                    print("[outbound:failed]", command_id, error, flush=True)
                    acknowledge(command_id, False, error)

            except urllib.error.HTTPError as exc:
                print("[outbound:http]", exc.code, flush=True)
                time.sleep(2)
            except Exception as exc:
                print("[outbound:error]", repr(exc), flush=True)
                time.sleep(2)

    listener = Listener(db, interval=0.8)
    listener.add_listener(TARGET, on_message)
    listener.start()
    print("[listener] active for", TARGET, flush=True)

    receipt_worker = threading.Thread(
        target=receipt_loop,
        name="wechat-receipts",
        daemon=True,
    )
    receipt_worker.start()

    worker = threading.Thread(
        target=outbound_loop,
        name="wechat-outbound",
        daemon=True,
    )
    worker.start()

    try:
        heartbeat = retry_json("POST", "/wechat/agent/heartbeat", {}, timeout=12, attempts=3)
        print("[heartbeat]", heartbeat.get("ok"), flush=True)
    except Exception as exc:
        print("[heartbeat:error]", repr(exc), flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        listener.stop()
        print("[adapter] stopped", flush=True)


if __name__ == "__main__":
    main()