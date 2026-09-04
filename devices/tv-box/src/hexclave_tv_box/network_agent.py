"""Root-owned NetworkManager policy agent for the local TV Box appliance."""

from __future__ import annotations

import argparse
import grp
import json
import logging
import os
import re
import secrets
import socketserver
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlsplit

from .policy import FRONTEND_RECOVERY_PROBE_SECONDS, NETWORK_POLL_SECONDS, SETUP_PORTAL_READY_TIMEOUT_SECONDS, NetworkMode, NetworkPolicy, NetworkState, advance_network_state, initial_network_state
from .state import RUNTIME_ROOT, STATE_ROOT, atomic_write

LOGGER = logging.getLogger("hexclave-tv-box-network")
SETUP_CONNECTION_NAME = "hexclave-tv-setup"
SAVED_CONNECTION_PREFIX = "hexclave-tv-network-"
WIFI_INTERFACE = "wlan0"
PRODUCTION_URL = "https://app.hexclave.com/tv-box"
OFFLINE_URL = "file:///usr/share/hexclave-tv-box/setup-ui/offline.html"
SETUP_URL = "http://127.0.0.1/display"
TEST_IMAGE_MARKER = Path("/etc/hexclave-tv-box-test-image")
TEST_ORIGIN_FILE = Path("/boot/firmware/hexclave-tv-box-test-origin.txt")
QUICK_TUNNEL_HOSTNAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$")
MAX_AGENT_REQUEST_BYTES = 16_384


def parse_test_renderer_origin(raw_value: str) -> str:
    lines = raw_value.splitlines()
    if len(lines) != 1 or raw_value not in {lines[0], f"{lines[0]}\n", f"{lines[0]}\r\n"}:
        raise ValueError("TV Box test origin must be exactly one line without surrounding whitespace.")
    origin = lines[0]
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except (UnicodeError, ValueError) as error:
        raise ValueError("TV Box test origin is not a valid URL origin.") from error
    hostname = parsed.hostname
    if (
        hostname is None
        or parsed.scheme != "https"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query != ""
        or parsed.fragment != ""
        or not QUICK_TUNNEL_HOSTNAME_PATTERN.fullmatch(hostname)
        or origin != f"https://{hostname}"
    ):
        raise ValueError("TV Box test origin must be one exact HTTPS *.trycloudflare.com origin.")
    return origin


def resolve_renderer_url(
    *,
    test_image_marker: Path = TEST_IMAGE_MARKER,
    test_origin_file: Path = TEST_ORIGIN_FILE,
) -> str:
    # The build-time rootfs marker is the security boundary: the writable boot
    # partition can select a tunnel only in an image deliberately built for testing.
    if not test_image_marker.is_file() or not test_origin_file.is_file():
        return PRODUCTION_URL
    try:
        origin = parse_test_renderer_origin(test_origin_file.read_text(encoding="utf-8"))
    except ValueError as error:
        # A typo on removable media must never broaden trust or put an appliance
        # into a reboot loop. Reject the override and retain the production URL.
        LOGGER.error("test-renderer-origin-rejected=%s", error)
        return PRODUCTION_URL
    return f"{origin}/tv-box"


def _run(command: Sequence[str], timeout: int = 45) -> str:
    result = subprocess.run(  # noqa: S603
        command,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return result.stdout


def _frontend_reachable(url: str, timeout: int = 10) -> bool:
    request = urllib_request.Request(url, method="GET", headers={"User-Agent": "Hexclave-TV-Box-Recovery/1"})
    try:
        # The caller supplies either the fixed production URL or the strictly
        # validated test-image URL resolved above.
        with urllib_request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            response.read(1)
            return 200 <= response.status < 400
    except (TimeoutError, OSError, urllib_error.URLError):
        return False


def _wait_until_reachable(url: str, timeout: int) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if _frontend_reachable(url, min(1, timeout)):
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(0.25, remaining))


def split_nmcli_line(line: str) -> list[str]:
    fields: list[str] = []
    current: list[str] = []
    escaped = False
    for character in line:
        if escaped:
            current.append(character)
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(character)
    if escaped:
        current.append("\\")
    fields.append("".join(current))
    return fields


def validate_wifi_request(request: dict[str, Any]) -> tuple[str, str, str | None, bool, str]:
    ssid = request.get("ssid")
    security = request.get("security")
    password = request.get("password")
    hidden = request.get("hidden", False)
    timezone = request.get("timezone", "UTC")
    if (
        not isinstance(ssid, str)
        or not 1 <= len(ssid.encode("utf-8")) <= 32
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in ssid)
    ):
        raise ValueError("Wi-Fi name must contain between 1 and 32 UTF-8 bytes.")
    if not isinstance(security, str) or security not in {"open", "wpa-personal", "wpa3-personal"}:
        raise ValueError("Only open and WPA2/WPA3 Personal networks are supported.")
    if security == "open":
        if password is not None and password != "":
            raise ValueError("Open Wi-Fi must not include a password.")
        normalized_password = None
    else:
        if (
            not isinstance(password, str)
            or not 8 <= len(password) <= 63
            or not password.isascii()
            or any(ord(character) < 0x20 or ord(character) > 0x7E for character in password)
        ):
            # nmcli's passwd-file is deliberately line based. Limiting the
            # pilot to printable ASCII both follows WPA Personal's passphrase
            # form and prevents a newline from becoming a second property.
            raise ValueError("Personal Wi-Fi passwords must contain 8 to 63 printable ASCII characters.")
        normalized_password = password
    if not isinstance(hidden, bool):
        raise ValueError("Hidden Wi-Fi must be a boolean value.")
    if not isinstance(timezone, str) or timezone.startswith("/") or ".." in timezone:
        raise ValueError("Time zone is invalid.")
    zone_path = Path("/usr/share/zoneinfo") / timezone
    if not zone_path.is_file():
        raise ValueError("Time zone is not installed on this device.")
    return ssid, security, normalized_password, hidden, timezone


class NetworkManagerController:
    def __init__(
        self,
        *,
        state_root: Path = STATE_ROOT,
        runtime_root: Path = RUNTIME_ROOT,
        runner: Callable[[Sequence[str], int], str] = _run,
    ) -> None:
        self.state_root = state_root
        self.runtime_root = runtime_root
        self.runner = runner
        self.setup_ssid: str | None = None
        self.setup_password: str | None = None
        self.cached_networks: list[dict[str, str]] = []
        self._clear_ephemeral_secrets()

    def _clear_ephemeral_secrets(self) -> None:
        secret_root = self.runtime_root / "secrets"
        if secret_root.is_symlink():
            raise RuntimeError("TV Box secret runtime directory must not be a symbolic link.")
        if not secret_root.exists():
            return
        for path in secret_root.iterdir():
            if path.is_dir():
                raise RuntimeError("TV Box secret runtime directory contains an unexpected subdirectory.")
            path.unlink()

    def _nmcli(self, *arguments: str, timeout: int = 45) -> str:
        return self.runner(["nmcli", "--terse", "--escape", "yes", *arguments], timeout)

    def saved_connections(self) -> list[str]:
        output = self._nmcli("--fields", "NAME,TYPE", "connection", "show")
        names: list[str] = []
        for line in output.splitlines():
            fields = split_nmcli_line(line)
            if len(fields) == 2 and fields[0].startswith(SAVED_CONNECTION_PREFIX) and fields[1] in {"802-11-wireless", "wifi"}:
                names.append(fields[0])
        return sorted(names)

    def connected(self) -> bool:
        values = self._nmcli(
            "--get-values", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS",
            "device", "show", WIFI_INTERFACE,
        ).splitlines()
        if len(values) < 2:
            return False
        state, connection, *addresses = values
        return state.startswith("100") and any(address != "" for address in addresses) and connection != SETUP_CONNECTION_NAME

    def activate_saved_connections(self) -> None:
        for name in self.saved_connections():
            try:
                self._nmcli("connection", "up", "id", name, "ifname", WIFI_INTERFACE, timeout=30)
                return
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                continue

    def _delete_connection(self, name: str) -> None:
        try:
            self._nmcli("connection", "delete", "id", name, timeout=15)
        except subprocess.CalledProcessError:
            return

    def _password_file(self, property_name: str, value: str) -> Path:
        secret_root = self.runtime_root / "secrets"
        if secret_root.is_symlink():
            raise RuntimeError("TV Box secret runtime directory must not be a symbolic link.")
        secret_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = secret_root / f"nm-{secrets.token_hex(8)}"
        atomic_write(path, f"{property_name}:{value}\n", 0o600)
        return path

    def start_setup(self) -> None:
        if self.setup_ssid is not None:
            return
        self._delete_connection(SETUP_CONNECTION_NAME)
        # The Zero 2 W has one radio. Scan before switching it into AP mode so
        # a portal refresh cannot tear down the customer's setup connection.
        try:
            self.cached_networks = self._scan_networks()
        except (OSError, subprocess.SubprocessError):
            self.cached_networks = []
            LOGGER.warning("wifi-scan-unavailable")
        suffix_path = self.state_root / "identity" / "hostname"
        suffix = suffix_path.read_text(encoding="utf-8").strip()[-4:].upper()
        setup_ssid = f"Hexclave TV Box-{suffix}"
        setup_password = secrets.token_urlsafe(12)
        try:
            self._nmcli(
                "connection", "add", "type", "wifi", "ifname", WIFI_INTERFACE,
                "con-name", SETUP_CONNECTION_NAME, "ssid", setup_ssid,
            )
            self._nmcli(
                "connection", "modify", "id", SETUP_CONNECTION_NAME,
                "802-11-wireless.mode", "ap",
                "802-11-wireless-security.key-mgmt", "wpa-psk",
                "802-11-wireless-security.proto", "rsn",
                "ipv4.method", "shared", "ipv4.addresses", "10.42.0.1/24",
                "ipv6.method", "disabled", "connection.autoconnect", "no",
            )
            password_file = self._password_file("802-11-wireless-security.psk", setup_password)
            try:
                self._nmcli("connection", "up", "id", SETUP_CONNECTION_NAME, "passwd-file", str(password_file), timeout=30)
            finally:
                password_file.unlink(missing_ok=True)
        except (OSError, subprocess.SubprocessError):
            # Do not publish in-memory setup credentials until NetworkManager
            # has actually activated the AP. A partial attempt must remain
            # retryable on the next policy tick.
            self._delete_connection(SETUP_CONNECTION_NAME)
            self.setup_ssid = None
            self.setup_password = None
            raise
        self.setup_ssid = setup_ssid
        self.setup_password = setup_password

    def stop_setup(self) -> None:
        self._delete_connection(SETUP_CONNECTION_NAME)
        self.setup_ssid = None
        self.setup_password = None

    def _scan_networks(self) -> list[dict[str, str]]:
        output = self._nmcli(
            "--fields", "SSID,SECURITY,SIGNAL", "device", "wifi", "list",
            "ifname", WIFI_INTERFACE, "--rescan", "yes", timeout=30,
        )
        networks: dict[tuple[str, str], dict[str, str]] = {}
        for line in output.splitlines():
            fields = split_nmcli_line(line)
            if len(fields) != 3 or fields[0] == "":
                continue
            security_text = fields[1].upper()
            if "802.1X" in security_text or "ENTERPRISE" in security_text or "WEP" in security_text:
                security = "unsupported"
            elif "SAE" in security_text and "WPA" not in security_text.replace("WPA3", ""):
                security = "wpa3-personal"
            elif security_text in {"", "--"}:
                security = "open"
            else:
                security = "wpa-personal"
            try:
                signal = int(fields[2])
            except ValueError:
                signal = 0
            signal_bucket = "strong" if signal >= 67 else "fair" if signal >= 40 else "weak"
            key = (fields[0], security)
            networks[key] = {"ssid": fields[0], "security": security, "signal": signal_bucket}
        return sorted(networks.values(), key=lambda item: (item["ssid"].casefold(), item["security"]))

    def scan(self) -> list[dict[str, str]]:
        return list(self.cached_networks) if self.setup_ssid is not None else self._scan_networks()

    def connect(self, request: dict[str, Any]) -> None:
        ssid, security, password, hidden, timezone = validate_wifi_request(request)
        name = f"{SAVED_CONNECTION_PREFIX}{uuid.uuid4().hex[:12]}"
        self.stop_setup()
        self._nmcli(
            "connection", "add", "type", "wifi", "ifname", WIFI_INTERFACE,
            "con-name", name, "ssid", ssid,
        )
        try:
            arguments = [
                "connection", "modify", "id", name,
                "802-11-wireless.hidden", "yes" if hidden else "no",
                "ipv4.method", "auto", "ipv6.method", "auto",
                "connection.autoconnect", "yes",
            ]
            if security != "open":
                arguments.extend([
                    "802-11-wireless-security.key-mgmt",
                    "sae" if security == "wpa3-personal" else "wpa-psk",
                ])
            self._nmcli(*arguments)
            if password is None:
                self._nmcli("connection", "up", "id", name, "ifname", WIFI_INTERFACE, timeout=45)
            else:
                password_file = self._password_file("802-11-wireless-security.psk", password)
                try:
                    self._nmcli("connection", "up", "id", name, "ifname", WIFI_INTERFACE, "passwd-file", str(password_file), timeout=45)
                finally:
                    password_file.unlink(missing_ok=True)
            atomic_write(self.state_root / "identity" / "timezone", f"{timezone}\n", 0o644)
        except (OSError, subprocess.SubprocessError):
            self._delete_connection(name)
            raise

    def clear_saved_connections(self) -> None:
        for name in self.saved_connections():
            self._delete_connection(name)


class TvBoxNetworkAgent:
    def __init__(
        self,
        controller: NetworkManagerController,
        *,
        runtime_root: Path = RUNTIME_ROOT,
        policy: NetworkPolicy = NetworkPolicy(),
        service_runner: Callable[[Sequence[str], int], str] = _run,
        frontend_probe: Callable[[str, int], bool] = _frontend_reachable,
        setup_portal_waiter: Callable[[str, int], bool] = _wait_until_reachable,
        monotonic: Callable[[], float] = time.monotonic,
        renderer_url: str = PRODUCTION_URL,
    ) -> None:
        self.controller = controller
        self.runtime_root = runtime_root
        self.policy = policy
        self.service_runner = service_runner
        self.frontend_probe = frontend_probe
        self.setup_portal_waiter = setup_portal_waiter
        self.monotonic = monotonic
        self.renderer_url = renderer_url
        self.lock = threading.RLock()
        self.portal_submission_active = False
        self.has_saved_network = bool(controller.saved_connections())
        self.state = initial_network_state(
            has_saved_network=self.has_saved_network,
            connected=controller.connected(),
            now=monotonic(),
        )
        self.applied_mode: NetworkMode | None = None
        self.frontend_reachable: bool | None = None
        self.next_frontend_probe_at = 0.0

    def _service(self, action: str, name: str) -> None:
        self.service_runner(["systemctl", action, name], 30)

    def _set_kiosk_url(self, url: str) -> None:
        atomic_write(self.runtime_root / "kiosk-url", f"{url}\n", 0o644)

    def apply_mode(self) -> None:
        with self.lock:
            if self.state.mode is self.applied_mode:
                return
            if self.state.mode is NetworkMode.SETUP:
                # Setup credentials must remain available even when WebKit
                # cannot start. The console service owns tty1 in this mode;
                # Cage/Cog is reserved for offline and connected content.
                self._service("stop", "hexclave-tv-box-kiosk.service")
                self.controller.start_setup()
                self._service("start", "hexclave-tv-box-setup-display.service")
                self._service("start", "hexclave-tv-box-setup.service")
                if not self.setup_portal_waiter(SETUP_URL, SETUP_PORTAL_READY_TIMEOUT_SECONDS):
                    raise TimeoutError("TV Box setup portal did not become ready.")
            elif self.state.mode is NetworkMode.CONNECTED:
                self._service("stop", "hexclave-tv-box-setup-display.service")
                self.controller.stop_setup()
                self._service("stop", "hexclave-tv-box-setup.service")
                self._set_kiosk_url(self.renderer_url)
                self._service("restart", "hexclave-tv-box-kiosk.service")
            else:
                self._service("stop", "hexclave-tv-box-setup-display.service")
                self.controller.stop_setup()
                self._service("stop", "hexclave-tv-box-setup.service")
                self._set_kiosk_url(OFFLINE_URL)
                self.controller.activate_saved_connections()
                self._service("restart", "hexclave-tv-box-kiosk.service")
            self.applied_mode = self.state.mode
            LOGGER.info("network-state=%s", self.state.mode.value)

    def tick(self) -> None:
        with self.lock:
            next_state = advance_network_state(
                self.state,
                has_saved_network=self.has_saved_network,
                connected=self.controller.connected(),
                portal_submission_active=self.portal_submission_active,
                now=self.monotonic(),
                policy=self.policy,
            )
            self.state = next_state
        self.apply_mode()
        self._probe_frontend_recovery()

    def _probe_frontend_recovery(self) -> None:
        if self.state.mode is not NetworkMode.CONNECTED:
            self.frontend_reachable = None
            self.next_frontend_probe_at = 0.0
            return
        now = self.monotonic()
        if now < self.next_frontend_probe_at:
            return
        reachable = self.frontend_probe(self.renderer_url, 10)
        recovered = self.frontend_reachable is False and reachable
        self.frontend_reachable = reachable
        self.next_frontend_probe_at = now + FRONTEND_RECOVERY_PROBE_SECONDS
        if recovered:
            # Cog can remain on its engine error page when the application
            # origin was unavailable during a browser restart. The in-page
            # runtime handles API outages once loaded; this restart is only
            # for recovery of the public application document itself.
            self._service("try-restart", "hexclave-tv-box-kiosk.service")
            LOGGER.info("frontend-recovered")

    def handle_request(self, request: dict[str, Any]) -> dict[str, Any]:
        command = request.get("command")
        if not isinstance(command, str):
            raise ValueError("TV Box agent command is required.")
        with self.lock:
            if command == "status":
                return {
                    "mode": self.state.mode.value,
                    "setupSsid": self.controller.setup_ssid,
                    "setupPassword": self.controller.setup_password,
                }
            if command == "scan":
                if self.state.mode is not NetworkMode.SETUP:
                    raise ValueError("Wi-Fi scanning is available only during setup.")
                return {"networks": self.controller.scan()}
            if command == "connect":
                if self.state.mode is not NetworkMode.SETUP:
                    raise ValueError("Wi-Fi can be changed only during setup.")
                self.portal_submission_active = True
                try:
                    self.controller.connect(request)
                    self.has_saved_network = True
                    self.state = initial_network_state(has_saved_network=True, connected=True, now=self.monotonic())
                    self.applied_mode = None
                except (OSError, subprocess.SubprocessError, ValueError):
                    self.state = initial_network_state(has_saved_network=True, connected=False, now=self.monotonic())
                    self.state = NetworkState(NetworkMode.SETUP, self.monotonic())
                    self.applied_mode = None
                    self.controller.start_setup()
                    raise
                finally:
                    self.portal_submission_active = False
                # Let the portal send its success response before the main loop
                # stops that service and switches the kiosk back to /tv-box.
                return {"connected": True}
            if command == "reset-network":
                self.controller.clear_saved_connections()
                self.has_saved_network = False
                self.state = initial_network_state(has_saved_network=False, connected=False, now=self.monotonic())
                self.applied_mode = None
                self.apply_mode()
                return {"reset": True}
        raise ValueError("Unsupported TV Box agent command.")


class AgentRequestHandler(socketserver.StreamRequestHandler):
    def setup(self) -> None:
        super().setup()
        self.request.settimeout(10)

    def handle(self) -> None:
        try:
            raw = self.rfile.readline(MAX_AGENT_REQUEST_BYTES + 1)
            if len(raw) > MAX_AGENT_REQUEST_BYTES:
                response = {"ok": False, "error": "request-too-large"}
            else:
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError("TV Box agent request must be an object.")
                response = {"ok": True, "result": self.server.agent.handle_request(request)}
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError, subprocess.SubprocessError) as error:
            LOGGER.warning("agent-request-failed=%s", type(error).__name__)
            response = {"ok": False, "error": "request-failed"}
        self.wfile.write(json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n")


class AgentServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, path: str, agent: TvBoxNetworkAgent) -> None:
        self.agent = agent
        super().__init__(path, AgentRequestHandler)


def serve(agent: TvBoxNetworkAgent, socket_path: Path, socket_group: str) -> None:
    socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    server = AgentServer(str(socket_path), agent)
    try:
        group_id = grp.getgrnam(socket_group).gr_gid
        os.chown(socket_path, 0, group_id)
        socket_path.chmod(0o660)
        thread = threading.Thread(target=server.serve_forever, name="tv-box-agent-socket", daemon=True)
        thread.start()
        while True:
            try:
                agent.tick()
            except (OSError, subprocess.SubprocessError) as error:
                LOGGER.warning("network-tick-failed=%s", type(error).__name__)
            time.sleep(NETWORK_POLL_SECONDS)
    finally:
        server.shutdown()
        server.server_close()
        socket_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Hexclave TV Box network agent.")
    parser.add_argument("--state-root", type=Path, default=STATE_ROOT)
    parser.add_argument("--runtime-root", type=Path, default=RUNTIME_ROOT)
    parser.add_argument("--socket-group", default="hexclave-tv-portal")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    country = Path("/etc/hexclave-tv-box-country").read_text(encoding="utf-8").strip()
    if len(country) != 2 or not country.isascii() or not country.isupper():
        raise RuntimeError("TV Box Wi-Fi regulatory country is invalid.")
    _run(["iw", "reg", "set", country], 15)
    controller = NetworkManagerController(state_root=arguments.state_root, runtime_root=arguments.runtime_root)
    agent = TvBoxNetworkAgent(
        controller,
        runtime_root=arguments.runtime_root,
        renderer_url=resolve_renderer_url(),
    )
    serve(agent, arguments.runtime_root / "control.sock", arguments.socket_group)


if __name__ == "__main__":
    main()
