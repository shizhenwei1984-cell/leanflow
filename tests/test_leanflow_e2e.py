from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install_leanflow.py"
OMP_SRC = Path("/Users/shizhenwei/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src")


class WorkflowPromptTest(unittest.TestCase):
    def test_flow_prompt_has_no_intermediate_roles(self) -> None:
        text = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        self.assertIn("## PLAN", text)
        self.assertIn("## BUILD", text)
        self.assertIn("## GATE", text)
        self.assertIn("Only three roles exist:", text)
        self.assertIn("Do not spawn:", text)
        self.assertNotIn("repo-reviewer", text)
        self.assertNotIn("AuditRuntimeFeasibility", text)
        self.assertNotIn("AuditExecutionCompleteness", text)
        self.assertNotIn("PlanApprovalAudit", text)
        self.assertEqual(text.count('agent: "scout"'), 1)
        self.assertEqual(text.count('agent: "gate"'), 1)
        self.assertIn("evidence.md", text)
        self.assertIn("Gate has no shell access", text)

    def test_extension_remains_thin_plan_bootstrap(self) -> None:
        text = (ROOT / "extensions" / "leanflow-bootstrap.ts").read_text(encoding="utf-8")
        self.assertIn('registerCommand("flow"', text)
        self.assertIn('setEditorText(`/plan ${rendered}`)', text)
        self.assertIn("Main + optional Scout only", text)
        self.assertNotIn("repo-reviewer", text)
        self.assertNotIn("audit", text.lower())


class InstalledDiscoveryTest(unittest.TestCase):
    def test_user_install_discovers_only_scout_and_gate(self) -> None:
        if not OMP_SRC.exists():
            self.skipTest("OMP source not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            project = root / "project"
            project.mkdir()
            install = subprocess.run([sys.executable, str(INSTALLER), "--scope", "project", "--mode", "copy", "--apply"], cwd=project, env={"HOME": str(home)}, text=True, capture_output=True)
            self.assertEqual(install.returncode, 0, install.stderr)
            script = (
                f"const {{discoverAgents}}=await import({json.dumps(str(OMP_SRC / 'task' / 'discovery.ts'))});"
                f"const result=await discoverAgents({json.dumps(str(project))},{json.dumps(str(home))});"
                "console.log(JSON.stringify(result.agents.filter(a=>['scout','gate','repo-reviewer'].includes(a.name)).map(a=>({name:a.name,tools:a.tools,spawns:a.spawns??null,model:a.model}))));"
            )
            discovered = json.loads(subprocess.check_output(["bun", "-e", script], text=True, cwd=project))
            self.assertEqual([agent["name"] for agent in discovered], ["gate", "scout"])
            by_name = {agent["name"]: agent for agent in discovered}
            self.assertEqual(by_name["scout"]["tools"], ["read", "grep", "glob", "web_search", "yield"])
            self.assertIsNone(by_name["scout"]["spawns"])
            self.assertEqual(by_name["gate"]["tools"], ["read", "grep", "glob", "task", "yield"])
            self.assertEqual(by_name["gate"]["spawns"], ["scout"])


if __name__ == "__main__":
    unittest.main()
