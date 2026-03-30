from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = os.environ.get("OPENAI_ACTIVITY_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPENAI_ACTIVITY_PORT", "8787"))
TOKEN = os.environ.get("OPENAI_ACTIVITY_TOKEN", "")
SOURCE_FILE = Path(os.environ.get("OPENAI_ACTIVITY_SOURCE_FILE", "/root/.openclaw/agent-openai-activity.json"))


def read_payload() -> dict:
    if SOURCE_FILE.exists():
        try:
            payload = json.loads(SOURCE_FILE.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                return payload
        except Exception:
            pass
    return {
        "status": "online",
        "detail": "OpenAI noch ohne Daten",
        "recentActivity": False,
        "activityMetric": "tokens:0",
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/status":
            self.send_error(404)
            return

        if TOKEN:
            auth_header = self.headers.get("Authorization", "")
            if auth_header != f"Bearer {TOKEN}":
                self.send_error(401)
                return

        payload = read_payload()
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Serving OpenAI activity on http://{HOST}:{PORT}/status from {SOURCE_FILE}")
    server.serve_forever()
