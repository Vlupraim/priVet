#!/usr/bin/env python3
"""
Servidor local para Privet.

Sirve la UI estatica y actua como proxy hacia el backend de transcripcion.
Esto evita problemas CORS cuando el navegador corre la pagina desde el PC.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PRIVET_PORT", "8787"))
UPSTREAM_BASE_URL = os.environ.get(
    "PRIVET_API_BASE_URL",
    "https://whisper-skynet.bourbaki-lab.duckdns.org",
).rstrip("/")
OUTPUT_DIR = Path(
    os.environ.get(
        "PRIVET_OUTPUT_DIR",
        r"C:\Users\kuqui\OneDrive\Escritorio\alejandria",
    )
)
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
            f"  LOCAL_OUTPUT_DIR: {json.dumps(str(OUTPUT_DIR))},\n"
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
        output_filename = self._resolve_output_filename()

        try:
            conn.request("POST", target_path, body=payload, headers=headers)
            response = conn.getresponse()
            response_body = response.read()
            saved_path = ""
            save_error = ""

            if 200 <= response.status < 300:
                try:
                    saved_path = self._save_transcription(response_body, output_filename)
                except Exception as exc:
                    save_error = str(exc)

            self.send_response(response.status, response.reason)
            self._send_cors_headers()

            skipped_headers = {
                "connection",
                "content-length",
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

            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("X-Privet-Output-Dir", quote(str(OUTPUT_DIR), safe=""))
            if saved_path:
                self.send_header("X-Privet-Saved-Path", quote(saved_path, safe=""))
            if save_error:
                self.send_header("X-Privet-Save-Error", quote(save_error, safe=""))

            self.end_headers()
            self.wfile.write(response_body)
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

    def _resolve_output_filename(self):
        encoded_name = self.headers.get("X-Privet-Output-Filename", "")
        if encoded_name:
            decoded = unquote(encoded_name).strip()
            if decoded:
                return decoded

        return "transcripcion.txt"

    @staticmethod
    def _sanitize_file_name(file_name):
        base_name = Path(file_name or "transcripcion.txt").name
        if not base_name.lower().endswith(".txt"):
            base_name = f"{base_name}.txt"

        stem = re.sub(r'[\\/:*?"<>|]+', "-", Path(base_name).stem)
        stem = re.sub(r"\s+", "-", stem).strip(".-")[:120] or "transcripcion"
        return f"{stem}.txt"

    @staticmethod
    def _normalize_response_text(response_body):
        text = response_body.decode("utf-8-sig", errors="replace")

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return text

        if isinstance(parsed, str):
            return parsed

        if isinstance(parsed, dict):
            for key in ("text", "transcription", "transcript", "result", "output"):
                value = parsed.get(key)
                if isinstance(value, str) and value.strip():
                    return value

        return text

    def _save_transcription(self, response_body, output_filename):
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        file_name = self._sanitize_file_name(output_filename)
        candidate = OUTPUT_DIR / file_name
        counter = 2

        while candidate.exists():
            candidate = OUTPUT_DIR / f"{Path(file_name).stem}-{counter}.txt"
            counter += 1

        transcription_text = self._normalize_response_text(response_body)
        candidate.write_text(transcription_text, encoding="utf-8")
        return str(candidate)


def main() -> int:
    address = ("127.0.0.1", PORT)
    with ThreadingHTTPServer(address, PrivetLocalHandler) as server:
        print(f"Privet local: http://{address[0]}:{PORT}/")
        print(f"Backend proxy: {UPSTREAM_BASE_URL}{TRANSCRIPTION_PATH}")
        print(f"Carpeta de salida: {OUTPUT_DIR}")
        print("Deja esta ventana abierta mientras uses la pagina.")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        raise SystemExit(0)
