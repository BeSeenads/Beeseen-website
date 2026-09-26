#!/usr/bin/env python3
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))


def read_env(path: Path) -> dict:
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def env_value(name: str) -> str:
    from_file = {}
    from_file.update(read_env(ROOT / ".env"))
    from_file.update(read_env(ROOT / ".env.local"))
    return from_file.get(name) or os.environ.get(name, "")


class BeSeenHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/config":
            payload = {
                "supabaseUrl": env_value("SUPABASE_URL"),
                "supabasePublishableKey": env_value("SUPABASE_PUBLISHABLE_KEY"),
            }
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/":
            self.path = "/entry.html"

        super().do_GET()

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args))

    def translate_path(self, path):
        parsed = unquote(urlparse(path).path)
        if parsed == "/":
            parsed = "/entry.html"
        return super().translate_path(parsed)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), BeSeenHandler)
    print(f"BeSeen local server running at http://127.0.0.1:{PORT}/")
    server.serve_forever()
