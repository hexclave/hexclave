"""Read-only checks shared by image verification and the destructive flashing wrapper."""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Partition:
    offset: int
    size: int


def raw_image_partitions(image: Path) -> tuple[Partition, ...]:
    if not image.is_file():
        raise ValueError("A regular, uncompressed TV Box disk image is required.")
    with image.open("rb") as source:
        header = source.read(512)
    if header.startswith((b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd", b"\x1f\x8b", b"PK\x03\x04")):
        raise ValueError("Compressed image supplied. Verify its checksum and decompress it before using this script.")
    if len(header) != 512 or header[510:] != b"\x55\xaa":
        raise ValueError("Expected a raw TV Box MBR disk image, not a compressed image or filesystem archive.")
    size = image.stat().st_size
    partitions = []
    previous_end = 512
    # The approved image has four primary partitions with 512-byte sectors.
    # Reject a different layout rather than guessing which filesystem is state.
    for index, expected_type in enumerate((0x0C, 0x83, 0x83, 0x82)):
        entry = header[446 + 16 * index:462 + 16 * index]
        start, sectors = struct.unpack_from("<II", entry, 8)
        partition = Partition(start * 512, sectors * 512)
        if entry[4] != expected_type or partition.size == 0:
            raise ValueError("Image must contain the TV Box boot, root, state, and swap partitions in order.")
        if partition.offset < previous_end or partition.offset + partition.size > size:
            raise ValueError("Image partitions overlap or extend beyond the disk image.")
        previous_end = partition.offset + partition.size
        partitions.append(partition)
    return tuple(partitions)


def read_json(command: list[str]) -> dict:
    result = subprocess.run(command, check=True, text=True, capture_output=True, timeout=15)
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("Image inspection command returned invalid metadata.")
    return value


def only_record(document: dict, key: str) -> dict:
    values = document.get(key)
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise ValueError(f"Expected exactly one {key} record for the supplied image mount.")
    return values[0]


def verify_mount(image: Path, mount: Path, partition: Partition, filesystem: str = "ext4") -> None:
    resolved_mount = mount.resolve(strict=True)
    metadata = only_record(read_json([
        "findmnt", "--json", "--mountpoint", str(resolved_mount),
        "--output", "SOURCE,TARGET,FSTYPE,OPTIONS,FSROOT",
    ]), "filesystems")
    options = set(str(metadata.get("options", "")).split(","))
    required_options = {"ro"}
    missing_requirements = [f'"{option}"' for option in sorted(required_options - options)]
    # ext4 reports noload as its equivalent norecovery spelling on some kernels.
    # Read-only alone still permits journal replay and is never sufficient.
    if filesystem == "ext4" and not options.intersection({"noload", "norecovery"}):
        missing_requirements.append('one of "noload"/"norecovery"')
    if (metadata.get("target") != str(resolved_mount) or metadata.get("fsroot") != "/"
        or metadata.get("fstype") != filesystem or missing_requirements or "rw" in options):
        if missing_requirements:
            missing = "; ".join(missing_requirements)
            raise ValueError(f"Image mount is missing required mount options: {missing}.")
        raise ValueError("Image partitions must be complete expected filesystems mounted read-only, not directories or subdirectory binds.")
    source = metadata.get("source")
    if not isinstance(source, str):
        raise ValueError("Image mount has no block-device source.")
    match = re.fullmatch(r"/dev/(loop[0-9]+)(p[0-9]+)?", source)
    if match is None:
        raise ValueError("Image verification requires read-only loop mounts of the supplied disk image.")
    loop = only_record(read_json([
        "losetup", "--json", "--list", "--output", "NAME,BACK-INO,BACK-MAJ:MIN,OFFSET,RO,SIZELIMIT",
        f"/dev/{match[1]}",
    ]), "loopdevices")
    image_stat = image.stat()
    if (loop.get("name") != f"/dev/{match[1]}" or loop.get("ro") not in (True, 1)
        or loop.get("back-ino") != image_stat.st_ino
        or loop.get("back-maj:min") != f"{os.major(image_stat.st_dev)}:{os.minor(image_stat.st_dev)}"):
        raise ValueError("Mounted filesystem is not backed by this exact image through a read-only loop device.")
    loop_offset = loop.get("offset")
    size_limit = loop.get("sizelimit")
    if not isinstance(loop_offset, int) or not isinstance(size_limit, int):
        raise ValueError("Loop device extent metadata is invalid.")
    # Support both losetup --partscan and separate read-only offset mounts.
    partition_offset = 0
    if match[2] is not None:
        partition_offset = int((Path("/sys/class/block") / Path(source).name / "start").read_text().strip()) * 512
    extent = subprocess.run(
        ["blockdev", "--getsize64", source], check=True, text=True, capture_output=True, timeout=15,
    )
    if (loop_offset + partition_offset != partition.offset
        or int(extent.stdout.strip()) != partition.size
        or (size_limit != 0 and partition_offset + partition.size > size_limit)):
        raise ValueError("Mount does not identify the expected root/state partition of this image.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("raw-image", "mounts"))
    parser.add_argument("image", type=Path)
    parser.add_argument("mounts", type=Path, nargs="*")
    arguments = parser.parse_args()
    try:
        partitions = raw_image_partitions(arguments.image)
        if arguments.mode == "mounts":
            if len(arguments.mounts) != 3:
                raise ValueError("Supply exactly the root, state, and boot mounts.")
            for mount, partition, filesystem in zip(arguments.mounts, (partitions[1], partitions[2], partitions[0]), ("ext4", "ext4", "vfat"), strict=True):
                verify_mount(arguments.image, mount, partition, filesystem)
        elif arguments.mounts:
            raise ValueError("raw-image accepts no mount arguments.")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # This is a local manufacturing CLI, never a public API response.
        parser.exit(1, f"Image preflight failed: {error}\n")


if __name__ == "__main__":
    main()
