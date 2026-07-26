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

    def test_dry_run_user_symlink(self) -> None:
        rc, out, _ = run_installer("--dry-run", "--scope", "user", env=self._env())
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertEqual(data["mode"], "symlink")
        self.assertEqual(data["scope"], "user")
        self.assertEqual(data["base"], str(self.fake_agent_dir.resolve()))
        paths = sorted(e["path"] for e in data["entries"])
        self.assertEqual(paths, [
            "agents/gate.md",
            "agents/scout.md",
            "commands/flow.md",
            "skills/leanflow/SKILL.md",
        ])
        for entry in data["entries"]:
            self.assertEqual(entry["state"], "absent")
            self.assertEqual(entry["kind"], "file")

    def test_apply_and_uninstall_symlink(self) -> None:
        env = self._env()
        rc, out, _ = run_installer("--apply", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        # files installed
        for rel in ("commands/flow.md", "agents/scout.md", "agents/gate.md", "skills/leanflow/SKILL.md"):
            target = self.fake_agent_dir / rel
            self.assertTrue(target.is_symlink(), f"{rel} should be a symlink")
            self.assertTrue(target.resolve(strict=True).exists(), f"{rel} link target missing")
        # metadata present
        self.assertTrue((self.fake_agent_dir / "leanflow-install.json").exists())

        # uninstall dry-run
        rc, out, _ = run_installer("--uninstall", "--dry-run", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertEqual(data["action"], "uninstall-dry-run")

        # uninstall apply
        rc, out, _ = run_installer("--uninstall", "--apply", "--scope", "user", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        for rel in ("commands/flow.md", "agents/scout.md", "agents/gate.md", "skills/leanflow/SKILL.md"):
            self.assertFalse((self.fake_agent_dir / rel).exists(), f"{rel} should be removed")
        self.assertFalse((self.fake_agent_dir / "leanflow-install.json").exists())

    def test_apply_copy_mode(self) -> None:
        env = self._env()
        rc, out, _ = run_installer("--apply", "--scope", "user", "--mode", "copy", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])
        for rel in ("commands/flow.md", "agents/scout.md", "agents/gate.md", "skills/leanflow/SKILL.md"):
            target = self.fake_agent_dir / rel
            self.assertTrue(target.is_file(), f"{rel} should be a real file (copy)")
            self.assertFalse(target.is_symlink(), f"{rel} should not be a symlink in copy mode")

        # uninstall
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

    def test_force_replaces_existing(self) -> None:
        env = self._env()
        # first install in copy mode (symlink mode would self-overlap on re-run)
        rc, out, _ = run_installer("--apply", "--scope", "user", "--mode", "copy", env=env)
        self.assertEqual(rc, 0, out)
        # second install without force fails (existing copy targets)
        rc, out, _ = run_installer("--dry-run", "--scope", "user", "--mode", "copy", env=env)
        data = json.loads(out)
        self.assertFalse(data["ok"])
        self.assertIn("force", data.get("error", ""))
        # with force
        rc, out, _ = run_installer("--apply", "--scope", "user", "--mode", "copy", "--force", env=env)
        self.assertEqual(rc, 0, out)
        data = json.loads(out)
        self.assertTrue(data["ok"])


if __name__ == "__main__":
    unittest.main()