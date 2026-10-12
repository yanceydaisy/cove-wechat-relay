import json
import os
import time
from datetime import datetime

from wechatauto import WeChatDB
from wechatauto.db import Listener

TARGET = os.environ.get("COVE_WECHAT_TARGET", "").strip()
if not TARGET:
    raise RuntimeError("COVE_WECHAT_TARGET is not configured")

db = WeChatDB()
me = db.get_self_info()
print("[ready]", json.dumps(me, ensure_ascii=False), flush=True)
print("[target]", TARGET, db.get_nickname(TARGET), flush=True)

def on_msg(msg, listener):
    event = {
        "received_at": datetime.now().isoformat(timespec="seconds"),
        "chat": TARGET,
        "sender_id": msg.get("sender_id"),
        "sender_username": msg.get("sender_username"),
        "type": msg.get("type"),
        "content": msg.get("content"),
        "create_time": msg.get("create_time"),
        "local_id": msg.get("local_id"),
    }
    print("[message]", json.dumps(event, ensure_ascii=False, default=str), flush=True)

listener = Listener(db, interval=0.8)
listener.add_listener(TARGET, on_msg)
listener.start()
print("[listening] read-only; Ctrl+C to stop", flush=True)

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    listener.stop()
    print("[stopped]", flush=True)
