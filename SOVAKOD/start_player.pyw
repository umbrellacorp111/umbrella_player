from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
import threading

LOG_FILE = ROOT / "server.log"

try:
    storage = ROOT / "user_data"
    storage.mkdir(parents=True, exist_ok=True)
    import os
    os.environ.setdefault("APP_DATA_DIR", str(storage))
    from yt_dlp_updater import check_and_update
    check_and_update(ROOT, storage)
    from server import PORT, bind_server, open_browser
    server, port = bind_server(PORT)
    threading.Timer(0.6, open_browser, args=[port]).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
except SystemExit:
    pass
except Exception:
    LOG_FILE.write_text(traceback.format_exc(), encoding="utf-8")
