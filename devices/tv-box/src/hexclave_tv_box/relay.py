"""Opt-in reverse SSH transport; the existing certificate command boundary remains authoritative."""

from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import grp
import json
import logging
import os
import re
import secrets
import stat
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .state import STATE_ROOT, atomic_write, require_exact_child

RELAY_USER = "hexclave-tv-relay"
MAX_FILE_BYTES = 4096
LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class RelayConfig:
    host: str
    port: int
    user: str
    listen_port: int
    host_key: str


def _public_key(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", value):
        raise ValueError("Relay host/public key must be one Ed25519 public key without options or comments.")
    try:
        decoded = base64.b64decode(value.split(" ")[1], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("Relay public key encoding is invalid.") from error
    if len(decoded) != 51 or decoded[:19] != b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20":
        raise ValueError("Relay public key structure is invalid.")
    return value


def parse_config(value: object) -> RelayConfig:
    fields = {"version", "host", "port", "user", "listen_port", "host_key"}
    if not isinstance(value, dict) or set(value) != fields or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Relay enrollment must use the exact version 1 schema.")
    host = value["host"]
    # No SSH user/port syntax, wildcard trust, option prefix, URL, or IPv6
    # delimiters is accepted in this field. IPv4 and DNS labels are sufficient
    # for the pilot; adding new address forms requires explicit validation.
    if not isinstance(host, str) or len(host) > 253 or not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*", host,
    ):
        raise ValueError("Relay hostname is invalid.")
    user = value["user"]
    if not isinstance(user, str) or not re.fullmatch(r"tvbox-[a-z0-9]{8,26}", user):
        raise ValueError("Relay account must be an exact per-device tvbox account.")
    port, listen_port = value["port"], value["listen_port"]
    if type(port) is not int or not 1 <= port <= 65535 or type(listen_port) is not int or not 1024 <= listen_port <= 65535:
        raise ValueError("Relay port is invalid.")
    return RelayConfig(host, port, user, listen_port, _public_key(value["host_key"]))


def _secure_directory(path: Path) -> None:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) not in {0o700, 0o750}:
        raise ValueError("Relay state directory must be a root-owned private directory, never a link.")


def _assert_safe_state_root(state_root: Path) -> None:
    # Check every existing ancestor too: O_NOFOLLOW only protects the final
    # file component, not a directory redirected by an untrusted account.
    for ancestor in (state_root, *state_root.parents):
        metadata = ancestor.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o022:
            # Root's sticky /tmp is safe for isolated tests/manufacturing
            # directories; no other group/world-writable ancestor is allowed.
            if not (stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_mode & stat.S_ISVTX):
                raise ValueError("Relay state has an unsafe ancestor.")


def _relay_root(state_root: Path) -> Path:
    _assert_safe_state_root(state_root)
    result = require_exact_child(state_root / "relay", state_root, "relay")
    _secure_directory(result)
    return result


def _read_private_file(path: Path) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) not in {0o600, 0o640}:
            raise ValueError("Relay file must be a root-owned private regular file.")
        value = os.read(descriptor, MAX_FILE_BYTES + 1)
        if len(value) > MAX_FILE_BYTES:
            raise ValueError("Relay file exceeds its bounded size.")
        return value.decode("utf-8")
    finally:
        os.close(descriptor)


def known_hosts_entry(config: RelayConfig) -> str:
    hostname = config.host if config.port == 22 else f"[{config.host}]:{config.port}"
    return f"{hostname} {config.host_key}\n"


def load_config(state_root: Path = STATE_ROOT) -> RelayConfig | None:
    # Missing enrollment is disabled, but missing files in an existing
    # enrollment are corruption and must not be reported as an unenrolled box.
    _assert_safe_state_root(state_root)
    try:
        (state_root / "relay").lstat()
    except FileNotFoundError:
        return None
    directory = _relay_root(state_root)
    try:
        contents = _read_private_file(directory / "enrollment.json")
    except FileNotFoundError:
        return None
    config = parse_config(json.loads(contents))
    if _read_private_file(directory / "known_hosts") != known_hosts_entry(config):
        raise ValueError("Relay host-key pin does not match the approved enrollment.")
    # Validate metadata without ever printing or returning the private key.
    private_key = _read_private_file(directory / "id_ed25519")
    if not private_key.startswith("-----BEGIN OPENSSH PRIVATE KEY-----\n"):
        raise ValueError("Relay private key is invalid.")
    return config


def initialize_relay_identity(state_root: Path = STATE_ROOT, *, group_id: int | None = None) -> None:
    """Generate only on the individual box, never during golden-image creation."""
    if os.geteuid() != 0:
        raise PermissionError("Relay identity initialization requires root.")
    _assert_safe_state_root(state_root)
    directory = require_exact_child(state_root / "relay", state_root, "relay")
    directory.mkdir(mode=0o750, exist_ok=True)
    _secure_directory(directory)
    relay_group = grp.getgrnam(RELAY_USER).gr_gid if group_id is None else group_id
    os.chown(directory, 0, relay_group)
    directory.chmod(0o750)
    _relay_root(state_root)
    private_key = directory / "id_ed25519"
    public_key = directory / "id_ed25519.pub"
    private_exists = private_key.exists() or private_key.is_symlink()
    public_exists = public_key.exists() or public_key.is_symlink()
    if private_exists != public_exists:
        raise ValueError("Partial relay identity requires explicit recovery.")
    if private_exists:
        # Validate correspondence, not just two plausible files. The root
        # initializer feeds a private pipe so OpenSSH never sees a group-
        # readable file owned by its current UID; the relay UID reads the
        # root-owned 0640 file directly during normal operation.
        private_contents = _read_private_file(private_key)
        expected_public = _public_key(_read_private_file(public_key).strip())
        result = subprocess.run(
            ["/usr/bin/ssh-keygen", "-y", "-P", "", "-f", "/dev/stdin"],
            input=private_contents, check=True, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, timeout=15,
        )
        if _public_key(result.stdout.strip()) != expected_public:
            raise ValueError("Relay key pair does not match; explicit recovery is required.")
        return
    temporary = directory / f".identity-{secrets.token_hex(8)}"
    temporary_public = temporary.with_suffix(".pub")
    try:
        subprocess.run(
            ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", str(temporary)],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
        )
        # Root owns the files and directory, so the unprivileged transport
        # can read its one credential but cannot replace enrollment or trust.
        for path in (temporary, temporary_public):
            os.chown(path, 0, relay_group)
            path.chmod(0o640)
        _public_key(_read_private_file(temporary_public).strip())
        os.replace(temporary_public, public_key)
        os.replace(temporary, private_key)
        for path in (private_key, public_key, directory):
            descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)
        temporary_public.unlink(missing_ok=True)


def install_enrollment(source: Path, state_root: Path = STATE_ROOT) -> None:
    """Root-only, one-time provisioning from an already authenticated local file."""
    if os.geteuid() != 0:
        raise PermissionError("Relay enrollment requires root.")
    directory = _relay_root(state_root)
    with _enrollment_lock(directory):
        _install_enrollment_locked(source, directory)


@contextmanager
def _enrollment_lock(directory: Path) -> Iterator[None]:
    descriptor = os.open(directory / ".enrollment.lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600:
            raise ValueError("Relay enrollment lock is not a private root-owned file.")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another relay enrollment is already in progress.") from error
        try:
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def _install_enrollment_locked(source: Path, directory: Path) -> None:
    target = directory / "enrollment.json"
    if target.exists() or target.is_symlink():
        raise ValueError("Relay is already enrolled; revoke the old registration before resetting it.")
    config = parse_config(json.loads(_read_private_file(source)))
    _read_private_file(directory / "id_ed25519")
    _public_key(_read_private_file(directory / "id_ed25519.pub").strip())
    group_id = directory.stat().st_gid
    # enrollment.json is the activation marker and must be published last.
    # The parent directory is root-writable only, and neither write follows a
    # child symlink. A stopped relay service is required during provisioning.
    for path, contents in (
        (directory / "known_hosts", known_hosts_entry(config)),
        (target, json.dumps({"version": 1, **config.__dict__}, sort_keys=True) + "\n"),
    ):
        atomic_write(path, contents, 0o640)
        os.chown(path, 0, group_id)


def ssh_command(config: RelayConfig, state_root: Path = STATE_ROOT) -> list[str]:
    directory = state_root / "relay"
    return [
        "/usr/bin/ssh", "-F", "/dev/null", "-N", "-T", "-q",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={directory / 'known_hosts'}",
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no", "-o", "VerifyHostKeyDNS=no",
        "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no", "-o", "GSSAPIAuthentication=no",
        "-o", "PreferredAuthentications=publickey", "-o", "ExitOnForwardFailure=yes",
        "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
        "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "PermitLocalCommand=no",
        "-o", "EscapeChar=none", "-i", str(directory / "id_ed25519"), "-p", str(config.port),
        "-R", f"127.0.0.1:{config.listen_port}:127.0.0.1:22", f"{config.user}@{config.host}",
    ]


def relay_enrollment_public_key(state_root: Path = STATE_ROOT) -> str:
    try:
        directory = _relay_root(state_root)
        return _public_key(_read_private_file(directory / "id_ed25519.pub").strip())
    except FileNotFoundError:
        return "missing"
    except (ValueError, UnicodeError):
        return "invalid"
    except OSError:
        return "unavailable"


def relay_diagnostics(state_root: Path = STATE_ROOT) -> list[str]:
    """Describe configuration only; systemd process state is not tunnel readiness."""
    try:
        config = load_config(state_root)
    except (OSError, ValueError, UnicodeError):
        return ["support-relay=invalid-config"]
    return ["support-relay=disabled" if config is None else "support-relay=configured"]


def start_transport(state_root: Path = STATE_ROOT) -> None:
    """Validate once, then replace Python; systemd owns every subsequent retry."""
    try:
        config = load_config(state_root)
    except (OSError, ValueError, UnicodeError):
        LOG.error("relay-state=invalid-config")
        raise SystemExit(78) from None
    if config is None:
        # Normally systemd skips an unenrolled unit before invoking Python.
        # Exit 78 also prevents Restart=always from looping if it is removed
        # between that condition check and this guarded read.
        LOG.info("relay-state=disabled")
        raise SystemExit(78)
    try:
        os.execve("/usr/bin/ssh", ssh_command(config, state_root), {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
    except OSError:
        LOG.error("relay-state=launch-failed")
        raise SystemExit(78) from None


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the explicitly enrolled TV Box support transport.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--enroll", type=Path, help="Root-only approved local enrollment JSON; never a network URL.")
    mode.add_argument("--initialize", action="store_true", help="Create this physical unit's relay identity without enabling transport.")
    parser.add_argument("--state-root", type=Path, default=STATE_ROOT, help="Initialized per-device state mount for offline enrollment only.")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if arguments.enroll is not None:
        install_enrollment(arguments.enroll, arguments.state_root)
        print("Relay enrollment installed. Start hexclave-tv-box-relay.service after relay-side registration.")
        return
    if arguments.state_root != STATE_ROOT:
        parser.error("--state-root is only supported with explicit offline --enroll.")
    if arguments.initialize:
        initialize_relay_identity()
        LOG.info("relay-identity=ready")
        return
    start_transport()


if __name__ == "__main__":
    main()
