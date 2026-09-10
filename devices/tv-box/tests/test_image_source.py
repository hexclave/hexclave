from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import image_source


class ImageSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(suffix=".untracked")
        self.addCleanup(self.directory.cleanup)
        self.repository = Path(self.directory.name)
        for relative in image_source.PAYLOAD_SOURCES:
            (self.repository / relative).mkdir(parents=True)

    def check_inputs(self, *ignored: Path) -> None:
        result = subprocess.CompletedProcess([], 0, b"".join(os.fsencode(path) + b"\0" for path in ignored), b"")
        with patch.object(image_source.subprocess, "run", return_value=result) as command:
            image_source.verify_ignored_payload_inputs(self.repository)
            command.assert_called_once_with(
                ["git", "-C", str(self.repository), "ls-files", "--others", "--ignored", "--exclude-standard",
                 "--directory", "-z", "--", "devices/tv-box/image/rootfs",
                 "devices/tv-box/src/hexclave_tv_box", "devices/tv-box/setup-ui"],
                check=True, capture_output=True, timeout=30,
            )

    def test_ignored_files_and_directory_parents_are_rejected_in_every_payload(self) -> None:
        for source in image_source.PAYLOAD_SOURCES:
            for name, directory in (("diagnostic.untracked.txt", False), ("local\nnotes.untracked.txt", False), ("scratch.untracked", True)):
                with self.subTest(source=str(source), name=name):
                    relative = source / name
                    path = self.repository / relative
                    if directory:
                        path.mkdir()
                        # Git --directory reports the parent, including when
                        # it is empty; neither shape may bypass the source gate.
                        with self.assertRaisesRegex(ValueError, "Ignored local image input"):
                            self.check_inputs(relative)
                        (path / "nested.txt").write_text("local-fixture", encoding="utf-8")
                    else:
                        path.write_text("local-fixture", encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "Ignored local image input") as rejected:
                        self.check_inputs(relative)
                    self.assertNotIn("\n", str(rejected.exception))
                    self.assertNotIn("local-fixture", str(rejected.exception))

    def test_only_regular_runtime_bytecode_and_its_cache_are_exempt(self) -> None:
        runtime = image_source.RUNTIME_SOURCE
        loose = runtime / "module.pyc"
        optimized = runtime / "module.pyo"
        cache = runtime / "__pycache__"
        (self.repository / cache).mkdir()
        for relative in (loose, optimized, cache / "module.cpython-313.pyc"):
            (self.repository / relative).write_bytes(b"bytecode-fixture")
        self.check_inputs(loose, optimized, cache)
        for source in (image_source.PAYLOAD_SOURCES[0], image_source.PAYLOAD_SOURCES[2]):
            relative = source / "module.pyc"
            (self.repository / relative).write_bytes(b"bytecode-fixture")
            with self.subTest(source=str(source)), self.assertRaisesRegex(ValueError, "Ignored local image input"):
                self.check_inputs(relative)
        (self.repository / cache / "diagnostic.untracked.txt").write_text("local-fixture", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Ignored local image input"):
            self.check_inputs(cache)

    def test_symlinks_and_special_files_do_not_inherit_the_bytecode_exception(self) -> None:
        runtime = image_source.RUNTIME_SOURCE
        target = self.repository / "outside.untracked"
        target.mkdir()
        for name, kind in (("link.pyc", "link"), ("__pycache__", "link"), ("fifo.pyc", "fifo"), ("directory.pyc", "directory")):
            relative = runtime / name
            path = self.repository / relative
            if kind == "link":
                path.symlink_to(target, target_is_directory=True)
            elif kind == "fifo":
                os.mkfifo(path)
            else:
                path.mkdir()
            reason = "special file" if kind == "fifo" else "Ignored local image input"
            with self.subTest(kind=kind, name=name), self.assertRaisesRegex(ValueError, reason):
                self.check_inputs(relative)
            if kind == "directory":
                path.rmdir()
            else:
                path.unlink()
        self.assertEqual(list(target.iterdir()), [])

    def test_external_ca_and_local_references_outside_payloads_are_not_inspected(self) -> None:
        for relative in (
            Path("reference.untracked.md"), Path("offline-ca.untracked.pub"),
            Path("devices/tv-box/artifacts/manifest.untracked.txt"),
        ):
            path = self.repository / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("external-fixture", encoding="utf-8")
        self.check_inputs()

    def test_git_inspection_failure_is_not_treated_as_clean_source(self) -> None:
        with patch.object(image_source.subprocess, "run", side_effect=subprocess.CalledProcessError(73, ["git"])):
            with self.assertRaises(subprocess.CalledProcessError):
                image_source.verify_ignored_payload_inputs(self.repository)

    def test_real_git_worktree_checks_ignored_directories_links_and_special_files(self) -> None:
        # Use the existing repository's index read-only with an isolated work
        # tree. No git init/add/commit or modifications to the real worktree.
        git_directory = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--absolute-git-dir"],
            check=True, text=True, capture_output=True,
        ).stdout.strip()
        (self.repository / ".gitignore").write_text("*.untracked\n*.untracked.*\n__pycache__/\n*.pyc\n", encoding="utf-8")
        with patch.dict(os.environ, {"GIT_DIR": git_directory, "GIT_WORK_TREE": str(self.repository)}):
            outside = self.repository / "reference.untracked.md"
            outside.write_text("external-fixture", encoding="utf-8")
            image_source.verify_ignored_payload_inputs(self.repository)
            for source, name, kind in (
                (image_source.PAYLOAD_SOURCES[0], "scratch.untracked", "directory"),
                (image_source.PAYLOAD_SOURCES[0], "nested.untracked", "populated-directory"),
                (image_source.PAYLOAD_SOURCES[2], "link.untracked", "link"),
                (image_source.RUNTIME_SOURCE, "fifo.pyc", "fifo"),
                (image_source.RUNTIME_SOURCE, "socket.pyc", "socket"),
            ):
                path = self.repository / source / name
                if kind == "directory":
                    path.mkdir()
                elif kind == "populated-directory":
                    path.mkdir()
                    (path / "nested.txt").write_text("local-fixture", encoding="utf-8")
                elif kind == "link":
                    path.symlink_to(outside)
                elif kind == "fifo":
                    os.mkfifo(path)
                else:
                    with socket.socket(socket.AF_UNIX) as listener:
                        listener.bind(str(path))
                reason = "special file" if kind in ("fifo", "socket") else "Ignored local image input"
                with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, reason):
                    image_source.verify_ignored_payload_inputs(self.repository)
                if kind == "populated-directory":
                    (path / "nested.txt").unlink()
                if kind in ("directory", "populated-directory"):
                    path.rmdir()
                else:
                    path.unlink()

    def test_source_root_links_and_unexpected_git_paths_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "outside the image payload"):
            self.check_inputs(Path("../outside.untracked"))
        source = self.repository / image_source.PAYLOAD_SOURCES[0]
        source.rmdir()
        source.symlink_to(self.repository, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "real directory"):
            self.check_inputs()

    def test_payload_source_with_linked_ancestor_is_rejected(self) -> None:
        outside = self.repository.parent / f"{self.repository.name}-outside"
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (outside / "image/rootfs").mkdir(parents=True)
        (outside / "image/rootfs/planted.txt").write_text("external-fixture", encoding="utf-8")
        shutil.rmtree(self.repository / "devices/tv-box/image")
        (self.repository / "devices/tv-box/image").symlink_to(outside / "image", target_is_directory=True)

        with patch.object(image_source.subprocess, "run", side_effect=AssertionError("git must not run")) as command:
            with self.assertRaisesRegex(ValueError, "linked ancestors"):
                image_source.verify_ignored_payload_inputs(self.repository)
            command.assert_not_called()

        with tempfile.TemporaryDirectory(suffix=".untracked") as second_directory:
            second_repository = Path(second_directory)
            for relative in image_source.PAYLOAD_SOURCES:
                (second_repository / relative).mkdir(parents=True)
            second_outside = second_repository.parent / f"{second_repository.name}-outside"
            self.addCleanup(shutil.rmtree, second_outside, ignore_errors=True)
            (second_outside / "tv-box/image/rootfs").mkdir(parents=True)
            (second_outside / "tv-box/image/rootfs/planted.txt").write_text("external-fixture", encoding="utf-8")
            shutil.rmtree(second_repository / "devices/tv-box")
            (second_repository / "devices/tv-box").symlink_to(second_outside / "tv-box", target_is_directory=True)

            with patch.object(image_source.subprocess, "run", side_effect=AssertionError("git must not run")) as command:
                with self.assertRaisesRegex(ValueError, "linked ancestors"):
                    image_source.verify_ignored_payload_inputs(second_repository)
                command.assert_not_called()

    def test_allowed_bytecode_is_removed_by_the_actual_layer_cleanup(self) -> None:
        runtime = self.repository / image_source.RUNTIME_SOURCE
        cache = runtime / "__pycache__"
        cache.mkdir()
        (cache / "module.cpython-313.pyc").write_bytes(b"bytecode-fixture")
        (runtime / "module.pyo").write_bytes(b"bytecode-fixture")
        (runtime / "module.py").write_text("# source fixture\n", encoding="utf-8")
        self.check_inputs(image_source.RUNTIME_SOURCE / "__pycache__", image_source.RUNTIME_SOURCE / "module.pyo")
        layer = (ROOT / "image/layer/hexclave-tv-box-pilot.yaml").read_text(encoding="utf-8")
        commands = [line.strip() for line in layer.splitlines() if (
            line.strip().startswith('cp -a --no-preserve=ownership "${SRCROOT}/../src/hexclave_tv_box"')
            or line.strip().startswith('find "$1/usr/lib/python3/dist-packages/hexclave_tv_box"')
        )]
        self.assertEqual(len(commands), 3)
        destination = self.repository / "target.untracked"
        (destination / "usr/lib/python3/dist-packages").mkdir(parents=True)
        subprocess.run(
            ["sh", "-c", "set -eu\n" + "\n".join(commands), "payload-test", str(destination)],
            env={**os.environ, "SRCROOT": str(self.repository / "devices/tv-box/image")}, check=True,
        )
        installed = destination / "usr/lib/python3/dist-packages/hexclave_tv_box"
        self.assertEqual([path.name for path in installed.iterdir()], ["module.py"])


if __name__ == "__main__":
    unittest.main()
