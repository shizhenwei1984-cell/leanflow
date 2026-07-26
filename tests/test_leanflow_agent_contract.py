#!/usr/bin/env python3
"""Contract tests for LeanFlow agent and command frontmatter."""

from __future__ import annotations

import re
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


def tools_set(fm: dict[str, str]) -> set[str]:
    return {t.strip() for t in fm.get("tools", "").split(",") if t.strip()}


class AgentContractTest(unittest.TestCase):
    def test_scout_frontmatter_readonly(self) -> None:
        fm, body = parse_frontmatter(ROOT / "agents" / "scout.md")
        self.assertEqual(fm.get("name"), "scout")
        self.assertEqual(fm.get("model"), "@smol")
        self.assertEqual(fm.get("blocking"), "true")
        tools = tools_set(fm)
        self.assertEqual(tools, {"read", "grep", "glob"})
        # no write/exec/lsp tools — mechanically read-only per OMP READ_ONLY_TOOL_NAMES
        self.assertNotIn("edit", tools)
        self.assertNotIn("write", tools)
        self.assertNotIn("bash", tools)
        self.assertNotIn("lsp", tools)
        self.assertNotIn("spawns", fm)
        self.assertNotIn("task", fm)
        # body mentions the structured output
        self.assertIn("Files:", body)
        self.assertIn("Symbols:", body)
        self.assertIn("Unknowns:", body)

    def test_gate_frontmatter_readonly(self) -> None:
        fm, body = parse_frontmatter(ROOT / "agents" / "gate.md")
        self.assertEqual(fm.get("name"), "gate")
        self.assertEqual(fm.get("model"), "@slow")
        self.assertEqual(fm.get("blocking"), "true")
        tools = tools_set(fm)
        self.assertEqual(tools, {"read", "grep", "glob"})
        # no write/exec tools — mechanically read-only, cannot run git or tests
        self.assertNotIn("edit", tools)
        self.assertNotIn("write", tools)
        self.assertNotIn("bash", tools)
        self.assertNotIn("lsp", tools)
        self.assertNotIn("spawns", fm)
        self.assertNotIn("task", fm)
        self.assertIn("PASS", body)
        self.assertIn("FAIL", body)

    def test_flow_command_native_plan_mode(self) -> None:
        path = ROOT / "commands" / "flow.md"
        text = path.read_text(encoding="utf-8")
        # correct arg token ({{args}} would comma-join words)
        self.assertIn("{{ARGUMENTS}}", text)
        self.assertNotIn("{{args}}", text)
        for section in ("PLAN", "BUILD", "GATE", "LOOP"):
            self.assertIn(section, text)
        # native plan mode integration
        self.assertIn("plan mode", text.lower())
        self.assertIn("local://<slug>-plan.md", text)  # canonical plan artifact
        self.assertIn("xd://propose", text)  # native approval path
        # native task tool, not eval agent()
        self.assertIn("task({", text)
        self.assertIn("outputSchema", text)
        self.assertNotIn('"schema":', text)  # legacy field rejected by OMP
        # gate reads diff artifact, does not run git
        self.assertIn("local://<slug>-diff.md", text)
        # scout batch form
        self.assertIn("agent: \"scout\"", text)
        # single-writer rule present
        self.assertIn("Single writer", text)
        # max 2 gate calls
        self.assertIn("2 gate calls", text)
        # role check
        self.assertIn("Role check", text)

    def test_flow_scout_batch_form(self) -> None:
        path = ROOT / "commands" / "flow.md"
        text = path.read_text(encoding="utf-8")
        # scout spawn uses native task batch with context + tasks
        self.assertIn("context:", text)
        self.assertIn("tasks:", text)
        self.assertIn("agent: \"scout\"", text)
        # max 3 scouts total per run
        self.assertIn("3", text)

    def test_skill_rationale_not_lifecycle_dup(self) -> None:
        path = ROOT / "skills" / "leanflow" / "SKILL.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("name: leanflow", text)
        self.assertIn("@plan", text)
        self.assertIn("@smol", text)
        self.assertIn("@slow", text)
        # rationale present
        self.assertIn("Why the Planner is the main session", text)
        self.assertIn("Why the Gate must be independent", text)
        # skill defers lifecycle to /flow, does not duplicate step-by-step
        self.assertIn("authoritative instruction set", text)


if __name__ == "__main__":
    unittest.main()