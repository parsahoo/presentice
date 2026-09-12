#!/usr/bin/env python3
"""Serve the site for development, with caching turned off.

`python3 -m http.server` sends no Cache-Control, so the browser applies heuristic
freshness and can hand back a module it fetched before the last edit. A half stale
module graph fails to boot, which looks exactly like a broken app. Development only:
the released site is served by GitHub Pages.

Usage: python3 scripts/dev-server.py [port]
"""
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8796
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoStoreHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that forbids caching of every response."""

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(NoStoreHandler, directory=ROOT)
    with ThreadingHTTPServer(('', port), handler) as server:
        print(f'Presentice on http://localhost:{port} (no-store)', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
