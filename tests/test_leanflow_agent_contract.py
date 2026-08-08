from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def frontmatter(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8")
    raw, body = text.split("---\n", 2)[1:]
    values = {}
    for line in raw.splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, value = line.split(":", 1)
            values[key] = value.strip().strip('"')
    return values, body


class MinimalRoleContractTest(unittest.TestCase):
    def test_only_scout_and_gate_agent_files_exist(self) -> None:
        self.assertEqual(sorted(path.name for path in (ROOT / "agents").glob("*.md")), ["gate.md", "scout.md"])

    def test_scout_is_a_leaf_fact_finder(self) -> None:
        metadata, body = frontmatter(ROOT / "agents" / "scout.md")
        self.assertEqual(metadata["name"], "scout")
        self.assertEqual(metadata["model"], "@smol")
        self.assertEqual(metadata["tools"], "read, grep, glob, web_search")
        self.assertNotIn("spawns", metadata)
        for required in ("Facts:", "Files:", "Sources:", "Unknowns:", "do not write plans", "return PASS/FAIL", "spawn agents"):
            self.assertIn(required, body)
        self.assertEqual(body.count("yield(result:"), 1)

    def test_gate_is_the_only_independent_reviewer(self) -> None:
        metadata, body = frontmatter(ROOT / "agents" / "gate.md")
        self.assertEqual(metadata["name"], "gate")
        self.assertEqual(metadata["model"], "@slow")
        self.assertEqual(metadata["tools"], "read, grep, glob, task")
        self.assertEqual(metadata["spawns"], "scout")
        self.assertIn("output", metadata)
        self.assertIn("agent-owned strict schema", body)
        self.assertNotIn("caller-provided strict schema", body)
        self.assertIn("Do not call any reviewer, auditor, validator, planner, or implementer.", body)
        self.assertIn("only independent reviewer", body)
        self.assertIn("at most once per Gate call", body)
        self.assertIn("no shell access", body)
        self.assertIn("evidence.md", body)
        self.assertIn("never runs shell commands", body)
        self.assertIn("BLOCKED", body)
        self.assertIn("BLOCKED is not an implementation failure", body)

    def test_flow_has_only_three_agent_roles(self) -> None:
        text = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        self.assertIn("## LEANFLOW ROLE POLICY", text)
        self.assertIn("Only three roles exist:", text)
        self.assertIn("Planner and Builder are the same Main Session", text)
        self.assertIn('agent: "scout"', text)
        self.assertIn('agent: "gate"', text)
        self.assertNotIn("repo-reviewer", text)
        self.assertNotRegex(text, r'agent:\s*"[^"]*(?:review|audit|implementer|builder)[^"]*"')
        self.assertIn("at most **3 Scout + 1 Gate**", text)
        self.assertIn("at most **3 Scout + 2 Gate**", text)
        self.assertIn("evidence.md", text)
        self.assertIn("Gate has no shell access", text)
        self.assertIn("/flowcontinue", text)
        self.assertIn("/flowfinishfailed", text)

    def test_docs_and_skill_describe_minimal_architecture(self) -> None:
        for path in (ROOT / "skills" / "leanflow" / "SKILL.md", ROOT / "docs" / "leanflow.md"):
            text = path.read_text(encoding="utf-8")
            self.assertIn("Planner", text)
            self.assertIn("Scout", text)
            self.assertIn("Builder", text)
            self.assertIn("Gate", text)
            self.assertNotIn("Repo Reviewer", text)
            self.assertNotIn("repo-reviewer", text)
            self.assertIn("evidence.md", text)


if __name__ == "__main__":
    unittest.main()
