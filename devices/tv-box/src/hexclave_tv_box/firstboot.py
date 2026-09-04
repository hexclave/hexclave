"""Idempotent creation of unique local appliance identity."""

from __future__ import annotations

import argparse
import grp
import os
import pwd
import secrets
import subprocess
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path

from .state import STATE_ROOT, atomic_write

CommandRunner = Callable[[Sequence[str]], None]


def run_command(command: Sequence[str]) -> None:
    subprocess.run(command, check=True, stdin=subprocess.DEVNULL)  # noqa: S603


def _create_host_key(path: Path, key_type: str, runner: CommandRunner) -> None:
    if path.exists():
        if not path.with_suffix(f"{path.suffix}.pub").exists():
            raise RuntimeError(f"TV Box SSH host key is incomplete: {path}")
        return
    temporary_path = path.with_name(f".{path.name}.{secrets.token_hex(6)}")
    try:
        command = ["ssh-keygen", "-q", "-t", key_type, "-N", "", "-f", str(temporary_path)]
        if key_type == "rsa":
            command[4:4] = ["-b", "3072"]
        runner(command)
        # Publish the public half first. If power is lost between the two
        # renames, the missing private key causes a clean regeneration; the
        # reverse order could leave an unusable private-only identity.
        os.replace(temporary_path.with_suffix(f"{temporary_path.suffix}.pub"), path.with_suffix(f"{path.suffix}.pub"))
        os.replace(temporary_path, path)
        path.chmod(0o600)
        path.with_suffix(f"{path.suffix}.pub").chmod(0o644)
    finally:
        temporary_path.unlink(missing_ok=True)
        temporary_path.with_suffix(f"{temporary_path.suffix}.pub").unlink(missing_ok=True)


def _validate_machine_id(machine_id: str) -> str:
    if len(machine_id) != 32 or any(character not in "0123456789abcdef" for character in machine_id):
        raise RuntimeError("TV Box machine ID is invalid.")
    return machine_id


def initialize_device(
    state_root: Path = STATE_ROOT,
    runner: CommandRunner = run_command,
    system_machine_id: str | None = None,
) -> dict[str, str]:
    state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_root.chmod(0o700)
    for name in ("browser", "identity", "journal", "network-connections", "ssh"):
        directory = state_root / name
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)

    identity_root = state_root / "identity"
    device_id_path = identity_root / "device-id"
    if device_id_path.exists():
        device_id = device_id_path.read_text(encoding="utf-8").strip()
        uuid.UUID(device_id)
    else:
        device_id = str(uuid.uuid4())
        atomic_write(device_id_path, f"{device_id}\n")

    machine_id_path = identity_root / "machine-id"
    if machine_id_path.exists():
        machine_id = _validate_machine_id(machine_id_path.read_text(encoding="utf-8").strip())
        if system_machine_id is not None and machine_id != _validate_machine_id(system_machine_id):
            raise RuntimeError("TV Box persistent and system machine IDs do not match.")
    else:
        machine_id = _validate_machine_id(system_machine_id) if system_machine_id is not None else secrets.token_hex(16)
        atomic_write(machine_id_path, f"{machine_id}\n")

    hostname = f"hexclave-tv-{device_id.replace('-', '')[-6:]}"
    hostname_path = identity_root / "hostname"
    if hostname_path.exists() and hostname_path.read_text(encoding="utf-8").strip() != hostname:
        raise RuntimeError("TV Box hostname does not match its device identity.")
    atomic_write(hostname_path, f"{hostname}\n", 0o644)

    ssh_root = state_root / "ssh"
    _create_host_key(ssh_root / "ssh_host_ed25519_key", "ed25519", runner)
    _create_host_key(ssh_root / "ssh_host_rsa_key", "rsa", runner)

    marker_root = state_root / "firstboot-state"
    marker_root.mkdir(mode=0o700, exist_ok=True)
    marker_root.chmod(0o700)
    marker = marker_root / "complete"
    atomic_write(marker, "complete\n", 0o600)
    return {"device_id": device_id, "machine_id": machine_id, "hostname": hostname}


def apply_system_hostname(identity: dict[str, str], system_root: Path = Path("/")) -> None:
    hostname_path = system_root / "etc" / "hostname"
    # The systemd sandbox grants write access to this exact existing file, not
    # the whole of /etc. A partial write is recoverable because the canonical
    # value lives in the state partition and is reapplied on every boot.
    flags = os.O_WRONLY | os.O_TRUNC | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(hostname_path, flags)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(f"{identity['hostname']}\n")
        stream.flush()
        os.fsync(stream.fileno())


def apply_device_permissions(state_root: Path = STATE_ROOT) -> None:
    runtime_group = grp.getgrnam("hexclave-tv-runtime").gr_gid
    journal_group = grp.getgrnam("systemd-journal").gr_gid
    kiosk_user = pwd.getpwnam("hexclave-tv")
    os.chown(state_root, 0, runtime_group)
    state_root.chmod(0o750)
    os.chown(state_root / "identity", 0, runtime_group)
    (state_root / "identity").chmod(0o750)
    os.chown(state_root / "browser", kiosk_user.pw_uid, kiosk_user.pw_gid)
    (state_root / "browser").chmod(0o700)
    os.chown(state_root / "journal", 0, journal_group)
    (state_root / "journal").chmod(0o2755)


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize unique Hexclave TV Box state.")
    parser.add_argument("--state-root", type=Path, default=STATE_ROOT)
    parser.add_argument("--apply-system", action="store_true")
    arguments = parser.parse_args()
    # The image ships with an empty /etc/machine-id, so systemd creates a
    # unique value before services start. Persist that value instead of
    # replacing a machine ID already in use by the running boot.
    system_machine_id = Path("/etc/machine-id").read_text(encoding="utf-8").strip()
    identity = initialize_device(arguments.state_root, system_machine_id=system_machine_id)
    apply_device_permissions(arguments.state_root)
    if arguments.apply_system:
        apply_system_hostname(identity)
        run_command(["hostname", identity["hostname"]])


if __name__ == "__main__":
    main()
