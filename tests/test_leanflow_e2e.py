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


class ExtensionRuntimeSmokeTest(unittest.TestCase):
    """Real OMP runtime: extension module discovers, /flow is an extension command.

    A plain markdown /flow cannot enter plan mode (OMP only enters plan mode
    from the /plan builtin or the plan key). The leanflow-bootstrap extension
    registers /flow as an extension command that pre-fills `/plan <prompt>` so
    Enter lands in native plan mode. These tests prove the extension loads and
    the command is registered as an extension command (not just a markdown file).
    """

    def test_extension_module_loads(self) -> None:
        ext = ROOT / "extensions" / "leanflow-bootstrap.ts"
        self.assertTrue(ext.exists(), "leanflow-bootstrap.ts missing")
        text = ext.read_text(encoding="utf-8")
        self.assertIn('registerCommand("flow"', text)
        self.assertIn("setEditorText", text)
        self.assertIn("/plan", text)
        # default export factory
        self.assertRegex(text, r"export default function leanflowBootstrap")

    def test_flow_command_is_extension_command(self) -> None:
        """In interactive TUI mode, the extension command takes priority over
        the markdown file command (OMP command precedence: builtin > skill >
        extension > custom > file). Print mode (omp -p) does not load the
        extension runner, so /flow falls back to the markdown file command
        there — but plan mode itself is TUI-only, so the extension path is the
        one that matters. This test verifies the extension module loads and
        registers /flow; the TUI precedence is verified by reading the OMP
        available-commands source ordering."""
        # Verify the extension factory runs and registers /flow
        out = _bun_eval(
            "import leanflowBootstrap from "
            f"{json.dumps(str(ROOT / 'extensions' / 'leanflow-bootstrap.ts'))};\n"
            "const commands = [];\n"
            "const fakeApi = { registerCommand: (n, o) => commands.push({name:n, hasHandler: typeof o.handler === 'function'}), pi: { settings: { getAgentDir: () => '/tmp' } } };\n"
            "leanflowBootstrap(fakeApi);\n"
            "console.log(JSON.stringify(commands));"
        )
        cmds = json.loads(out)
        self.assertEqual(len(cmds), 1)
        self.assertEqual(cmds[0]["name"], "flow")
        self.assertTrue(cmds[0]["hasHandler"])
        # Verify OMP command precedence puts extension before file
        src = Path(OMP_SRC / "slash-commands" / "available-commands.ts").read_text(encoding="utf-8")
        ext_pos = src.find('source: "extension"')
        file_pos = src.find('source: "file"')
        self.assertGreater(ext_pos, 0)
        self.assertGreater(file_pos, 0)
        self.assertLess(ext_pos, file_pos, "extension commands must register before file commands")
    def test_flow_prefills_plan_mode(self) -> None:
        """The extension pre-fills `/plan <prompt>` — the only OMP mechanism
        to enter native plan mode from an extension."""

        ext = (ROOT / "extensions" / "leanflow-bootstrap.ts").read_text(encoding="utf-8")
        # The handler must set the editor to /plan + rendered prompt
        self.assertIn("setEditorText(`/plan", ext)
        # It must read the flow.md prompt body and render {{ARGUMENTS}}
        self.assertIn("ARGUMENTS_RE", ext)
        self.assertIn("findFlowPrompt", ext)


if __name__ == "__main__":
    unittest.main()