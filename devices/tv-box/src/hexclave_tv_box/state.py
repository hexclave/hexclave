"""Exact-scope filesystem helpers for device-generated TV Box state."""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
from pathlib import Path

STATE_ROOT = Path("/var/lib/hexclave-tv-box")
RUNTIME_ROOT = Path("/run/hexclave-tv-box")


def atomic_write(path: Path, value: str, mode: int = 0o600) -> None:
    missing: list[Path] = []
    first_missing = False
    for current in reversed(path.parents):
        if first_missing:
            missing.append(current)
            continue
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            first_missing = True
            missing.append(current)
            continue
        if os.path.islink(current) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError(f"TV Box state parent must be a real directory: {current}")
    for directory in missing:
        os.mkdir(directory, 0o700)
    try:
        metadata = os.lstat(path.parent)
    except FileNotFoundError as error:
        raise ValueError(f"TV Box state parent does not exist: {path.parent}") from error
    if os.path.islink(path.parent) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"TV Box state parent must be a real directory: {path.parent}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary_path.unlink(missing_ok=True)


def require_exact_child(path: Path, root: Path, expected_name: str) -> Path:
    root_metadata = os.lstat(root)
    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        raise ValueError("TV Box state root must be a real directory, not a linked path.")
    resolved_root = root.resolve()
    expected = resolved_root / expected_name
    # Never follow a state-directory symlink. In particular, a link from the
    # requested name to a sibling would otherwise make both resolved paths
    # equal and could turn a scoped reset into deletion of the sibling.
    lexical_root = Path(os.path.abspath(root))
    lexical_parent = Path(os.path.abspath(path.parent))
    try:
        relative_parent = lexical_parent.relative_to(lexical_root)
    except ValueError as error:
        raise ValueError(f"Refusing to operate outside the exact TV Box state target {expected_name!r}.") from error
    ancestor = lexical_root
    for component in relative_parent.parts:
        ancestor /= component
        try:
            metadata = os.lstat(ancestor)
        except FileNotFoundError:
            break
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("TV Box state path contains a linked or non-directory ancestor.")
    if path.is_symlink():
        raise ValueError(f"Refusing to operate on a linked TV Box state target {expected_name!r}.")
    resolved_path = path.resolve()
    if path.parent.resolve() != resolved_root or resolved_path != expected or resolved_path.parent != resolved_root:
        raise ValueError(f"Refusing to operate outside the exact TV Box state target {expected_name!r}.")
    return resolved_path


def clear_exact_state_directory(root: Path, expected_name: str) -> None:
    target = require_exact_child(root / expected_name, root, expected_name)
    target.mkdir(mode=0o700, parents=False, exist_ok=True)
    # Keep the exact directory itself in place. Some state directories are
    # bind-mount sources (notably the persistent journal), so replacing the
    # directory can fail with EBUSY or leave the live mount pointing at an
    # unlinked inode. Child symlinks are unlinked rather than followed.
    for child in target.iterdir():
        if child.is_symlink() or child.is_file():
            child.unlink()
        elif child.is_dir():
            shutil.rmtree(child)
        else:
            raise ValueError(f"Refusing to clear an unsupported TV Box state entry in {expected_name!r}.")
