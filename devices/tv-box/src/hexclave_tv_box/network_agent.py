"""Root-owned NetworkManager policy agent for the local TV Box appliance."""

from __future__ import annotations

import argparse
import grp
import ipaddress
import json
import logging
import os
import re
import secrets
import select
import socket
import socketserver
import stat
import struct
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
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .policy import ADMIN_CONFIRMATION, FRONTEND_RECOVERY_PROBE_SECONDS, NETWORK_POLL_SECONDS, SETUP_PORTAL_READY_TIMEOUT_SECONDS, NetworkMode, NetworkPolicy, NetworkState, advance_network_state, initial_network_state
from .state import RUNTIME_ROOT, STATE_ROOT, atomic_write, clear_exact_state_directory

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
MAX_AGENT_CONNECTIONS = 8
AGENT_LOCK_WAIT_SECONDS = 5
MAX_KIOSK_HEALTH_BYTES = 256
SAVED_PROFILE_RETRY_INTERVAL_S = 30
TEST_SETUP_PASSWORD_LENGTH = 8
TEST_SETUP_PASSWORD_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _failure_code(error: BaseException) -> str:
    """Describe a command failure without its argv, output, or Wi-Fi secrets."""
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        return "timeout"
    if isinstance(error, subprocess.CalledProcessError):
        return f"exit-{error.returncode}"
    if isinstance(error, OSError):
        return f"os-error-{error.errno}" if error.errno is not None else "os-error"
    if isinstance(error, ValueError):
        return "invalid-request"
    return "unexpected-error"


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
    except (OSError, ValueError) as error:
        # A typo on removable media must never broaden trust or put an appliance
        # into a reboot loop. Reject the override and retain the production URL.
        LOGGER.error("test-renderer-origin-rejected=%s", error)
        return PRODUCTION_URL
    return f"{origin}/tv-box"


def _generate_setup_password(*, test_image: bool) -> str:
    if test_image:
        # WPA Personal requires at least eight characters. Test appliances use
        # the minimum length from an ambiguity-free alphabet because this
        # temporary credential must often be entered manually during repeated
        # image qualification. Production retains the higher-entropy value.
        return "".join(
            secrets.choice(TEST_SETUP_PASSWORD_ALPHABET)
            for _ in range(TEST_SETUP_PASSWORD_LENGTH)
        )
    return secrets.token_urlsafe(12)


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
        class NoRedirectHandler(urllib_request.HTTPRedirectHandler):
            def redirect_request(self, _request, _response, _code, _msg, _headers, _newurl):
                return None

        # The caller supplies the fixed local setup URL or a validated
        # public document URL, never credentials or a customer-selected URL.
        opener = urllib_request.build_opener(NoRedirectHandler)
        with opener.open(request, timeout=timeout) as response:  # noqa: S310
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


def _usable_station_address(value: str) -> bool:
    # --get-values returns one address per line, but --escape yes still
    # escapes IPv6 colons. Decode before classifying the full IPv6 fe80::/10
    # and IPv4 link-local ranges instead of matching a textual prefix.
    try:
        address = ipaddress.ip_interface(":".join(split_nmcli_line(value))).ip
    except ValueError:
        return False
    return not (address.is_link_local or address.is_loopback or address.is_unspecified or address.is_multicast)


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
    try:
        # zoneinfo also contains metadata files (for example zone.tab).
        # Existence alone does not establish that Cog can use this timezone.
        # This reads installed TZif data; it never changes the OS timezone.
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError("Time zone is not usable on this device.") from error
    return ssid, security, normalized_password, hidden, timezone


class NetworkManagerController:
    def __init__(
        self,
        *,
        state_root: Path = STATE_ROOT,
        runtime_root: Path = RUNTIME_ROOT,
        test_image_marker: Path = TEST_IMAGE_MARKER,
        runner: Callable[[Sequence[str], int], str] = _run,
    ) -> None:
        self.state_root = state_root
        self.runtime_root = runtime_root
        self.test_image_marker = test_image_marker
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
            "--get-values", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP6.ADDRESS",
            "device", "show", WIFI_INTERFACE,
        ).splitlines()
        if len(values) < 2:
            return False
        state, connection, *addresses = values
        return (
            state.startswith("100")
            and any(_usable_station_address(address) for address in addresses)
            and connection != SETUP_CONNECTION_NAME
        )

    def activate_saved_connections(self) -> None:
        for attempt, name in enumerate(self.saved_connections(), start=1):
            try:
                self._nmcli("connection", "up", "id", name, "ifname", WIFI_INTERFACE, timeout=30)
                LOGGER.info("saved-network-profile-attempt=%d outcome=connected", attempt)
                return
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                LOGGER.warning("saved-network-profile-attempt=%d outcome=failed reason=%s", attempt, _failure_code(error))
                continue

    def setup_active(self) -> bool:
        values = self._nmcli(
            "--get-values", "GENERAL.STATE,GENERAL.CONNECTION", "device", "show", WIFI_INTERFACE,
        ).splitlines()
        return len(values) == 2 and values[0].startswith("100") and values[1] == SETUP_CONNECTION_NAME

    def _delete_connection(self, name: str) -> None:
        # Check absence explicitly; a permission, storage or D-Bus failure
        # must not be mistaken for successful removal of a saved credential.
        names = self._nmcli("--get-values", "NAME", "connection", "show").splitlines()
        if name in [split_nmcli_line(value)[0] for value in names]:
            self._nmcli("connection", "delete", "id", name, timeout=15)

    def _password_file(self, property_name: str, value: str) -> Path:
        secret_root = self.runtime_root / "secrets"
        if secret_root.is_symlink():
            raise RuntimeError("TV Box secret runtime directory must not be a symbolic link.")
        secret_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = secret_root / f"nm-{secrets.token_hex(8)}"
        atomic_write(path, f"{property_name}:{value}\n", 0o600)
        return path

    def start_setup(self) -> None:
        if self.setup_ssid is not None and self.setup_active():
            return
        self.setup_ssid = None
        self.setup_password = None
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
        setup_password = _generate_setup_password(test_image=self.test_image_marker.is_file())
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
        names = self.saved_connections()
        if names:
            # nmcli accepts multiple exact profile IDs in one operation. A
            # reset's deletion budget must not grow by one timeout per saved
            # network, and unrelated NetworkManager profiles remain untouched.
            self._nmcli("connection", "delete", "id", *names, timeout=30)


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
        self.maintenance_active = False
        self.has_saved_network = bool(controller.saved_connections())
        self.state = initial_network_state(
            has_saved_network=self.has_saved_network,
            connected=controller.connected(),
            now=monotonic(),
        )
        self.applied_mode: NetworkMode | None = None
        self.frontend_reachable: bool | None = None
        self.next_frontend_probe_at = 0.0
        self.last_applied_at = self.monotonic()
        self.outage_started_at: float | None = None if self.state.mode is NetworkMode.CONNECTED else self.last_applied_at
        self.frontend_outage_started_at: float | None = None
        self.saved_network_attempts = 0
        self._last_saved_activation: float | None = None
        self.pending_transition_reason: str | None = None

    def _service(self, action: str, name: str) -> None:
        self.service_runner(["systemctl", action, name], 30)

    def _service_properties(self, name: str) -> dict[str, str]:
        output = self.service_runner([
            "systemctl", "show", "--property=ActiveState,SubState,Result", name,
        ], 10)
        properties = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        if set(properties) != {"ActiveState", "SubState", "Result"}:
            raise ValueError("TV Box service state is incomplete.")
        return properties

    def _ensure_service(self, name: str, *, running: bool) -> None:
        properties = self._service_properties(name)
        state = properties["ActiveState"]
        if state in {"activating", "deactivating", "reloading", "refreshing"}:
            return
        if state == "failed" or properties["Result"] == "start-limit-hit":
            # systemd owns crash recovery and its exhausted failure budget.
            # Reissuing start every policy tick would defeat bounded recovery,
            # particularly the deliberately stopped test-image failure state.
            return
        if state not in {"active", "inactive"}:
            raise ValueError("TV Box service state is unsupported.")
        active = state == "active"
        if active != running:
            self._service("start" if running else "stop", name)

    def _reconcile_services(self) -> None:
        setup = self.state.mode is NetworkMode.SETUP
        # Stop the opposite tty owner first, even if it was started outside
        # this process. systemd's active state is not implied by policy state.
        self._ensure_service(
            "hexclave-tv-box-kiosk.service" if setup else "hexclave-tv-box-setup-display.service",
            running=False,
        )
        if setup:
            self.controller.start_setup()
            self._ensure_service("hexclave-tv-box-setup-display.service", running=True)
            self._ensure_service("hexclave-tv-box-setup.service", running=True)
        else:
            self._ensure_service("hexclave-tv-box-setup.service", running=False)
            self._ensure_service("hexclave-tv-box-kiosk.service", running=True)

    def _set_kiosk_url(self, url: str) -> None:
        atomic_write(self.runtime_root / "kiosk-url", f"{url}\n", 0o644)

    def _kiosk_url_for_mode(self, mode: NetworkMode) -> str:
        return self.renderer_url if mode is NetworkMode.CONNECTED else OFFLINE_URL

    def _restart_kiosk(self, *, reset_healthy_budget: bool = True) -> None:
        if reset_healthy_budget and self._kiosk_health_state() is not None:
            properties = self._service_properties("hexclave-tv-box-kiosk.service")
            if properties["ActiveState"] == "active" and properties["Result"] != "start-limit-hit":
                # systemd counts intentional starts as well as crashes. A
                # validated live renderer changing network content or retrying
                # only its document must not spend the hardware-failure budget.
                # Failed/inactive units and ordinary service reconciliation do
                # not enter this exception to the crash policy.
                self._service("reset-failed", "hexclave-tv-box-kiosk.service")
        # Cog 0.18.x can make Cage slow to close. Separate bounded operations
        # prevent one combined systemctl restart job from consuming the agent
        # request timeout after systemd has already performed the SIGKILL
        # fallback and started a usable replacement process.
        self._service("stop", "hexclave-tv-box-kiosk.service")
        self._service("start", "hexclave-tv-box-kiosk.service")

    def _kiosk_health_state(self) -> str | None:
        # This renderer-owned file is only a bounded readiness signal, not a
        # source of diagnostic text or authority to choose an action/path.
        # Missing/stale-format signals leave recovery to the native supervisor.
        path = self.controller.state_root / "browser" / "kiosk-health"
        descriptor = None
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_KIOSK_HEALTH_BYTES:
                return None
            value = os.read(descriptor, MAX_KIOSK_HEALTH_BYTES + 1)
        except OSError:
            return None
        finally:
            if descriptor is not None:
                os.close(descriptor)
        for state in ("ready", "document-loading", "document-failed", "document-timeout"):
            if value == f"{state} cage=ready,cog=ready,web-process=ready\n".encode("ascii"):
                return state
        return None

    def _document_recovery_requested(self) -> bool:
        return self._kiosk_health_state() in {"document-failed", "document-timeout"}

    def apply_mode(self) -> None:
        with self.lock:
            if self.maintenance_active:
                return
            if self.state.mode is self.applied_mode:
                if (
                    self.state.mode in {NetworkMode.STATION_INITIAL, NetworkMode.STATION_RETRY}
                    and self.has_saved_network
                    and not self.controller.connected()
                    and (
                        self._last_saved_activation is None
                        or self.monotonic() - self._last_saved_activation >= SAVED_PROFILE_RETRY_INTERVAL_S
                    )
                ):
                    try:
                        self.controller.activate_saved_connections()
                    finally:
                        self._last_saved_activation = self.monotonic()
                self._reconcile_services()
                return
            previous_mode = self.applied_mode
            reason = self.pending_transition_reason
            if self.state.mode in {NetworkMode.STATION_INITIAL, NetworkMode.STATION_RETRY}:
                # NetworkManager's explicit activation is synchronous. Recheck
                # immediately so a normal saved-network boot launches the live
                # renderer once instead of launching the offline renderer and
                # tearing the complete Cage/Cog stack down five seconds later.
                self.saved_network_attempts += 1
                LOGGER.info("saved-network-attempt=%d mode=%s", self.saved_network_attempts, self.state.mode.value)
                try:
                    self.controller.activate_saved_connections()
                finally:
                    self._last_saved_activation = self.monotonic()
                if self.controller.connected():
                    self.state = NetworkState(NetworkMode.CONNECTED, self.monotonic())
                    reason = "saved-network-connected"
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
                self._set_kiosk_url(self._kiosk_url_for_mode(self.state.mode))
                self._restart_kiosk()
            else:
                self._service("stop", "hexclave-tv-box-setup-display.service")
                self.controller.stop_setup()
                self._service("stop", "hexclave-tv-box-setup.service")
                self._set_kiosk_url(self._kiosk_url_for_mode(self.state.mode))
                self._restart_kiosk()
            now = self.monotonic()
            if reason is None:
                if previous_mode is None:
                    reason = "boot"
                elif self.state.mode is NetworkMode.CONNECTED:
                    reason = "wifi-restored"
                elif previous_mode is NetworkMode.CONNECTED:
                    reason = "wifi-lost"
                elif self.state.mode is NetworkMode.SETUP:
                    reason = "saved-network-window-exhausted"
                else:
                    reason = "setup-window-exhausted"
            LOGGER.info(
                "network-state=%s previous=%s reason=%s previous-duration-seconds=%.1f",
                self.state.mode.value, previous_mode.value if previous_mode is not None else "none",
                reason, max(0.0, now - self.last_applied_at),
            )
            if self.state.mode is NetworkMode.CONNECTED:
                if self.outage_started_at is not None:
                    LOGGER.info("wifi-recovery-complete outage-seconds=%.1f saved-network-attempts=%d", max(0.0, now - self.outage_started_at), self.saved_network_attempts)
                self.outage_started_at = None
                self.saved_network_attempts = 0
            elif self.outage_started_at is None:
                self.outage_started_at = now
            self.applied_mode = self.state.mode
            self.last_applied_at = now
            self.pending_transition_reason = None

    def tick(self) -> None:
        with self.lock:
            if self.maintenance_active:
                return
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
            self.frontend_outage_started_at = None
            self.next_frontend_probe_at = 0.0
            return
        now = self.monotonic()
        if now < self.next_frontend_probe_at:
            return
        reachable = self.frontend_probe(self.renderer_url, 10)
        if reachable != self.frontend_reachable:
            if reachable:
                outage_seconds = 0.0 if self.frontend_outage_started_at is None else max(0.0, now - self.frontend_outage_started_at)
                LOGGER.info("frontend-probe=reachable observed-outage-seconds=%.1f", outage_seconds)
                self.frontend_outage_started_at = None
            else:
                LOGGER.warning("frontend-probe=unreachable reason=transport-or-http-failure")
                self.frontend_outage_started_at = now
        recovered = self.frontend_reachable is False and reachable
        if recovered and self._document_recovery_requested():
            # This is a fast path for observed origin outages. The kiosk
            # supervisor independently retries native document-load failures,
            # including outages this periodic probe never observed. A healthy
            # loaded app must not consume its crash budget when only the public
            # endpoint flaps; require the current renderer's failure signal.
            properties = self._service_properties("hexclave-tv-box-kiosk.service")
            if properties["ActiveState"] == "active" and properties["Result"] != "start-limit-hit":
                self._restart_kiosk()
                LOGGER.info("frontend-recovered")
        # Keep failed restarts retryable instead of consuming the recovery
        # edge before the renderer has actually been started successfully.
        self.frontend_reachable = reachable
        self.next_frontend_probe_at = now + FRONTEND_RECOVERY_PROBE_SECONDS

    def handle_request(self, request: dict[str, Any], *, privileged: bool = False) -> dict[str, Any]:
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
            if self.maintenance_active:
                raise ValueError("TV Box maintenance is already in progress.")
            if command in {"restart-kiosk", "reset-pairing", "reset-network", "prepare-factory-reset"}:
                if not privileged:
                    raise PermissionError("TV Box support commands require a root peer.")
                if command in {"reset-pairing", "prepare-factory-reset"} and request.get("confirmation") != ADMIN_CONFIRMATION:
                    raise ValueError("TV Box reset requires dashboard admin-unpair confirmation.")
            if command == "restart-kiosk":
                LOGGER.info("support-request=restart-kiosk network-mode=%s", self.state.mode.value)
                # Only an explicit root support operation resets a consumed
                # systemd failure budget; periodic reconciliation never does.
                if self.state.mode is NetworkMode.SETUP:
                    self._service("reset-failed", "hexclave-tv-box-setup-display.service")
                    self._service("reset-failed", "hexclave-tv-box-setup.service")
                    self._reconcile_services()
                else:
                    self._service("reset-failed", "hexclave-tv-box-kiosk.service")
                    self._set_kiosk_url(self._kiosk_url_for_mode(self.state.mode))
                    self._restart_kiosk(reset_healthy_budget=False)
                return {"restarted": True}
            if command == "reset-pairing":
                self._service("stop", "hexclave-tv-box-kiosk.service")
                clear_exact_state_directory(self.controller.state_root, "browser")
                self.service_runner(["chown", "hexclave-tv:hexclave-tv", str(self.controller.state_root / "browser")], 10)
                # The reset and subsequent tty-owner reconciliation are one
                # locked operation: no probe/policy tick can reopen the store
                # while its contents are being removed.
                self._reconcile_services()
                return {"reset": True}
            if command == "prepare-factory-reset":
                self.controller.clear_saved_connections()
                self.controller.stop_setup()
                for service in (
                    "hexclave-tv-box-kiosk.service", "hexclave-tv-box-setup-display.service", "hexclave-tv-box-setup.service",
                ):
                    self._service("stop", service)
                self.maintenance_active = True
                return {"prepared": True}
            if command == "scan":
                if self.state.mode is not NetworkMode.SETUP:
                    raise ValueError("Wi-Fi scanning is available only during setup.")
                return {"networks": self.controller.scan()}
            if command == "connect":
                if self.state.mode is not NetworkMode.SETUP:
                    raise ValueError("Wi-Fi can be changed only during setup.")
                self.portal_submission_active = True
                started_at = self.monotonic()
                LOGGER.info("wifi-submission=started")
                try:
                    self.controller.connect(request)
                    self.has_saved_network = True
                    self.state = initial_network_state(has_saved_network=True, connected=True, now=self.monotonic())
                    self.applied_mode = None
                    self.pending_transition_reason = "wifi-submission-complete"
                    LOGGER.info("wifi-submission=complete duration-seconds=%.1f", max(0.0, self.monotonic() - started_at))
                except (OSError, subprocess.SubprocessError, ValueError) as error:
                    LOGGER.warning("wifi-submission=failed reason=%s duration-seconds=%.1f", _failure_code(error), max(0.0, self.monotonic() - started_at))
                    self.state = NetworkState(NetworkMode.SETUP, self.monotonic())
                    self.applied_mode = None
                    self.pending_transition_reason = "wifi-submission-failed"
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
                self.pending_transition_reason = "support-network-reset"
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
                credentials = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                _pid, user_id, _group_id = struct.unpack("3i", credentials)
                response = {"ok": True, "result": self.server.dispatch_request(
                    request, privileged=user_id == 0, connection=self.request,
                )}
        except ConnectionAbortedError:
            LOGGER.info("agent-request-abandoned")
            return
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError, subprocess.SubprocessError) as error:
            LOGGER.warning("agent-request-failed=%s", _failure_code(error))
            response = {"ok": False, "error": "request-failed"}
        try:
            self.wfile.write(json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n")
        except OSError as error:
            # An admitted mutation keeps its existing cleanup budget even if
            # the portal loses Wi-Fi; a failed reply is not a failed rollback.
            LOGGER.warning("agent-response-failed=%s", _failure_code(error))


class AgentServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, path: str, agent: TvBoxNetworkAgent) -> None:
        self.agent = agent
        self.lock_wait_seconds: float = AGENT_LOCK_WAIT_SECONDS
        self._connection_limit = threading.BoundedSemaphore(MAX_AGENT_CONNECTIONS)
        super().__init__(path, AgentRequestHandler)

    def process_request(self, request: socket.socket, client_address: str) -> None:
        if not self._connection_limit.acquire(blocking=False):
            try:
                # Do not block the accept loop while rejecting an overloaded
                # client. The fixed error contains no request or device data.
                request.setblocking(False)
                request.sendall(b'{"ok":false,"error":"agent-busy"}\n')
            except OSError as error:
                LOGGER.warning("agent-overload-response-failed=%s", _failure_code(error))
            finally:
                self.shutdown_request(request)
            return
        started = False
        try:
            super().process_request(request, client_address)
            started = True
        finally:
            if not started:
                self._connection_limit.release()

    def process_request_thread(self, request: socket.socket, client_address: str) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_limit.release()

    def dispatch_request(
        self,
        request: dict[str, Any],
        *,
        privileged: bool,
        connection: socket.socket,
    ) -> dict[str, Any]:
        poller = select.poll()
        # POLLHUP detects a fully closed peer without rejecting clients that
        # only finish writing and keep their read half open for the response.
        poller.register(connection, select.POLLHUP | select.POLLERR | select.POLLNVAL)
        if poller.poll(0):
            raise ConnectionAbortedError("TV Box request client disconnected before admission.")
        deadline = time.monotonic() + self.lock_wait_seconds
        if not self.agent.lock.acquire(timeout=self.lock_wait_seconds):
            raise TimeoutError("TV Box request expired waiting to start.")
        try:
            if time.monotonic() >= deadline:
                raise TimeoutError("TV Box request expired waiting to start.")
            if poller.poll(0):
                raise ConnectionAbortedError("TV Box request client disconnected while waiting.")
            # Admission and execution share the existing RLock, so a policy
            # tick cannot interleave here. Only waiting work expires; once a
            # mutation starts, its normal bounded cleanup must finish safely.
            return self.agent.handle_request(request, privileged=privileged)
        finally:
            self.agent.lock.release()


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
        last_failure: str | None = None
        next_failure_log_at = 0.0
        suppressed_failures = 0
        while True:
            try:
                agent.tick()
                if last_failure is not None:
                    LOGGER.info("network-tick-recovered previous-reason=%s suppressed-failures=%d", last_failure, suppressed_failures)
                    last_failure = None
                    suppressed_failures = 0
            except (OSError, subprocess.SubprocessError) as error:
                reason = _failure_code(error)
                now = time.monotonic()
                if reason != last_failure or now >= next_failure_log_at:
                    LOGGER.warning("network-tick-failed=%s suppressed-failures=%d", reason, suppressed_failures)
                    next_failure_log_at = now + 60
                    suppressed_failures = 0
                else:
                    suppressed_failures += 1
                last_failure = reason
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
    renderer_url = resolve_renderer_url()
    # The selected URL is a public document location, not a credential. One
    # startup log makes test-image override failures diagnosable without
    # exposing a shell or recording browser/session state.
    LOGGER.info("effective-renderer-url=%s", renderer_url)
    agent = TvBoxNetworkAgent(
        controller,
        runtime_root=arguments.runtime_root,
        renderer_url=renderer_url,
    )
    serve(agent, arguments.runtime_root / "control.sock", arguments.socket_group)


if __name__ == "__main__":
    main()
