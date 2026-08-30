from __future__ import annotations

import logging
import os
import sys
import threading

import webview


def get_root() -> str:
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def main() -> None:
    root = get_root()
    sys.path.insert(0, root)
    os.environ["APP_ROOT"] = root
    
    # Cleanup SoundCloud jobs cache on startup
    from server import SC_JOBS, SC_STREAM_LOCKS
    SC_JOBS.clear()
    SC_STREAM_LOCKS.clear()

    if getattr(sys, "frozen", False):
        storage = os.path.join(os.path.dirname(sys.executable), "user_data")
    else:
        storage = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_data")
    os.makedirs(storage, exist_ok=True)
    from yt_dlp_updater import check_and_update
    check_and_update(root, storage, logging.getLogger("umbrella"))

    from server import HOST, PORT, bind_server
    from config import WINDOW_HEIGHT, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_WIDTH

    server, port = bind_server(PORT)
    if port != PORT:
        logging.getLogger("umbrella").warning(
            "Порт %s занят, плеер поднят на %s", PORT, port
        )

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    window = webview.create_window(
        title="Umbrella Player",
        url=f"http://{HOST}:{port}",
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT),
        text_select=True,
    )

    def on_closed() -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    window.events.closed += on_closed

    try:
        webview.start(debug=False, private_mode=False, storage_path=storage)
    except Exception:
        logging.getLogger("umbrella").exception("webview.start crashed")
        try:
            server.shutdown()
        finally:
            sys.exit(1)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
