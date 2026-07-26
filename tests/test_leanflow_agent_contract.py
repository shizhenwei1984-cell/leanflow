#!/usr/bin/env python3
"""Contract tests for LeanFlow agent and command frontmatter."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)


def parse_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise AssertionError(f"{path} has no frontmatter")
    fm_text, body = match.group(1), match.group(2)
    fm: dict[str, str] = {}
    for line in fm_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fm[key.strip()] = value.strip().strip('"').strip("'")
    return fm, body


class AgentContractTest(unittest.TestCase):
    def test_scout_frontmatter(self) -> None:
        fm, body = parse_frontmatter(ROOT / "agents" / "scout.md")
        self.assertEqual(fm.get("name"), "scout")
        self.assertEqual(fm.get("model"), "@smol")
        self.assertEqual(fm.get("blocking"), "true")
        tools = {t.strip() for t in fm.get("tools", "").split(",")}
        self.assertIn("read", tools)
        self.assertIn("grep", tools)
        self.assertIn("glob", tools)
        # no write tools
        self.assertNotIn("edit", tools)
        self.assertNotIn("write", tools)
        self.assertNotIn("bash", tools)
        # no spawns/task
        self.assertNotIn("spawns", fm)
        self.assertNotIn("task", fm)
        # body mentions the structured output
        self.assertIn("Files:", body)
        self.assertIn("Symbols:", body)
        self.assertIn("Unknowns:", body)

    def test_gate_frontmatter(self) -> None:
        fm, body = parse_frontmatter(ROOT / "agents" / "gate.md")
        self.assertEqual(fm.get("name"), "gate")
        self.assertEqual(fm.get("model"), "@slow")
        self.assertEqual(fm.get("blocking"), "true")
        tools = {t.strip() for t in fm.get("tools", "").split(",")}
        self.assertIn("read", tools)
        self.assertIn("grep", tools)
        self.assertIn("glob", tools)
        self.assertIn("bash", tools)
        # no write tools
        self.assertNotIn("edit", tools)
        self.assertNotIn("write", tools)
        # no spawns/task
        self.assertNotIn("spawns", fm)
        self.assertNotIn("task", fm)
        # body enforces read-only bash and verdict
        self.assertIn("PASS", body)
        self.assertIn("FAIL", body)

    def test_flow_command(self) -> None:
        path = ROOT / "commands" / "flow.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("{{args}}", text)
        for section in ("PLAN", "BUILD", "GATE", "LOOP"):
            self.assertIn(section, text)
        # single-writer rule present
        self.assertIn("Single writer", text)
        # gate spawn uses the gate agent
        self.assertIn('"gate"', text)
        # scout agent referenced
        self.assertIn('"scout"', text)
        # local:// artifacts
        self.assertIn("local://leanflow/", text)
        # max 2 gate rounds
        self.assertIn("2", text)

    def test_skill_present(self) -> None:
        path = ROOT / "skills" / "leanflow" / "SKILL.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("name: leanflow", text)
        self.assertIn("@plan", text)
        self.assertIn("@smol", text)
        self.assertIn("@slow", text)


if __name__ == "__main__":
    unittest.main()