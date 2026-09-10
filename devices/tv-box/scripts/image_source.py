"""Reject ignored local inputs that the appliance layer would otherwise copy."""

from __future__ import annotations

import argparse
import os
import stat
import subprocess
from pathlib import Path


RUNTIME_SOURCE = Path("devices/tv-box/src/hexclave_tv_box")
PAYLOAD_SOURCES = (
    Path("devices/tv-box/image/rootfs"),
    RUNTIME_SOURCE,
    Path("devices/tv-box/setup-ui"),
)


def removed_runtime_bytecode(repository: Path, relative: Path) -> bool:
    if not relative.is_relative_to(RUNTIME_SOURCE):
        return False
    path = repository / relative
    metadata = path.lstat()
    if stat.S_ISREG(metadata.st_mode):
        return path.suffix in (".pyc", ".pyo")
    if stat.S_ISDIR(metadata.st_mode) and path.name == "__pycache__":
        return all(
            stat.S_ISREG(child.lstat().st_mode) and child.suffix in (".pyc", ".pyo")
            for child in path.iterdir()
        )
    return False


def reject_special_payload_inputs(repository: Path) -> None:
    def inspection_failed(error: OSError) -> None:
        raise error

    # Git does not list untracked FIFOs/sockets/devices, but cp -a preserves
    # them. Inspect those independently, without following directory links.
    for source in PAYLOAD_SOURCES:
        for directory, _directories, files in os.walk(repository / source, followlinks=False, onerror=inspection_failed):
            for name in files:
                path = Path(directory) / name
                mode = path.lstat().st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                    raise ValueError(f"Image payload contains an untracked special file: {str(path.relative_to(repository))!r}.")


def verify_ignored_payload_inputs(repository: Path) -> None:
    repository = repository.resolve(strict=True)
    for relative in PAYLOAD_SOURCES:
        source = repository / relative
        if not stat.S_ISDIR(source.lstat().st_mode) or source.resolve(strict=True) != source:
            raise ValueError(f"Image payload source must be a real directory inside the checkout, without linked ancestors: {relative}")
    reject_special_payload_inputs(repository)
    result = subprocess.run(
        ["git", "-C", str(repository), "ls-files", "--others", "--ignored", "--exclude-standard",
         "--directory", "-z", "--", *(str(path) for path in PAYLOAD_SOURCES)],
        check=True, capture_output=True, timeout=30,
    )
    # --directory also reports empty ignored directories. NUL-delimited paths
    # retain names containing whitespace instead of accidentally exempting them.
    for name in result.stdout.split(b"\0"):
        if not name:
            continue
        relative = Path(os.fsdecode(name))
        if (relative.is_absolute() or ".." in relative.parts
            or not any(relative.is_relative_to(source) for source in PAYLOAD_SOURCES)):
            raise ValueError("Git returned a path outside the image payload sources.")
        # The layer removes only runtime bytecode/cache directories. Do not
        # extend this exception to rootfs/setup assets, links, or diagnostic files.
        if removed_runtime_bytecode(repository, relative):
            continue
        raise ValueError(f"Ignored local image input is not allowed: {str(relative)!r}. Move it outside the copied payload sources.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    arguments = parser.parse_args()
    try:
        verify_ignored_payload_inputs(arguments.repository)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Image source check failed: {error}\n")


if __name__ == "__main__":
    main()
