import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { canonicalGateTask } from "../extensions/leanflow/guard";
import { assessHandoff } from "../extensions/leanflow/handoff";
import leanflow, { resolveRunMarkerPath } from "../extensions/leanflow/index";

type TestContext = {
	hasUI: boolean;
	cwd: string;
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	ui: {
		input: () => Promise<string | undefined>;
		notify: (message: string) => void;
		setEditorText: (text: string) => void;
		setStatus: () => void;
	};
	sessionManager: { getBranch: () => unknown[] };
	localProtocolOptions: { getArtifactsDir: () => string; getSessionId?: () => string };
};

type Harness = {
	branch: unknown[];
	editorTexts: string[];
	notifications: string[];
	commands: Map<string, { handler: (args: string, ctx: TestContext) => Promise<void> }>;
	ctx: TestContext;
	handlers: Map<string, (event: Record<string, unknown>, ctx: TestContext) => Promise<unknown>>;
	states: Record<string, unknown>[];
	tools: Map<string, { execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: TestContext) => Promise<Record<string, unknown>> }>;
};

function createHarness(): Harness {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const branch: unknown[] = [];
	const states: Record<string, unknown>[] = [];
	const editorTexts: string[] = [];
	const notifications: string[] = [];
	const artifactsDir = mkdtempSync(join(tmpdir(), "leanflow-reg-"));
	mkdirSync(join(artifactsDir, "local"), { recursive: true });
	mkdirSync(join(artifactsDir, "work", "src"), { recursive: true });
	writeFileSync(join(artifactsDir, "work", "src", "example.ts"), "export const example = true;\n");
	const ctx: TestContext = {
		hasUI: true,
		cwd: join(artifactsDir, "work"),
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			input: async () => undefined,
			notify: (m: string) => notifications.push(m),
			setEditorText: (t: string) => editorTexts.push(t),
			setStatus: () => {},
		},
		sessionManager: { getBranch: () => branch },
		localProtocolOptions: { getArtifactsDir: () => artifactsDir },
	};
	const pi = {
		zod: { z },
		on: (event: string, handler: unknown) => handlers.set(event, handler as never),
		registerCommand: (name: string, def: unknown) => commands.set(name, def as never),
		registerTool: (def: Record<string, unknown>) => tools.set(def.name as string, def as never),
		exec: async (command: string, args: string[]) => {
			if (command !== "git") return { stdout: "", stderr: `unexpected: ${command}`, code: 127, killed: false };
			if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0, killed: false };
			if (args[0] === "status" || args[0] === "ls-files") return { stdout: "", stderr: "", code: 0, killed: false };
			if (args[0] === "diff" && args.includes("--no-index")) return { stdout: "diff --git a/dev/null b/untracked\n", stderr: "", code: 1, killed: false };
			if (args[0] === "diff") return { stdout: "", stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, code: 2, killed: false };
		},
		appendEntry: (customType: string, state: Record<string, unknown>) => {
			const snap = structuredClone(state);
			states.push(snap);
			branch.push({ type: "custom", customType, data: snap });
		},
	};
	leanflow(pi as never);
	return { branch, commands, ctx, editorTexts, handlers, notifications, states, tools };
}

const EXAMPLE_TASK = "example";
const EXAMPLE_SLUG = `example-${createHash("sha256").update(EXAMPLE_TASK, "utf8").digest("hex").slice(0, 8)}`;
const EXAMPLE_PLAN_ARTIFACT = `local://${EXAMPLE_SLUG}-plan.md`;

function gateArtifacts(slug = EXAMPLE_SLUG) {
	const prefix = `local://${slug}`;
	return { plan: `${prefix}-plan.md`, build: `${prefix}-build.md`, diff: `${prefix}-diff.md`, evidence: `${prefix}-evidence.md` };
}
function gateCallInput(slug = EXAMPLE_SLUG) {
	const artifacts = gateArtifacts(slug);
	return { context: "LeanFlow Gate", tasks: [{ agent: "gate", task: canonicalGateTask(artifacts), schemaMode: "strict" }] };
}
function buildRecordPath(h: Harness) {
	const runId = (h.states.at(-1) as Record<string, string>).runId;
	return resolveRunMarkerPath(h.ctx.localProtocolOptions, `local://.leanflow/runs/${runId}-build-record.json`)!;
}
function runMarkerPath(h: Harness) {
	return resolveRunMarkerPath(h.ctx.localProtocolOptions, (h.states.at(-1) as Record<string, string>).runMarkerArtifact)!;
}
async function writeInitialPlan(h: Harness, content = "Update src/example.ts with the requested behavior and run focused tests.\nLSP applicability: required") {
	await h.commands.get("flow")!.handler(EXAMPLE_TASK, h.ctx);
	const latest = h.states.at(-1) as Record<string, string>;
	const planContent = [content, "## Critical files", "- extensions/leanflow/index.ts", "## Acceptance", "- [ ] Expected behavior must remain observable.", "## Verification", "`bun test tests/leanflow_lsp_guard.test.ts`", "Consider edge cases.", `LeanFlow run ID: ${latest.runId}`].join("\n");
	const planArtifact = `local://${latest.planSlug}-plan.md`;
	await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: "plan", input: { path: planArtifact, content: planContent } }, h.ctx);
	const planFile = resolveRunMarkerPath(h.ctx.localProtocolOptions, planArtifact)!;
	mkdirSync(dirname(planFile), { recursive: true });
	writeFileSync(planFile, planContent);
	await h.handlers.get("tool_result")!({ toolName: "write", toolCallId: "plan", isError: false }, h.ctx);
}
async function enterDocumentationBuild(h: Harness) {
	await writeInitialPlan(h, "Update docs only.\nLSP applicability: not_required");
	await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: "propose-doc-build", input: { path: "xd://propose", content: EXAMPLE_SLUG } }, h.ctx);
	await h.handlers.get("tool_result")!({ toolName: "write", toolCallId: "propose-doc-build", isError: false }, h.ctx);
	h.branch.push({ type: "mode_change", mode: "none" });
	const approvalMessages = [
		{ role: "user", content: "update src/example.ts", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: EXAMPLE_SLUG } }], timestamp: 2 },
		{ role: "developer", content: [{ type: "text", text: `Plan approved.\n<instruction>\nYou MUST read \`${EXAMPLE_PLAN_ARTIFACT}\` before executing.\n</instruction>` }], timestamp: 3 },
	];
	await h.handlers.get("context")!({ messages: approvalMessages }, h.ctx);
}
async function executeRegisteredTool(h: Harness, name: string, params: Record<string, unknown>, toolCallId = `${name}-${h.states.length}`) {
	const guard = await h.handlers.get("tool_call")!({ toolName: name, toolCallId, input: params }, h.ctx);
	if (guard && typeof guard === "object" && "block" in guard && (guard as Record<string, unknown>).block === true) throw new Error(`blocked: ${JSON.stringify(guard)}`);
	return h.tools.get(name)!.execute(toolCallId, params, undefined, undefined, h.ctx);
}
async function recordSuccessfulValidation(h: Harness, command: string, output = "1 pass\n0 fail\nRan 1 test.") {
	const toolCallId = `validation-${h.states.length}`;
	await h.handlers.get("tool_call")!({ toolName: "bash", toolCallId, input: { command } }, h.ctx);
	await h.handlers.get("tool_result")!({ toolName: "bash", toolCallId, isError: false, details: {}, content: [{ type: "text", text: output }] }, h.ctx);
}
async function completeBuildEvidence(h: Harness, command = "bun test tests/*.test.ts") {
	const st = h.states.at(-1) as Record<string, unknown>;
	if (st.baselineCaptured !== true) {
		const cap = await executeRegisteredTool(h, "leanflow_capture_baseline", {});
		if ((cap as Record<string, unknown>).isError) throw new Error(`baseline failed: ${JSON.stringify(cap)}`);
	}
	await recordSuccessfulValidation(h, command);
	const fin = await executeRegisteredTool(h, "leanflow_finalize_artifacts", { validationCommands: [command] });
	if ((fin as Record<string, unknown>).isError) throw new Error(`finalize failed: ${JSON.stringify(fin)}`);
}

const approvalMessagesFor = (slug: string, planArtifact: string) => [
	{ role: "user", content: "update src/example.ts", timestamp: 1 },
	{ role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: slug } }], timestamp: 2 },
	{ role: "developer", content: [{ type: "text", text: `Plan approved.\n<instruction>\nYou MUST read \`${planArtifact}\` before executing.</instruction>` }], timestamp: 3 },
];
const approvalMessages = approvalMessagesFor(EXAMPLE_SLUG, EXAMPLE_PLAN_ARTIFACT);

test("P0: FAILx2 → flowcontinue → edit → validate → finalize → Gate", async () => {
	const h = createHarness();
	await writeInitialPlan(h, "Update docs only.\nLSP applicability: not_required");
	await h.handlers.get("tool_call")!({ toolName: "write", toolCallId: "propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } }, h.ctx);
	await h.handlers.get("tool_result")!({ toolName: "write", toolCallId: "propose", isError: false }, h.ctx);
	h.branch.push({ type: "mode_change", mode: "none" });
	await h.handlers.get("context")!({ messages: approvalMessages }, h.ctx);
	await completeBuildEvidence(h, "bun test p0-1");
	for (const attempt of [1, 2]) {
		await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: `gate-fail-${attempt}`, input: gateCallInput() }, h.ctx);
		await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: `gate-fail-${attempt}`, isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [{ severity: "blocking" }] }) }] }, h.ctx);
		if (attempt === 1) await completeBuildEvidence(h, "bun test p0-2");
	}
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("awaiting_human");
	await h.commands.get("flowcontinue")!.handler("repair", h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("building");
	const editGuard = await h.handlers.get("tool_call")!({ toolName: "edit", toolCallId: "p0-edit", input: { path: "src/example.ts" } }, h.ctx);
	expect(editGuard).toBeUndefined();
	await h.handlers.get("tool_result")!({ toolName: "edit", toolCallId: "p0-edit", isError: false }, h.ctx);
	await completeBuildEvidence(h, "bun test p0-repair");
	expect((h.states.at(-1) as Record<string, unknown>).writtenArtifacts).toEqual(expect.arrayContaining(["build", "diff", "evidence"]));
	const gateGuard = await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "p0-gate", input: gateCallInput() }, h.ctx);
	expect(gateGuard).toBeUndefined();
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("gating");
});

test("P1: 4x operational error → awaiting_human → flowcontinue → edit", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test op-1");
	for (let i = 1; i <= 4; i++) {
		await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: `op-gate-${i}`, input: gateCallInput() }, h.ctx);
		await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: `op-gate-${i}`, isError: true, content: [{ type: "text", text: "error" }] }, h.ctx);
		if (i < 4) expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("building");
	}
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("awaiting_human");
	await h.commands.get("flowcontinue")!.handler("fix op", h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("building");
	const g = await h.handlers.get("tool_call")!({ toolName: "edit", toolCallId: "op-edit", input: { path: "src/example.ts" } }, h.ctx);
	expect(g).toBeUndefined();
});

test("P1: Gate dispatch → delete evidence → PASS discarded", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test snap-1");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "snap-gate", input: gateCallInput() }, h.ctx);
	const artifacts = gateArtifacts();
	const evidencePath = resolveRunMarkerPath(h.ctx.localProtocolOptions, artifacts.evidence)!;
	rmSync(evidencePath);
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "snap-gate", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }] }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("building");
	expect((h.states.at(-1) as Record<string, unknown>).gateCalls).toBe(0);
	expect(h.notifications.some((m) => m.includes("Gate result was discarded"))).toBe(true);
});

test("P1: Gate dispatch → empty diff → PASS discarded", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test snap-2");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "snap-gate2", input: gateCallInput() }, h.ctx);
	const artifacts = gateArtifacts();
	const diffPath = resolveRunMarkerPath(h.ctx.localProtocolOptions, artifacts.diff)!;
	writeFileSync(diffPath, "");
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "snap-gate2", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "PASS" }) }] }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).gateCalls).toBe(0);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("building");
});

test("P1: Gate dispatch → corrupt BUILD record → PASS discarded", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test snap-3");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "snap-gate3", input: gateCallInput() }, h.ctx);
	const rp = buildRecordPath(h);
	const rec = JSON.parse(readFileSync(rp, "utf8"));
	writeFileSync(rp, JSON.stringify({ ...rec, round: 99 }));
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "snap-gate3", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "PASS" }) }] }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).gateCalls).toBe(0);
});

test("P1: Gate dispatch → artifact without runId → PASS discarded", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test snap-4");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "snap-gate4", input: gateCallInput() }, h.ctx);
	const artifacts = gateArtifacts();
	const buildPath = resolveRunMarkerPath(h.ctx.localProtocolOptions, artifacts.build)!;
	let content = readFileSync(buildPath, "utf8");
	const runId = (h.states.at(-1) as Record<string, string>).runId;
	content = content.split(runId).join("00000000-0000-4000-8000-000000000000");
	writeFileSync(buildPath, content);
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "snap-gate4", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "PASS" }) }] }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).gateCalls).toBe(0);
});

test("P1-2: restore reconciles building with actual record round", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test recon-1");
	const before = h.states.at(-1) as Record<string, unknown>;
	const rec = JSON.parse(readFileSync(buildRecordPath(h), "utf8"));
	expect(rec.round).toBe(1);
	await h.handlers.get("session_switch")!({}, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("building");
});

test("P1-3: repair_preparing crash recovery via restore", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test crash-1");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "crash-gate", input: gateCallInput() }, h.ctx);
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "crash-gate", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [] }) }] }, h.ctx);
	const st = h.states.at(-1) as Record<string, unknown>;
	expect(st.phase).toBe("building");
	expect(readFileSync(buildRecordPath(h), "utf8")).toContain(`"round":2`);
});

test("P2-1: gating without lease → restore self-heals", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test lease-1");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "lease-gate", input: gateCallInput() }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("gating");
	const last = h.states.at(-1) as Record<string, unknown>;
	const branch = h.branch;
	const corruptedGating = structuredClone(last) as Record<string, unknown>;
	corruptedGating.phase = "gating";
	corruptedGating.stateVersion = 3;
	delete corruptedGating.gateLease;
	branch.push({ type: "custom", customType: "leanflow-state", data: corruptedGating });
	await h.handlers.get("session_switch")!({}, h.ctx);
	const after = h.states.at(-1) as Record<string, unknown>;
	expect(after.phase).toBe("building");
	expect(after.gateRetryMode).toBe("operational");
});

test("P2-2: TBD placeholder handoff → NEEDS_UPDATE", () => {
	const plan = [
		"## Critical files",
		"- N/A / decide later",
		"## Implementation",
		"- Update behavior.",
		"## Acceptance",
		"- [ ] TBD",
		"## Verification",
		"```sh",
		"TBD",
		"```",
	].join("\n");
	const result = assessHandoff(plan);
	expect(result.status).toBe("NEEDS_UPDATE");
	expect(result.blockers.map((b) => b.code)).toContain("TARGET_MISSING");
	expect(result.blockers.map((b) => b.code)).toContain("ACCEPTANCE_MISSING");
	expect(result.blockers.map((b) => b.code)).toContain("VERIFICATION_MISSING");
});

test("P2-2: real target still passes", () => {
	const plan = [
		"## Critical files",
		"- extensions/leanflow/index.ts",
		"## Implementation",
		"- Update behavior in the handler.",
		"## Acceptance",
		"- [ ] Expected behavior must remain observable.",
		"## Verification",
		"```sh",
		"bun test tests/leanflow_lsp_guard.test.ts",
		"```",
		"Consider edge cases.",
		"Additional detail line 1",
		"Additional detail line 2",
		"Additional detail line 3",
		"Additional detail line 4",
		"Additional detail line 5",
		"Additional detail line 6",
		"Additional detail line 7",
		"Additional detail line 8",
		"Additional detail line 9",
		"Additional detail line 10",
		"Additional detail line 11",
		"Additional detail line 12",
		"Additional detail line 13",
		"Additional detail line 14",
		"Additional detail line 15",
		"Additional detail line 16",
		"Additional detail line 17",
		"Additional detail line 18",
		"Additional detail line 19",
		"Additional detail line 20",
		"Additional detail line 21",
	].join("\n");
	const result = assessHandoff(plan);
	expect(result.blockers.map((b) => b.code)).not.toContain("TARGET_MISSING");
	expect(result.blockers.map((b) => b.code)).not.toContain("ACCEPTANCE_MISSING");
	expect(result.blockers.map((b) => b.code)).not.toContain("VERIFICATION_MISSING");
});

test("P0: snapshot fail-closed telemetry not string-matched", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test snap-tel");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "snap-tel-gate", input: gateCallInput() }, h.ctx);
	const rp = buildRecordPath(h);
	writeFileSync(rp, "{}");
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "snap-tel-gate", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "PASS" }) }] }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).gateCalls).toBe(0);
	expect(h.notifications.some((m) => m.includes("Gate result was discarded"))).toBe(true);
});

test("P1: repair setup failure via snapshot fail-closed → awaiting_human", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test repair-fail-closed");
	await h.handlers.get("tool_call")!({ toolName: "task", toolCallId: "repair-fail-gate", input: gateCallInput() }, h.ctx);
	const rp = buildRecordPath(h);
	rmSync(rp);
	mkdirSync(rp);
	await h.handlers.get("tool_result")!({ toolName: "task", toolCallId: "repair-fail-gate", isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [] }) }] }, h.ctx);
	expect((h.states.at(-1) as Record<string, unknown>).phase).toBe("awaiting_human");
});
