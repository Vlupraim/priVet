#!/usr/bin/env python3
"""
Servidor local para Privet.

Sirve la UI estatica y actua como proxy hacia el backend de transcripcion.
Esto evita problemas CORS cuando el navegador corre la pagina desde el PC.
"""

from __future__ import annotations

import http.client
import os
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PRIVET_PORT", "8787"))
UPSTREAM_BASE_URL = os.environ.get(
    "PRIVET_API_BASE_URL",
    "https://whisper-skynet.bourbaki-lab.duckdns.org",
).rstrip("/")
TRANSCRIPTION_PATH = "/audio/transcription/"


class PrivetLocalHandler(SimpleHTTPRequestHandler):
    server_version = "PrivetLocal/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):  # noqa: N802 - nombre requerido por BaseHTTPRequestHandler
        if self.path.split("?", 1)[0] == "/assets/js/runtime-config.js":
            self._send_runtime_config()
            return

        super().do_GET()

    def do_OPTIONS(self):  # noqa: N802
        if self.path.split("?", 1)[0] == TRANSCRIPTION_PATH:
            self.send_response(204)
            self._send_cors_headers()
            self.end_headers()
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        if self.path.split("?", 1)[0] != TRANSCRIPTION_PATH:
            self.send_error(404, "Ruta no encontrada")
            return

        self._proxy_transcription_request()

    def _send_runtime_config(self):
        body = (
            "window.APP_CONFIG = Object.freeze({\n"
            "  API_BASE_URL: window.location.origin,\n"
            "});\n"
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _proxy_transcription_request(self):
        content_length = self.headers.get("Content-Length")
        if not content_length:
            self.send_error(411, "Content-Length requerido")
            return

        try:
            length = int(content_length)
        except ValueError:
            self.send_error(400, "Content-Length invalido")
            return

        with tempfile.TemporaryFile() as payload:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                payload.write(chunk)
                remaining -= len(chunk)

            if remaining:
                self.send_error(400, "Solicitud incompleta")
                return

            payload.seek(0)
            self._send_to_upstream(payload, length)

    def _send_to_upstream(self, payload, length: int):
        target = urlsplit(f"{UPSTREAM_BASE_URL}{TRANSCRIPTION_PATH}")
        conn_class = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        conn = conn_class(target.netloc, timeout=60 * 60)
        target_path = target.path or TRANSCRIPTION_PATH
        if target.query:
            target_path = f"{target_path}?{target.query}"

        headers = {
            "Accept": self.headers.get("Accept", "*/*"),
            "Content-Length": str(length),
            "Content-Type": self.headers.get("Content-Type", "application/octet-stream"),
            "User-Agent": "PrivetLocalProxy/1.0",
        }

        try:
            conn.request("POST", target_path, body=payload, headers=headers)
            response = conn.getresponse()
            self.send_response(response.status, response.reason)
            self._send_cors_headers()

            skipped_headers = {
                "connection",
                "keep-alive",
                "proxy-authenticate",
                "proxy-authorization",
                "te",
                "trailers",
                "transfer-encoding",
                "upgrade",
            }
            for name, value in response.getheaders():
                if name.lower() not in skipped_headers:
                    self.send_header(name, value)

            self.end_headers()
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception as exc:  # pragma: no cover - mensaje operativo
            message = f"No se pudo conectar con el backend: {exc}\n".encode("utf-8", errors="replace")
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)
        finally:
            conn.close()


def main() -> int:
    address = ("127.0.0.1", PORT)
    with ThreadingHTTPServer(address, PrivetLocalHandler) as server:
        print(f"Privet local: http://{address[0]}:{PORT}/")
        print(f"Backend proxy: {UPSTREAM_BASE_URL}{TRANSCRIPTION_PATH}")
        print("Deja esta ventana abierta mientras uses la pagina.")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        raise SystemExit(0)
