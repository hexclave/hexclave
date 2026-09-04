"""Unprivileged, local-only Wi-Fi setup portal for Hexclave TV Box."""

from __future__ import annotations

import argparse
import collections
import json
import logging
import secrets
import socket
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .policy import MAX_PORTAL_REQUEST_BYTES, MAX_PORTAL_SUBMISSIONS_PER_MINUTE
from .state import RUNTIME_ROOT

LOGGER = logging.getLogger("hexclave-tv-box-setup")
CAPTIVE_PATHS = {
    "/generate_204",
    "/gen_204",
    "/hotspot-detect.html",
    "/library/test/success.html",
    "/ncsi.txt",
    "/connecttest.txt",
    "/redirect",
}


def send_agent_request(socket_path: Path, request: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > 16_384:
        raise ValueError("TV Box agent request is too large.")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(50)
        connection.connect(str(socket_path))
        connection.sendall(encoded)
        response = bytearray()
        while not response.endswith(b"\n"):
            chunk = connection.recv(4096)
            if not chunk:
                break
            response.extend(chunk)
            if len(response) > 16_384:
                raise ValueError("TV Box agent response is too large.")
    decoded = json.loads(response)
    if not isinstance(decoded, dict) or decoded.get("ok") is not True or not isinstance(decoded.get("result"), dict):
        raise RuntimeError("TV Box network request could not be completed.")
    return decoded["result"]


class SubmissionLimiter:
    def __init__(self) -> None:
        self.attempts: dict[str, collections.deque[float]] = {}

    def allow(self, address: str, now: float) -> bool:
        history = self.attempts.setdefault(address, collections.deque())
        while history and history[0] <= now - 60:
            history.popleft()
        if len(history) >= MAX_PORTAL_SUBMISSIONS_PER_MINUTE:
            return False
        history.append(now)
        return True


class SetupPortalHandler(BaseHTTPRequestHandler):
    server_version = "HexclaveTVBox/1"

    def log_message(self, format_string: str, *arguments: object) -> None:
        # Request targets can contain information that does not belong in the
        # persistent journal. Stable status codes are logged by explicit paths.
        return

    def _json(self, status: HTTPStatus, value: dict[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, name: str) -> None:
        body = (self.server.ui_root / name).read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def _asset(self, name: str, content_type: str) -> None:
        body = (self.server.ui_root / name).read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        try:
            if path in {"/", "/index.html"} or path in CAPTIVE_PATHS:
                self._html("index.html")
            elif path == "/display":
                self._html("display.html")
            elif path == "/setup.css":
                self._asset("setup.css", "text/css; charset=utf-8")
            elif path == "/setup.js":
                self._asset("setup.js", "text/javascript; charset=utf-8")
            elif path == "/api/status":
                status = send_agent_request(self.server.agent_socket, {"command": "status"})
                self._json(HTTPStatus.OK, {**status, "csrfToken": self.server.csrf_token})
            elif path == "/api/networks":
                networks = send_agent_request(self.server.agent_socket, {"command": "scan"})
                self._json(HTTPStatus.OK, networks)
            else:
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Location", "/")
                self.end_headers()
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            LOGGER.warning("portal-read-failed")
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "setup-temporarily-unavailable"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path != "/api/wifi":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not-found"})
            return
        if self.headers.get("X-Hexclave-CSRF") != self.server.csrf_token:
            self._json(HTTPStatus.FORBIDDEN, {"error": "invalid-request"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "json-required"})
            return
        if not self.server.limiter.allow(self.client_address[0], time.monotonic()):
            self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "try-again-later"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = -1
        if content_length < 2 or content_length > MAX_PORTAL_REQUEST_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid-request"})
            return
        try:
            request = json.loads(self.rfile.read(content_length))
            if not isinstance(request, dict):
                raise ValueError("Wi-Fi request must be an object.")
            # Set the privileged command after the untrusted object so a body
            # field cannot select another agent operation.
            result = send_agent_request(self.server.agent_socket, {**request, "command": "connect"})
            self._json(HTTPStatus.OK, result)
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            LOGGER.warning("wifi-submission-failed")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "wifi-connection-failed"})


class SetupPortalServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address: tuple[str, int], *, ui_root: Path, agent_socket: Path) -> None:
        self.ui_root = ui_root
        self.agent_socket = agent_socket
        self.csrf_token = secrets.token_urlsafe(32)
        self.limiter = SubmissionLimiter()
        super().__init__(address, SetupPortalHandler)

    def get_request(self) -> tuple[socket.socket, tuple[str, int]]:
        request, client_address = super().get_request()
        request.settimeout(15)
        return request, client_address


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Hexclave TV Box Wi-Fi portal.")
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=80)
    parser.add_argument("--ui-root", type=Path, default=Path("/usr/share/hexclave-tv-box/setup-ui"))
    parser.add_argument("--agent-socket", type=Path, default=RUNTIME_ROOT / "control.sock")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    server = SetupPortalServer((arguments.bind, arguments.port), ui_root=arguments.ui_root, agent_socket=arguments.agent_socket)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
