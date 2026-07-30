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

    def test_flow_requires_chinese_user_communication(self) -> None:
        text = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        self.assertIn("## USER LANGUAGE", text)
        self.assertIn("All communication addressed to the user MUST be in Simplified Chinese.", text)
        self.assertIn("`ask` questions, option labels and descriptions", text)
        self.assertIn("canonical plan shown for approval", text)
        self.assertIn("Write the decision-complete canonical plan in Simplified Chinese", text)

    def test_extension_has_state_machine_and_guard(self) -> None:
        ext_dir = ROOT / "extensions" / "leanflow"
        self.assertTrue(ext_dir.is_dir())
        index = (ext_dir / "index.ts").read_text(encoding="utf-8")
        self.assertIn('registerCommand("flow"', index)
        self.assertIn("setEditorText(`/plan ${prompt}`)", index)
        self.assertIn("tool_call", index)
        self.assertIn("tool_result", index)
        self.assertIn("context", index)
        self.assertIn("appendEntry", index)
        self.assertNotIn("repo-reviewer", index)
        guard = (ext_dir / "guard.ts").read_text(encoding="utf-8")
        self.assertIn("FORBIDDEN_PATTERN", guard)
        self.assertIn("checkTaskGuard", guard)
        state = (ext_dir / "state.ts").read_text(encoding="utf-8")
        self.assertIn("LeanFlowPhase", state)
        self.assertIn("restoreState", state)
        handoff = (ext_dir / "handoff.ts").read_text(encoding="utf-8")
        self.assertIn("READY_WITH_WARNINGS", handoff)
        self.assertIn("NEEDS_UPDATE", handoff)
        context = (ext_dir / "context.ts").read_text(encoding="utf-8")
        self.assertIn("filterForBuilder", context)

    def test_plan_write_does_not_skip_approval(self) -> None:
        """Issue 1: writing the plan must move to awaiting_approval, not building."""
        state = (ROOT / "extensions" / "leanflow" / "state.ts").read_text(encoding="utf-8")
        self.assertIn('"awaiting_approval"', state)
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        # Plan write transitions through the single phase helper to awaiting approval.
        self.assertIn('transitionPhase(state, "awaiting_approval")', index)
        # Building begins only on a post-approval build action.
        self.assertIn("isBuildAction", index)
        self.assertIn("BUILD_ACTION_TOOLS", index)

    def test_planner_prompt_has_no_gate_schema(self) -> None:
        """Issue 6: the Planner-only prompt must not leak the Gate JSON schema."""
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        # Split out the planner prompt builder body.
        start = index.index("function buildPlanningPrompt")
        end = index.index("function extractVerdict")
        planner = index[start:end]
        self.assertNotIn("outputSchema", planner)
        self.assertNotIn('"verdict"', planner)
        self.assertNotIn('agent: "gate"', planner)
        # The Gate schema lives in the builder preamble instead.
        context = (ROOT / "extensions" / "leanflow" / "context.ts").read_text(encoding="utf-8")
        self.assertIn("outputSchema", context)

    def test_guard_uses_agent_alias_table(self) -> None:
        """Issue 2: agent names resolve through an alias table, not hardcoding."""
        guard = (ROOT / "extensions" / "leanflow" / "guard.ts").read_text(encoding="utf-8")
        self.assertIn("LEANFLOW_AGENTS", guard)
        self.assertIn("resolveRole", guard)
        self.assertIn('"lean-scout"', guard)

    def test_gate_attempt_is_tracked(self) -> None:
        """Issue 3: first vs repair gate are distinguished via gateAttempt."""
        state = (ROOT / "extensions" / "leanflow" / "state.ts").read_text(encoding="utf-8")
        self.assertIn("gateAttempt", state)
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        self.assertIn("state.gateAttempt++", index)

    def test_context_filter_uses_stored_boundary(self) -> None:
        """Issue 5: context filter uses state.approvalBoundary, not message scan."""
        state = (ROOT / "extensions" / "leanflow" / "state.ts").read_text(encoding="utf-8")
        self.assertIn("approvalBoundary", state)
        context = (ROOT / "extensions" / "leanflow" / "context.ts").read_text(encoding="utf-8")
        self.assertIn("state.approvalBoundary", context)

    def test_gate_requires_build_evidence(self) -> None:
        """P1: Gate is blocked until build/diff/evidence artifacts are written."""
        state = (ROOT / "extensions" / "leanflow" / "state.ts").read_text(encoding="utf-8")
        self.assertIn("writtenArtifacts", state)
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        self.assertIn("missingArtifacts", index)
        self.assertIn("Gate unavailable", index)
        self.assertIn("REQUIRED_ARTIFACTS", index)
        # Repair round resets evidence so it must be refreshed before re-gating.
        self.assertIn("state.writtenArtifacts = []", index)

    def test_lsp_is_not_a_build_action(self) -> None:
        """P2: LSP reads must not trigger the building phase."""
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        actions = index[index.index("const BUILD_ACTION_TOOLS") : index.index("export default function")]
        self.assertIn("edit: true", actions)
        self.assertIn("bash: true", actions)
        self.assertIn("ast_edit: true", actions)
        self.assertNotIn("lsp:", actions)

    def test_planner_prompt_has_no_gate_reference(self) -> None:
        """P2: the Planner prompt excludes Gate calls while retaining LSP guidance."""
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        start = index.index("function buildPlanningPrompt")
        # Bound to the planner function body only (exclude later helpers/comments).
        end = index.index('].join("\\n");', start)
        planner = index[start:end]
        self.assertNotIn("Gate", planner)
        self.assertIn("LSP symbol references", planner)
        self.assertIn("build.md", planner)
        self.assertIn("evidence.md", planner)

    def test_runtime_stats_are_tracked(self) -> None:
        """Per-phase metrics and distinct context-filter measures are wired."""
        ext_dir = ROOT / "extensions" / "leanflow"
        stats = (ext_dir / "stats.ts").read_text(encoding="utf-8")
        self.assertIn("addUsage", stats)
        self.assertIn("transitionPhase", stats)
        self.assertIn("recordContextFilter", stats)
        self.assertIn("stableSerialize", stats)
        self.assertIn("formatStats", stats)
        # Honest accounting: subagent tokens are explicitly NOT fabricated.
        self.assertIn("separate subagent sessions", stats)
        state = (ext_dir / "state.ts").read_text(encoding="utf-8")
        self.assertIn("LeanFlowStats", state)
        self.assertIn("awaitingApproval", state)
        self.assertIn("phaseStartedAt", state)
        index = (ext_dir / "index.ts").read_text(encoding="utf-8")
        self.assertIn("message_end", index)
        self.assertIn("addUsage(state", index)
        self.assertIn("recordContextFilter(state", index)
        self.assertIn('registerCommand("flowstats"', index)

    def test_stats_track_distinct_gate_outcomes(self) -> None:
        """Gate verdicts, execution errors, repairs, and terminals stay separate."""
        ext_dir = ROOT / "extensions" / "leanflow"
        state = (ext_dir / "state.ts").read_text(encoding="utf-8")
        for counter in (
            "gatePasses",
            "gateVerdictFailures",
            "gateErrors",
            "gateReadinessBlocks",
            "repairRounds",
            "repairSuccesses",
            "terminalFailures",
        ):
            self.assertIn(counter, state)
        stats = (ext_dir / "stats.ts").read_text(encoding="utf-8")
        self.assertIn("recordGateFailure", stats)
        self.assertIn("recordGateError", stats)
        self.assertIn("recordGateReadinessBlock", stats)
        index = (ext_dir / "index.ts").read_text(encoding="utf-8")
        self.assertIn("recordGateFailure(state", index)
        self.assertIn("recordGateError(state", index)

    def test_gate_readiness_precedes_attempt_increment(self) -> None:
        """Missing artifacts block before an attempt is counted."""
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        readiness = index.index("const missing = missingArtifacts(state)")
        increment = index.index("state.gateCalls++", readiness)
        self.assertLess(readiness, increment)

    def test_task_role_budgets_preflight_before_mutation(self) -> None:
        """Exact requested role counts are preflighted before state mutation."""
        guard = (ROOT / "extensions" / "leanflow" / "guard.ts").read_text(encoding="utf-8")
        self.assertIn("extractAgentRoles", guard)
        self.assertIn("checkAgentBudget", guard)
        self.assertIn("exactly one Gate", guard)
        self.assertIn("!allowed.includes(role)", guard)
        index = (ROOT / "extensions" / "leanflow" / "index.ts").read_text(encoding="utf-8")
        preflight = index.index("const budget = checkAgentBudget")
        scout_increment = index.index("state.scoutCalls += scoutCount")
        gate_increment = index.index("state.gateCalls++", scout_increment)
        self.assertLess(preflight, scout_increment)
        self.assertLess(preflight, gate_increment)

    def test_stats_keep_token_measurements_honest(self) -> None:
        """Message and byte reductions are never called provider token reductions."""
        stats = (ROOT / "extensions" / "leanflow" / "stats.ts").read_text(encoding="utf-8")
        self.assertIn("Message-count reduction", stats)
        self.assertIn("latest serialized bytes (KiB)", stats)
        self.assertIn("provider token reduction: not measured", stats)

    def test_lsp_capability_and_fallback_are_explicit(self) -> None:
        """Configured LSP detection is comprehensive, attempted, and non-blocking."""
        config = json.loads((ROOT / ".lsp.json").read_text(encoding="utf-8"))
        typescript = config["servers"]["typescript"]
        self.assertEqual(typescript["command"], "typescript-language-server")
        self.assertEqual(typescript["args"], ["--stdio"])
        self.assertIn(".git", typescript["rootMarkers"])
        self.assertNotIn(".lsp.json", (ROOT / "scripts" / "install_leanflow.py").read_text(encoding="utf-8"))

        flow = (ROOT / "commands" / "flow.md").read_text(encoding="utf-8")
        context = (ROOT / "extensions" / "leanflow" / "context.ts").read_text(encoding="utf-8")
        docs = (ROOT / "docs" / "leanflow.md").read_text(encoding="utf-8")
        self.assertIn("runtime probe is the authoritative LSP configuration detector", flow)
        self.assertIn("Before Baseline HEAD", flow)
        self.assertIn("A completed probe with `no server`", docs)
        self.assertIn("Before Baseline HEAD", context)
        gate = (ROOT / "agents" / "gate.md").read_text(encoding="utf-8")
        self.assertIn("initial LSP diagnostics probe result", gate)
        self.assertIn("blocking `validation_failure`", gate)


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
