"""Idempotent creation of unique local appliance identity."""

from __future__ import annotations

import argparse
import grp
import os
import pwd
import secrets
import stat
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
    relay_group: str | None = "hexclave-tv-relay",
) -> dict[str, str]:
    expected_uid = 0 if os.geteuid() == 0 else os.getuid()
    relay_gid: int | None = None
    if relay_group is not None:
        try:
            relay_gid = grp.getgrnam(relay_group).gr_gid
        except KeyError as error:
            raise RuntimeError(f"TV Box relay group is missing: {relay_group}") from error
    try:
        state_metadata = os.lstat(state_root)
    except FileNotFoundError:
        state_root.mkdir(mode=0o700, parents=True)
        state_metadata = os.lstat(state_root)
    if stat.S_ISLNK(state_metadata.st_mode) or not stat.S_ISDIR(state_metadata.st_mode):
        raise RuntimeError("TV Box state root must be a real directory, not a symlink.")
    if state_metadata.st_uid != expected_uid:
        raise RuntimeError("TV Box state root has an unexpected owner.")
    state_root.chmod(0o700)
    for name in ("browser", "identity", "journal", "network-connections", "ssh", "relay"):
        directory = state_root / name
        mode = 0o750 if name == "relay" else 0o700
        group_id = relay_gid if name == "relay" else None
        try:
            metadata = os.lstat(directory)
        except FileNotFoundError:
            os.mkdir(directory, mode)
            if group_id is not None:
                os.chown(directory, expected_uid, group_id)
            metadata = os.lstat(directory)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"TV Box state directory {name!r} must be a real directory, not a symlink.")
        if metadata.st_uid != expected_uid:
            raise RuntimeError(f"TV Box state directory {name!r} has an unexpected owner.")
        if group_id is not None and metadata.st_gid != group_id:
            raise RuntimeError(f"TV Box state directory {name!r} has an unexpected group.")
        directory.chmod(mode)

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


def _update_existing_regular_file(path: Path, transform: Callable[[str], str]) -> None:
    # First boot is allowed to mutate only these pre-existing identity files.
    # Opening without following links keeps a compromised image path from
    # redirecting the root service outside that exact scope.
    flags = os.O_RDWR | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise OSError(f"TV Box identity target is not a regular file: {path}")
    with os.fdopen(descriptor, "r+", encoding="utf-8") as stream:
        updated = transform(stream.read())
        stream.seek(0)
        stream.truncate()
        stream.write(updated)
        stream.flush()
        os.fsync(stream.fileno())


def _hosts_with_hostname(contents: str, hostname: str) -> str:
    lines: list[str] = []
    replaced = False
    managed_line: str | None = None
    for line in contents.splitlines():
        before_comment, separator, comment = line.partition("#")
        fields = before_comment.split()
        if fields and fields[0] == "127.0.1.1" and len(fields) >= 2:
            if not replaced:
                replacement = f"127.0.1.1\t{hostname}"
                if len(fields) > 2:
                    replacement += "\t" + "\t".join(fields[2:])
                if separator:
                    replacement += " " + separator + comment
                lines.append(replacement)
                managed_line = line
                replaced = True
            elif line == managed_line:
                continue
            else:
                lines.append(line)
            continue
        lines.append(line)
    if not replaced:
        lines.append(f"127.0.1.1\t{hostname}")
    return "\n".join(lines) + "\n"


def apply_system_hostname(identity: dict[str, str], system_root: Path = Path("/")) -> None:
    hostname = identity["hostname"]
    _update_existing_regular_file(system_root / "etc" / "hostname", lambda _contents: f"{hostname}\n")
    # sudo resolves the current hostname before executing the forced support
    # command. Keep the local hosts entry synchronized with the unique first-
    # boot hostname so restricted support remains quiet and deterministic.
    _update_existing_regular_file(
        system_root / "etc" / "hosts",
        lambda contents: _hosts_with_hostname(contents, hostname),
    )


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
