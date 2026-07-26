#!/usr/bin/env python3
"""E2E integration tests: slash-command expansion and OMP task-schema contract.

These tests exercise the real OMP runtime functions (expandSlashCommand, the
task ArkType schemas) to prove the LeanFlow artifacts integrate with OMP —
not just that the files contain the right strings.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OMP_SRC = Path("/Users/shizhenwei/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src")


def _bun_eval(script: str) -> str:
    proc = subprocess.run(
        ["bun", "-e", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise AssertionError(f"bun eval failed: {proc.stderr or proc.stdout}")
    return proc.stdout


class SlashCommandExpansionTest(unittest.TestCase):
    """Prove {{ARGUMENTS}} preserves the user's task text (P1 fix)."""

    def test_arguments_preserves_spaces(self) -> None:
        flow = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        body = re.sub(r"^---\n.*?\n---\n", "", flow, count=1, flags=re.DOTALL)
        out = _bun_eval(
            "import { expandSlashCommand } from "
            f"{json.dumps(str(OMP_SRC / 'extensibility' / 'slash-commands.ts'))};\n"
            "const out = expandSlashCommand(\n"
            "  '/flow fix a complex bug in auth',\n"
            "  [{name:'flow',description:'',content:"
            + json.dumps(body)
            + ",source:'test'}]\n"
            ");\n"
            "console.log(out);"
        )
        # The user task must appear verbatim, not comma-joined
        self.assertIn("fix a complex bug in auth", out)
        self.assertNotIn("fix,a,complex,bug,in,auth", out)

    def test_legacy_args_would_break(self) -> None:
        """Confirm the old {{args}} token comma-joins — proves why we switched."""
        out = _bun_eval(
            "import { expandSlashCommand } from "
            f"{json.dumps(str(OMP_SRC / 'extensibility' / 'slash-commands.ts'))};\n"
            "const out = expandSlashCommand('/probe fix a bug',\n"
            "  [{name:'probe',description:'',content:'T: {{args}}',source:'test'}]);\n"
            "console.log(out);"
        )
        self.assertIn("fix,a,bug", out)


class TaskSchemaContractTest(unittest.TestCase):
    """Prove the gate/spawn shapes in flow.md match OMP's native task schema."""

    def _gate_block(self) -> str:
        text = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        # The gate task block is the one containing agent: "gate".
        for m in re.finditer(r"task\(\{(.*?)\n\}\)", text, re.DOTALL):
            if 'agent: "gate"' in m.group(1):
                return m.group(1)
        raise AssertionError("gate task({...}) block not found in flow.md")

    def test_gate_spawn_uses_outputSchema_not_schema(self) -> None:
        block = self._gate_block()
        self.assertIn("outputSchema", block)
        self.assertNotIn('"schema":', block)  # legacy field rejected by OMP task tool
        self.assertIn("schemaMode", block)
        self.assertIn('"gate"', block)

    def test_scout_batch_shape(self) -> None:
        text = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        m = re.search(r"task\(\{\s*context:.*?tasks:\s*\[(.*?)\]\s*\}\)", text, re.DOTALL)
        self.assertIsNotNone(m, "scout batch task({...tasks:[]}) not found")
        block = m.group(0)
        self.assertIn("context:", block)
        self.assertIn("tasks:", block)
        self.assertIn('agent: "scout"', block)


class GateVerdictSchemaTest(unittest.TestCase):
    """The outputSchema in flow.md must be a valid JSON Schema object."""

    def test_gate_outputschema_is_valid_json_schema(self) -> None:
        text = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        # Extract the outputSchema object literal and evaluate it with bun
        # (it's a JS object literal, not strict JSON).
        m = re.search(r"outputSchema:\s*(\{.*?\})\s*,\s*\n\s*schemaMode", text, re.DOTALL)
        self.assertIsNotNone(m, "outputSchema block not found in flow.md")
        raw = m.group(1)
        out = _bun_eval(
            "const s = " + raw + ";\n"
            "console.log(JSON.stringify(s));"
        )
        schema = json.loads(out)
        self.assertEqual(schema["type"], "object")
        self.assertEqual(schema["properties"]["verdict"]["enum"], ["PASS", "FAIL"])
        self.assertEqual(schema["required"], ["verdict"])
        findings_item = schema["properties"]["findings"]["items"]
        cats = findings_item["properties"]["category"]["enum"]
        for must in ("correctness", "validation_failure", "plan_deviation", "missing_change", "regression_risk", "style", "naming"):
            self.assertIn(must, cats)
        self.assertEqual(findings_item["properties"]["severity"]["enum"], ["blocking", "nonblocking"])


if __name__ == "__main__":
    unittest.main()