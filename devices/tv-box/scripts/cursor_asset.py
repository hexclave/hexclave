#!/usr/bin/env python3
"""Build and verify the appliance's deterministic, single-frame Xcursor."""

from __future__ import annotations

import argparse
import struct
from pathlib import Path

CURSOR_PATH = Path("usr/share/hexclave-tv-box/cursors/default/cursors/left_ptr")
CURSOR_SIZE = 32


def transparent_cursor() -> bytes:
    # Xcursor uses little-endian CARD32 fields: file header, one TOC entry,
    # image header, then premultiplied ARGB pixels. Cage and Cog request
    # default/left_ptr independently, so supply one complete transparent
    # image rather than relying on a missing theme or a web CSS cursor.
    header = struct.pack("<4I", 0x72756358, 16, 0x00010000, 1)
    toc = struct.pack("<3I", 0xFFFD0002, CURSOR_SIZE, 28)
    image_header = struct.pack("<9I", 36, 0xFFFD0002, CURSOR_SIZE, 1, CURSOR_SIZE, CURSOR_SIZE, 0, 0, 0)
    return header + toc + image_header + bytes(CURSOR_SIZE * CURSOR_SIZE * 4)


def verify_cursor(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size != len(transparent_cursor()):
        raise ValueError("TV Box transparent cursor asset is missing or invalid.")
    if path.read_bytes() != transparent_cursor():
        raise ValueError("TV Box cursor must be the exact transparent single-frame asset.")


def install_cursor(rootfs: Path) -> None:
    target = rootfs / CURSOR_PATH
    # Do not follow a pre-existing asset path outside the staged image.
    for parent in (target, *target.parents):
        if parent == rootfs:
            break
        if parent.is_symlink():
            raise ValueError("TV Box cursor path must not contain symlinks.")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        verify_cursor(target)
        return
    with target.open("xb") as stream:
        stream.write(transparent_cursor())
    target.chmod(0o644)
    verify_cursor(target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("install", "verify"))
    parser.add_argument("rootfs", type=Path)
    arguments = parser.parse_args()
    if arguments.operation == "install":
        install_cursor(arguments.rootfs)
    else:
        verify_cursor(arguments.rootfs / CURSOR_PATH)


if __name__ == "__main__":
    main()
