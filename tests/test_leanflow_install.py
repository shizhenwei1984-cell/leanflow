#!/usr/bin/env python3
"""Tests for the LeanFlow installer (symlink + copy, install + uninstall)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INSTALLER = ROOT / "scripts" / "install_leanflow.py"
DEFAULT_MODE = "copy" if os.name == "nt" else "symlink"
INSTALL_PATHS = (
    "commands/flow.md",
    "agents/scout.md",
    "agents/gate.md",
    "skills/leanflow/SKILL.md",
    "extensions/leanflow",
)


def run_installer(*args: str, env: dict | None = None) -> tuple[int, str, str]:
    proc = subprocess.run(
        [sys.executable, str(INSTALLER), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
    )
    return proc.returncode, proc.stdout, proc.stderr


class InstallTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="leanflow-test-"))
        self.fake_agent_dir = self.tmp / "agent"
        self.fake_agent_dir.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    def _env(self) -> dict:
        env = dict(os.environ)
        env["PI_CODING_AGENT_DIR"] = str(self.fake_agent_dir)
        return env

    def assert_default_install_target(self, relative: str) -> None:
        target = self.fake_agent_dir / relative
        source = ROOT / relative
        if DEFAULT_MODE == "symlink":
            self.assertTrue(target.is_symlink(), f"{relative} should be a symlink")
            self.assertTrue(target.resolve(strict=True).exists(), f"{relative} link target missing")
        elif source.is_dir():
            self.assertTrue(target.is_dir(), f"{relative} should be a copied directory")
            self.assertFalse(target.is_symlink(), f"{relative} should not be a symlink")
        else:
            self.assertTrue(target.is_file(), f"{relative} should be a copied file")
            self.assertFalse(target.is_symlink(), f"{relative} should not be a symlink")
            self.assertEqual(target.read_bytes(), source.read_bytes())

    def test_dry_run_uses_platform_default_mode(self) -> None:
        rc, out, _ = run_installer("--dry-run", "--scope", "user", env=self._env())
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertEqual(data["mode"], DEFAULT_MODE)
        self.assertEqual(data["scope"], "user")
        self.assertEqual(data["base"], str(self.fake_agent_dir.resolve()))
        paths = sorted(e["path"] for e in data["entries"])
        self.assertEqual(paths, [
            "agents/gate.md",
            "agents/scout.md",
            "commands/flow.md",
            "extensions/leanflow",
            "skills/leanflow/SKILL.md",
        ])
        for entry in data["entries"]:
            self.assertEqual(entry["state"], "absent")
        kinds = {e["path"]: e["kind"] for e in data["entries"]}
        self.assertEqual(kinds["extensions/leanflow"], "directory")
        for path, kind in kinds.items():
            if path != "extensions/leanflow":
                self.assertEqual(kind, "file")

    def test_apply_and_uninstall_platform_default_mode(self) -> None:
        env = self._env()
        rc, out, _ = run_installer("--apply", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertEqual(data["mode"], DEFAULT_MODE)
        for relative in INSTALL_PATHS:
            self.assert_default_install_target(relative)
        self.assertTrue((self.fake_agent_dir / "leanflow-install.json").exists())

        rc, out, _ = run_installer("--uninstall", "--dry-run", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertEqual(data["action"], "uninstall-dry-run")

        rc, out, _ = run_installer("--uninstall", "--apply", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        for relative in INSTALL_PATHS:
            self.assertFalse((self.fake_agent_dir / relative).exists(), f"{relative} should be removed")
        self.assertFalse((self.fake_agent_dir / "leanflow-install.json").exists())

    def test_apply_copy_mode(self) -> None:
        env = self._env()
        rc, out, _ = run_installer("--apply", "--scope", "user", "--mode", "copy", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        for relative in INSTALL_PATHS:
            target = self.fake_agent_dir / relative
            source = ROOT / relative
            if source.is_dir():
                self.assertTrue(target.is_dir(), f"{relative} should be a real directory (copy)")
            else:
                self.assertTrue(target.is_file(), f"{relative} should be a real file (copy)")
            self.assertFalse(target.is_symlink(), f"{relative} should not be a symlink in copy mode")

        rc, out, _ = run_installer("--uninstall", "--apply", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)

    def test_project_scope(self) -> None:
        project = self.tmp / "myrepo"
        project.mkdir()
        rc, out, _ = run_installer("--dry-run", "--scope", "project", "--project-root", str(project))
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertEqual(data["base"], str((project / ".omp").resolve()))

    def test_force_replaces_existing_platform_default_install(self) -> None:
        env = self._env()
        rc, out, _ = run_installer("--apply", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        rc, out, _ = run_installer("--dry-run", "--scope", "user", env=env)
        data = json.loads(out)
        self.assertFalse(data["ok"])
        self.assertIn("force", data.get("error", ""))
        rc, out, _ = run_installer("--apply", "--scope", "user", "--force", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"], f"force re-install failed: {data}")
        self.assertNotIn("overlaps", data)
        for relative in INSTALL_PATHS:
            self.assert_default_install_target(relative)

    def test_user_symlink_install_and_uninstall_has_only_minimal_roles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "symlink-capability-probe"
            try:
                probe.symlink_to(probe.with_name("symlink-capability-target"))
            except OSError:
                self.skipTest("symlink creation is unavailable to the test process")
            else:
                probe.unlink()
            home = Path(directory) / "home"
            apply = subprocess.run(
                [sys.executable, str(INSTALLER), "--scope", "user", "--mode", "symlink", "--apply"],
                env={**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(home / ".omp" / "agent")},
                text=True,
                capture_output=True,
            )
            self.assertEqual(apply.returncode, 0, apply.stderr)
            metadata = json.loads((home / ".omp" / "agent" / "leanflow-install.json").read_text())
            self.assertEqual({entry["path"] for entry in metadata["entries"]}, set(INSTALL_PATHS))
            agents = home / ".omp" / "agent" / "agents"
            self.assertTrue((agents / "scout.md").is_symlink())
            self.assertTrue((agents / "gate.md").is_symlink())
            self.assertFalse((agents / "repo-reviewer.md").exists())
            remove = subprocess.run(
                [sys.executable, str(INSTALLER), "--scope", "user", "--uninstall", "--apply"],
                env={**os.environ, "HOME": str(home), "PI_CODING_AGENT_DIR": str(home / ".omp" / "agent")},
                text=True,
                capture_output=True,
            )
            self.assertEqual(remove.returncode, 0, remove.stderr)
            self.assertFalse((home / ".omp" / "agent" / "leanflow-install.json").exists())


if __name__ == "__main__":
    unittest.main()
