#!/usr/bin/env python3
"""Serve the packaged frontend while its desktop process is alive."""

import http.server
import os
import pathlib
import sys
import threading
import time


class FrontendHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(pathlib.Path(sys.argv[1])), **kwargs)

    def log_message(self, format, *args):
        pass


def main():
    parent_pid = int(sys.argv[2])
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 1425), FrontendHandler)

    def stop_when_app_exits():
        while os.getppid() == parent_pid:
            time.sleep(0.5)
        server.shutdown()

    threading.Thread(target=stop_when_app_exits, daemon=True).start()
    server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
