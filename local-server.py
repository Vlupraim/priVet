#!/usr/bin/env python3
"""
Servidor local para Privet.

Sirve la UI estatica y actua como proxy hacia el backend de transcripcion.
Esto evita problemas CORS cuando el navegador corre la pagina desde el PC.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from email import policy
from email.parser import BytesParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote


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

        payload_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False) as payload:
                payload_path = Path(payload.name)
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

            self._send_to_upstream(payload_path, length)
        finally:
            if payload_path:
                payload_path.unlink(missing_ok=True)

    def _send_to_upstream(self, payload_path: Path, length: int):
        output_filename = self._resolve_output_filename()

        try:
            status, reason, response_headers, response_body = self._send_to_upstream_with_curl(
                payload_path
            )
            saved_path = ""
            save_error = ""

            if 200 <= status < 300:
                try:
                    saved_path = self._save_transcription(response_body, output_filename)
                except Exception as exc:
                    save_error = str(exc)
            elif status >= 400:
                detail = response_body.decode("utf-8", errors="replace").strip()
                print(
                    f"Backend respondio HTTP {status}: {detail[:500] or 'sin detalle'}",
                    flush=True,
                )

            self.send_response(status, reason)
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
            for name, value in response_headers:
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
            print(f"Error conectando con backend: {exc}", flush=True)
            message = f"No se pudo conectar con el backend: {exc}\n".encode("utf-8", errors="replace")
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    def _send_to_upstream_with_curl(self, payload_path: Path):
        curl_path = shutil.which("curl.exe") or shutil.which("curl")
        if not curl_path:
            raise RuntimeError("No se encontro curl.exe en este Windows.")

        endpoint = f"{UPSTREAM_BASE_URL}{TRANSCRIPTION_PATH}"
        accept = self.headers.get("Accept", "*/*")
        extracted_paths = []

        with tempfile.NamedTemporaryFile(delete=False) as body_file, tempfile.NamedTemporaryFile(
            delete=False
        ) as header_file:
            body_path = Path(body_file.name)
            header_path = Path(header_file.name)

        try:
            curl_form_args, extracted_paths = self._build_curl_form_args(payload_path)
            if not curl_form_args:
                curl_form_args = self._build_curl_raw_args(payload_path)

            command = [
                curl_path,
                "--silent",
                "--show-error",
                "--location",
                "--http1.1",
                "--request",
                "POST",
                endpoint,
                "--header",
                f"Accept: {accept}",
                "--header",
                "Expect:",
                "--header",
                "User-Agent: PrivetLocalProxy/1.0",
                *curl_form_args,
                "--dump-header",
                str(header_path),
                "--output",
                str(body_path),
                "--max-time",
                "7200",
                "--connect-timeout",
                "30",
                "--write-out",
                "%{http_code}",
            ]
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=60 * 60 * 2,
                check=False,
            )

            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "curl no pudo completar la solicitud").strip()
                raise RuntimeError(detail)

            try:
                status = int((completed.stdout or "").strip()[-3:])
            except ValueError as exc:
                raise RuntimeError(f"curl no devolvio un codigo HTTP valido: {completed.stdout}") from exc

            response_headers = self._parse_curl_headers(header_path.read_text(encoding="iso-8859-1"))
            reason = self._reason_from_status(status, response_headers)
            response_body = body_path.read_bytes()
            return status, reason, response_headers, response_body
        finally:
            body_path.unlink(missing_ok=True)
            header_path.unlink(missing_ok=True)
            for extracted_path in extracted_paths:
                extracted_path.unlink(missing_ok=True)

    def _build_curl_raw_args(self, payload_path: Path):
        content_type = self.headers.get("Content-Type", "application/octet-stream")
        return [
            "--header",
            f"Content-Type: {content_type}",
            "--data-binary",
            f"@{payload_path}",
        ]

    def _build_curl_form_args(self, payload_path: Path):
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type.lower():
            return [], []

        raw_payload = payload_path.read_bytes()
        mime_payload = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
            + raw_payload
        )
        message = BytesParser(policy=policy.default).parsebytes(mime_payload)

        if not message.is_multipart():
            return [], []

        args = []
        extracted_paths = []

        for part in message.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if not field_name:
                continue

            data = part.get_payload(decode=True) or b""
            filename = part.get_filename()

            if filename:
                suffix = Path(filename).suffix or ".upload"
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as file_part:
                    file_part.write(data)
                    extracted_path = Path(file_part.name)

                extracted_paths.append(extracted_path)
                args.extend(["--form", f"{field_name}=@{extracted_path};filename={filename}"])
                continue

            charset = part.get_content_charset() or "utf-8"
            value = data.decode(charset, errors="replace")
            args.extend(["--form", f"{field_name}={value}"])

        if args:
            print("Reenviando al backend con curl -F reconstruido.", flush=True)

        return args, extracted_paths

    @staticmethod
    def _parse_curl_headers(raw_headers):
        blocks = [block for block in raw_headers.replace("\r\n", "\n").split("\n\n") if block.strip()]
        if not blocks:
            return []

        last_block = blocks[-1]
        lines = last_block.splitlines()
        headers = []
        for line in lines[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers.append((name.strip(), value.strip()))

        return headers

    @staticmethod
    def _reason_from_status(status, response_headers):
        # BaseHTTPRequestHandler accepts an arbitrary reason phrase.
        reasons = {
            200: "OK",
            201: "Created",
            204: "No Content",
            400: "Bad Request",
            404: "Not Found",
            408: "Request Timeout",
            413: "Payload Too Large",
            422: "Unprocessable Entity",
            500: "Internal Server Error",
            502: "Bad Gateway",
            503: "Service Unavailable",
            504: "Gateway Timeout",
        }
        return reasons.get(status, "OK")

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
