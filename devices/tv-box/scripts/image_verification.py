"""Build-host qualification checks; never installed as an appliance background task."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shlex
import stat
import struct
import subprocess
from pathlib import Path, PurePosixPath


POLICY = Path(__file__).resolve().parents[1] / "image/qualified-runtime.json"
PRIVATE_KEY = re.compile(rb"(?:^|\n)-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----\r?\n")
OPENSSH_CERTIFICATE = re.compile(
    rb"(?:^|\n)[ \t]*((?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)"
    rb"|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256))-cert-v01@openssh\.com)[ \t]+([A-Za-z0-9+/]{4,128})"
)
PACKAGE_NAME = re.compile(r"[a-z0-9][a-z0-9+.-]+(?::[a-z0-9-]+)?")
VERIFICATION_ARTIFACTS = (
    "packages.tsv", "builder-manifest.tsv", "qualified-runtime.json", "image-manifest.txt",
    "rootfs-sha256.txt", "state-sha256.txt", "boot-sha256.txt", "disk-image-sha256.txt",
)


def digest(path: Path, limit: int | None = None) -> str:
    checksum = hashlib.sha256()
    remaining = limit
    with path.open("rb") as source:
        while remaining is None or remaining > 0:
            chunk = source.read(1024 * 1024 if remaining is None else min(1024 * 1024, remaining))
            if not chunk:
                if remaining not in (None, 0):
                    raise ValueError("Read-back target ended before the verified image extent.")
                break
            checksum.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return checksum.hexdigest()


def image_path(root: Path, relative: str) -> Path:
    """Resolve image symlinks as chroot paths, never against the build host's /etc."""
    pending = list(PurePosixPath(relative).parts)
    parts: list[str] = []
    links = 0
    while pending:
        part = pending.pop(0)
        if part in ("", ".", "/"):
            continue
        if part == "..":
            if not parts:
                raise ValueError("Image path escapes its filesystem root.")
            parts.pop()
            continue
        candidate = root.joinpath(*parts, part)
        if candidate.is_symlink():
            links += 1
            if links > 40:
                raise ValueError("Image path contains a symlink cycle.")
            target = PurePosixPath(os.readlink(candidate))
            if target.is_absolute():
                parts.clear()
            pending = list(target.parts) + pending
        else:
            parts.append(part)
    result = root.joinpath(*parts)
    if not result.is_file():
        raise ValueError(f"Required image file is missing: {relative}")
    return result


def verify_legacy_paths(root: Path, *required: Path) -> None:
    # The shell verifier uses ordinary grep/cp/test. Validate its exact paths
    # before any such read, so an image link cannot redirect it into host files.
    # /etc/os-release is handled separately by the chroot-aware resolver above;
    # NetworkManager's intentional profile symlink is only inspected via readlink.
    inspected = (*required, *(Path(value) for value in (
        "etc/machine-id", "etc/hexclave-tv-box-test-image", "etc/NetworkManager", "etc/ssh",
        "var/lib/hexclave-tv-box", "var/lib/systemd", "usr/lib/python3/dist-packages/hexclave_tv_box",
        "usr/share/hexclave-tv-box/cursors/default/cursors/left_ptr",
    )))
    for relative in inspected:
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Legacy image inspection path must be relative to the image root.")
        path = root
        for index, part in enumerate(relative.parts):
            path /= part
            if path.is_symlink():
                raise ValueError(f"Image inspection path contains a forbidden symlink: {relative}")
            if index < len(relative.parts) - 1 and path.exists() and not path.is_dir():
                raise ValueError("Image inspection path has a non-directory ancestor.")


def read_fields(path: Path) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key in fields:
            raise ValueError("Image release metadata is malformed or duplicated.")
        pieces = shlex.split(value)
        if len(pieces) != 1:
            raise ValueError("Image release metadata has an invalid field.")
        fields[key] = pieces[0]
    return fields


def installed_packages(root: Path) -> dict[str, tuple[str, str]]:
    records = image_path(root, "var/lib/dpkg/status").read_text(encoding="utf-8").split("\n\n")
    packages: dict[str, tuple[str, str]] = {}
    for record in records:
        fields = dict(line.split(": ", 1) for line in record.splitlines() if ": " in line and not line.startswith(" "))
        if fields.get("Status") != "install ok installed":
            continue
        name, version, architecture = fields.get("Package"), fields.get("Version"), fields.get("Architecture")
        if not name or not PACKAGE_NAME.fullmatch(name) or not version or not architecture or name in packages:
            raise ValueError("Installed package database is malformed or contains ambiguous architectures.")
        packages[name] = (version, architecture)
    if not packages:
        raise ValueError("Installed package inventory is empty.")
    return packages


def verify_runtime(root: Path, policy_file: Path = POLICY) -> dict[str, tuple[str, str]]:
    policy = json.loads(policy_file.read_text(encoding="utf-8"))
    if policy.get("schema_version") != 1 or not policy.get("packages"):
        raise ValueError("Qualified runtime policy is invalid.")
    release = read_fields(image_path(root, "etc/os-release"))
    if any(release.get(key) != value for key, value in policy["os"].items()):
        raise ValueError("Image OS does not match the qualified runtime policy.")
    architectures = image_path(root, "var/lib/dpkg/arch").read_text(encoding="ascii").splitlines()
    if architectures != [policy["architecture"]]:
        raise ValueError("Image architecture does not match the qualified runtime policy.")
    packages = installed_packages(root)
    for name, (version, architecture) in packages.items():
        if architecture not in ("all", policy["architecture"]):
            raise ValueError(f"Unqualified package architecture: {name}")
    for name, expected in policy["packages"].items():
        if name not in packages or packages[name][0] != expected:
            raise ValueError(f"Qualified package version mismatch: {name}; review and requalify before changing the baseline.")
    return packages


def validate_public_key(path: Path) -> None:
    content = path.read_bytes()
    if len(content) > 16384 or b"\r" in content or len(content.splitlines()) != 1 or b"PRIVATE KEY" in content:
        raise ValueError("Support CA must contain exactly one OpenSSH public key and no additional material.")
    parts = content.split()
    if len(parts) < 2 or parts[0] not in (b"ssh-ed25519", b"ssh-rsa"):
        raise ValueError("Support CA must be an Ed25519 or RSA OpenSSH public key.")
    try:
        decoded = base64.b64decode(parts[1], validate=True)
        if base64.b64encode(decoded) != parts[1]:
            raise ValueError("non-canonical encoding")
        offset = 0
        fields: list[bytes] = []
        while offset < len(decoded):
            size = struct.unpack_from(">I", decoded, offset)[0]
            offset += 4
            if size > len(decoded) - offset:
                raise ValueError("truncated key")
            fields.append(decoded[offset:offset + size])
            offset += size
        if fields[0] != parts[0]:
            raise ValueError("key type mismatch")
        if parts[0] == b"ssh-ed25519":
            valid = len(fields) == 2 and len(fields[1]) == 32
        else:
            valid = (len(fields) == 3 and bool(fields[1]) and bool(fields[2])
                     and not fields[1][0] & 0x80 and not fields[2][0] & 0x80
                     and int.from_bytes(fields[1], "big") >= 3
                     and int.from_bytes(fields[1], "big") % 2 == 1
                     and int.from_bytes(fields[2], "big").bit_length() >= 2048)
        if not valid:
            raise ValueError("invalid key")
    except (ValueError, IndexError, struct.error) as error:
        raise ValueError("Support CA public-key encoding is invalid.") from error


def builder_packages(path: Path) -> dict[str, str]:
    if path.suffix == ".zst":
        result = subprocess.run(["zstd", "-dc", "--", str(path)], check=True, capture_output=True, timeout=30)
        content = result.stdout.decode("utf-8")
    else:
        content = path.read_text(encoding="utf-8")
    packages: dict[str, str] = {}
    for line in content.splitlines():
        parts = line.split("\t")
        if len(parts) != 2 or not PACKAGE_NAME.fullmatch(parts[0]) or not parts[1] or parts[0] in packages:
            raise ValueError("Builder package inventory must contain unique package/version TSV rows.")
        packages[parts[0]] = parts[1]
    return packages


def contains_certificate_record(content: bytes) -> bool:
    if b"-cert-v01@openssh.com" not in content:
        return False
    for match in OPENSSH_CERTIFICATE.finditer(content):
        key_type, encoded_prefix = match.groups()
        # Match the wire-format key type, not just an algorithm name: OpenSSH
        # binaries and documentation legitimately contain certificate names.
        # A bounded prefix suffices and does not decode or retain the full cert.
        prefix = base64.b64decode(encoded_prefix[:len(encoded_prefix) // 4 * 4])
        if len(prefix) < 4:
            continue
        type_size = struct.unpack_from(">I", prefix)[0]
        if type_size == len(key_type) and prefix[4:4 + type_size] == key_type:
            return True
    return False


def scan_clean_filesystem(root: Path, label: str, *, production: bool) -> None:
    """Do not follow symlinks or nested mounts while scanning the exact read-only image."""
    root_device = root.stat().st_dev
    public_vectors = json.loads(POLICY.read_text(encoding="utf-8")).get("public_test_vectors", {})
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in list(directories):
            path = Path(directory) / name
            if path.is_symlink() or path.lstat().st_dev != root_device:
                directories.remove(name)
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            # Report only paths/reasons. Never print key material, cookie values,
            # passwords, or line excerpts from a rejected artifact.
            unsafe_name = (name.endswith((".nmconnection", "-cert.pub"))
                           or name in ("cookies.sqlite", "cookies.sqlite-wal", "Cookies", "id_ed25519", "id_rsa", "tv-box-support-ca", "enrollment.json")
                           or name.startswith(".env")
                           or name == "hexclave-tv-box-test-origin.txt"
                           or (production and name == "hexclave-tv-box-test-image"))
            if unsafe_name:
                raise ValueError(f"Uninitialized-image policy rejected artifact: {label}/{relative}")
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode):
                continue
            with path.open("rb") as source:
                overlap = b""
                first_chunk = True
                while chunk := source.read(1024 * 1024):
                    data = overlap + chunk
                    # Retained overlap can start in the middle of a line. It
                    # must not invent a new record boundary in later chunks.
                    if contains_certificate_record(data if first_chunk else b"\x00" + data):
                        raise ValueError(f"OpenSSH certificate material rejected: {label}/{relative}")
                    if (b"PRIVATE KEY" in data and PRIVATE_KEY.search(data)) or data.startswith(b"PuTTY-User-Key-File-"):
                        # Debian ships this publicly documented crypto test vector.
                        # The exact path AND immutable bytes must match; neither
                        # package ownership nor a test directory is a blanket exemption.
                        expected_vector = public_vectors.get(relative) if label == "root" else None
                        if expected_vector is not None and digest(path) == expected_vector["sha256"]:
                            break
                        raise ValueError(f"Private-key material rejected: {label}/{relative}")
                    # Include both the text key type and its base64 wire prefix
                    # when a certificate record crosses an input chunk boundary.
                    overlap = data[-512:]
                    first_chunk = False


def begin_output(output: Path, *inputs: Path) -> None:
    resolved = output.resolve()
    if resolved != Path(os.path.abspath(output)):
        raise ValueError("Verification output must not contain symlink components.")
    if any(resolved == path.resolve() or resolved.is_relative_to(path.resolve()) for path in inputs):
        raise ValueError("Verification output must be separate from the image and its mounted filesystems.")
    for name in (*VERIFICATION_ARTIFACTS, "verification.json"):
        artifact = output / name
        if artifact.is_symlink() or (artifact.exists() and (not artifact.is_file() or artifact.stat().st_nlink != 1)):
            raise ValueError("Verification artifact paths must be ordinary files without symlinks or hard links.")
    receipt = output / "verification.json"
    if receipt.is_symlink():
        raise ValueError("Refusing a symlink at the generated verification receipt path.")
    if receipt.exists():
        previous = json.loads(receipt.read_text(encoding="utf-8"))
        if previous.get("schema_version") != 1 or previous.get("result") != "passed":
            raise ValueError("Refusing to replace an unrecognized existing verification receipt.")
        # This exact generated result must not survive a failed rerun. All other
        # artifacts remain recoverable, but manufacturing requires a new receipt.
        receipt.unlink()


def verify_final(root: Path, state: Path, boot: Path, manifest: Path, output: Path, image: Path) -> None:
    packages = verify_runtime(root)
    expected = {name: version for name, (version, _) in packages.items()}
    if builder_packages(manifest) != expected:
        raise ValueError("Builder inventory differs from the final image's installed package database.")
    release_file = image_path(root, "etc/hexclave-tv-box-release")
    release = read_fields(release_file)
    if release.get("image-channel") not in ("production", "test") or not re.fullmatch(r"[0-9a-f]{40}", release.get("source-commit", "")):
        raise ValueError("Image release must declare its channel and exact source commit.")
    validate_public_key(image_path(root, "etc/ssh/hexclave-support-ca.pub"))
    for filesystem, label in ((root, "root"), (state, "state"), (boot, "boot")):
        scan_clean_filesystem(filesystem, label, production=release["image-channel"] == "production")
    inventory = "".join(f"{name}\t{version}\t{architecture}\n" for name, (version, architecture) in sorted(packages.items()))
    output.mkdir(parents=True, exist_ok=True)
    (output / "packages.tsv").write_text(inventory, encoding="utf-8")
    (output / "qualified-runtime.json").write_bytes(POLICY.read_bytes())
    (output / "builder-manifest.tsv").write_text("".join(f"{name}\t{version}\n" for name, version in sorted(expected.items())), encoding="utf-8")
    # This receipt is generated last, after the shell verifier's filesystem and
    # service checks and every check above. It is integrity evidence, not a signature.
    receipt = {
        "schema_version": 1, "result": "passed", "image_channel": release["image-channel"],
        "source_commit": release["source-commit"], "image_bytes": image.stat().st_size,
        # The build wrapper checks its actual checkout against this revision.
        # Recording the reviewed requirement here is not a signed provenance claim.
        "qualified_builder_commit": json.loads(POLICY.read_text(encoding="utf-8"))["image_builder_commit"],
        "image_sha256": digest(image), "builder_source_sha256": digest(manifest),
        "artifacts": {name: digest(output / name) for name in VERIFICATION_ARTIFACTS},
    }
    (output / "verification.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def verify_receipt(image: Path, output: Path) -> None:
    receipt = json.loads((output / "verification.json").read_text(encoding="utf-8"))
    if (receipt.get("schema_version") != 1 or receipt.get("result") != "passed"
        or receipt.get("image_bytes") != image.stat().st_size or receipt.get("image_sha256") != digest(image)):
        raise ValueError("Image does not match a completed verification receipt.")
    if receipt.get("image_channel") != "production":
        raise ValueError("Manufacturing requires a production-channel image; test images must never be shipped.")
    required = set(VERIFICATION_ARTIFACTS)
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) != required:
        raise ValueError("Verification receipt is missing required artifact hashes.")
    if any(digest(output / name) != value for name, value in artifacts.items()):
        raise ValueError("Verification artifact checksum mismatch.")
    archived_policy = json.loads((output / "qualified-runtime.json").read_text(encoding="utf-8"))
    if receipt.get("qualified_builder_commit") != archived_policy.get("image_builder_commit"):
        raise ValueError("Verification receipt does not match the qualified image-builder revision.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("runtime", "public-key", "legacy-inputs", "begin-output", "final", "receipt", "readback"))
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    try:
        if args.mode == "runtime" and len(args.paths) == 2:
            verify_runtime(*args.paths)
        elif args.mode == "public-key" and len(args.paths) == 1:
            validate_public_key(args.paths[0])
        elif args.mode == "legacy-inputs" and len(args.paths) >= 1:
            verify_legacy_paths(*args.paths)
        elif args.mode == "begin-output" and len(args.paths) == 5:
            begin_output(*args.paths)
        elif args.mode == "final" and len(args.paths) == 6:
            verify_final(*args.paths)
        elif args.mode == "receipt" and len(args.paths) == 2:
            verify_receipt(*args.paths)
        elif args.mode == "readback" and len(args.paths) == 2:
            image, device = args.paths
            if digest(image) != digest(device, image.stat().st_size):
                raise ValueError("Flashed image read-back checksum mismatch; do not ship or boot as qualified.")
        else:
            raise ValueError("Incorrect argument count for verification mode.")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Image verification failed: {error}\n")


if __name__ == "__main__":
    main()
