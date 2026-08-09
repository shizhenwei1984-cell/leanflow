import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { canonicalGateTask } from "../extensions/leanflow/guard";
import { assessHandoff } from "../extensions/leanflow/handoff";
import { checkInvariants } from "../extensions/leanflow/machine";
import leanflow, { resolveRunMarkerPath } from "../extensions/leanflow/index";

// Liveness coverage for the 3b0fbfe follow-up plan §4: every fail-closed path
// must also expose a typed, verifiable recovery path.

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
	const artifactsDir = mkdtempSync(join(tmpdir(), "leanflow-live-"));
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
function lastState(h: Harness): Record<string, unknown> {
	return h.states.at(-1) as Record<string, unknown>;
}
function gatePass(h: Harness, toolCallId: string) {
	return h.handlers.get("tool_result")!(
		{ toolName: "task", toolCallId, isError: false, content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }] },
		h.ctx,
	);
}
function gateFail(h: Harness, toolCallId: string) {
	return h.handlers.get("tool_result")!(
		{
			toolName: "task",
			toolCallId,
			isError: false,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						verdict: "FAIL",
						findings: [
							{
								category: "correctness",
								severity: "blocking",
								file: "src/example.ts",
								location: "1",
								issue: "Required behavior is missing.",
								required_fix: "Implement the required behavior.",
							},
						],
					}),
				},
			],
		},
		h.ctx,
	);
}
async function dispatchGate(h: Harness, toolCallId: string) {
	const guard = await h.handlers.get("tool_call")!({ toolName: "task", toolCallId, input: gateCallInput() }, h.ctx);
	if (guard && typeof guard === "object" && "block" in guard && (guard as Record<string, unknown>).block === true) {
		throw new Error(`gate dispatch blocked: ${JSON.stringify(guard)}`);
	}
}

async function writeInitialPlan(h: Harness, content = "Update src/example.ts with the requested behavior and run focused tests.\nLSP applicability: not_required") {
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
		{ role: "developer", content: [{ type: "text", text: `Plan approved.\n<instruction>\nYou MUST read \`${EXAMPLE_PLAN_ARTIFACT}\` before executing.</instruction>` }], timestamp: 3 },
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
	const guard = await h.handlers.get("tool_call")!({ toolName: "bash", toolCallId, input: { command } }, h.ctx);
	if (guard && typeof guard === "object" && "block" in guard && (guard as Record<string, unknown>).block === true) throw new Error(`validation blocked: ${JSON.stringify(guard)}`);
	await h.handlers.get("tool_result")!({ toolName: "bash", toolCallId, isError: false, details: {}, content: [{ type: "text", text: output }] }, h.ctx);
}
async function completeBuildEvidence(h: Harness, command = "bun test tests/*.test.ts") {
	const st = lastState(h);
	if (st.baselineCaptured !== true) {
		const cap = await executeRegisteredTool(h, "leanflow_capture_baseline", {});
		if ((cap as Record<string, unknown>).isError) throw new Error(`baseline failed: ${JSON.stringify(cap)}`);
	}
	await recordSuccessfulValidation(h, command);
	const fin = await executeRegisteredTool(h, "leanflow_finalize_artifacts", { validationCommands: [command] });
	if ((fin as Record<string, unknown>).isError) throw new Error(`finalize failed: ${JSON.stringify(fin)}`);
}

/** Persist a crafted state as the latest entry, then replay session restore. */
async function restoreFromCrafted(h: Harness, mutate: (state: Record<string, unknown>) => void) {
	const crafted = structuredClone(lastState(h));
	mutate(crafted);
	h.branch.push({ type: "custom", customType: "leanflow-state", data: crafted });
	await h.handlers.get("session_switch")!({}, h.ctx);
}

test("liveness 1: deleted evidence accepts a recorded validation and re-gates to PASS", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test tests/leanflow_lsp_guard.test.ts");
	await dispatchGate(h, "live-gate-1");
	rmSync(resolveRunMarkerPath(h.ctx.localProtocolOptions, gateArtifacts().evidence)!);

	await gatePass(h, "live-gate-1");
	expect(lastState(h).phase).toBe("building");
	expect(lastState(h).gateRetryMode).toBe("evidence");
	expect(lastState(h).gateCalls).toBe(0);
	expect(lastState(h).writtenArtifacts).toEqual([]);
	expect(h.notifications.some((m) => m.includes("Gate result was discarded"))).toBe(true);

	const curlGuard = await h.handlers.get("tool_call")!(
		{ toolName: "bash", toolCallId: "unrecorded-curl", input: { command: "curl https://example.com" } },
		h.ctx,
	);
	expect(curlGuard).toMatchObject({ block: true });

	// Evidence mode may rerun a successful command from this round, but not
	// unrelated shell commands.
	await completeBuildEvidence(h, "bun test tests/leanflow_lsp_guard.test.ts");
	expect(lastState(h).writtenArtifacts).toEqual(expect.arrayContaining(["build", "diff", "evidence"]));
	await dispatchGate(h, "live-gate-2");
	await gatePass(h, "live-gate-2");
	expect(lastState(h).phase).toBe("finalizing");
	expect(lastState(h).terminalOutcome).toBe("pass");
});

test("liveness 2: corrupt BUILD record recovers through a self-contained /flowcontinue", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-two");
	await dispatchGate(h, "live-gate-record");
	const rp = buildRecordPath(h);
	writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), round: 99 }));

	await gatePass(h, "live-gate-record");
	expect(lastState(h).phase).toBe("awaiting_human");
	expect(lastState(h).gateCalls).toBe(0);
	expect(JSON.parse(readFileSync(runMarkerPath(h), "utf8")).status).toBe("paused");

	// /flowcontinue recreates the damaged record and re-enforces capture-first.
	await h.commands.get("flowcontinue")!.handler("repair after record recovery", h.ctx);
	expect(lastState(h).phase).toBe("building");
	expect(lastState(h).gateRetryMode).toBe("repair");
	expect(lastState(h).baselineCaptured).toBeFalsy();
	await completeBuildEvidence(h, "bun test live-two-repair");
	await dispatchGate(h, "live-gate-record-repair");
	await gatePass(h, "live-gate-record-repair");
	expect(lastState(h).phase).toBe("finalizing");
});

test("liveness 3: crash window A (lease persisted, record still round 1) replays to a working BUILD", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-three");
	expect(JSON.parse(readFileSync(buildRecordPath(h), "utf8")).round).toBe(1);

	await restoreFromCrafted(h, (crafted) => {
		crafted.phase = "repair_preparing";
		crafted.gateAttempt = 1;
		crafted.gateCalls = 1;
		crafted.gateRetryMode = "repair";
		crafted.repairLease = { fromRound: 1, toRound: 2, reason: "gate_fail", startedAt: Date.now() };
		crafted.writtenArtifacts = [];
		crafted.stateVersion = 3;
		delete crafted.gateLease;
	});

	expect(lastState(h).phase).toBe("building");
	expect(lastState(h).gateAttempt).toBe(1);
	expect(lastState(h).gateRetryMode).toBe("repair");
	expect(lastState(h).repairLease).toBeUndefined();
	expect(JSON.parse(readFileSync(buildRecordPath(h), "utf8")).round).toBe(2);
	expect(h.notifications).not.toEqual(expect.arrayContaining([expect.stringContaining("Repair round")]));

	// The recovered round supports the full edit → validate → finalize → Gate chain.
	const editGuard = await h.handlers.get("tool_call")!({ toolName: "edit", toolCallId: "live3-edit", input: { path: "src/example.ts" } }, h.ctx);
	expect(editGuard).toBeUndefined();
	await h.handlers.get("tool_result")!({ toolName: "edit", toolCallId: "live3-edit", isError: false }, h.ctx);
	await completeBuildEvidence(h, "bun test live-three-repair");
	await dispatchGate(h, "live-gate-3");
	await gatePass(h, "live-gate-3");
	expect(lastState(h).phase).toBe("finalizing");
});

test("liveness 4: crash window B (record already round 2, lease pending) commits to building", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-four");
	const rp = buildRecordPath(h);
	writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), round: 2, observations: [] }));

	await restoreFromCrafted(h, (crafted) => {
		crafted.phase = "repair_preparing";
		crafted.gateAttempt = 1;
		crafted.gateCalls = 1;
		crafted.gateRetryMode = "repair";
		crafted.repairLease = { fromRound: 1, toRound: 2, reason: "gate_fail", startedAt: Date.now() };
		crafted.writtenArtifacts = [];
		crafted.stateVersion = 3;
		delete crafted.gateLease;
	});

	expect(lastState(h).phase).toBe("building");
	expect(lastState(h).gateAttempt).toBe(1);
	expect(lastState(h).gateRetryMode).toBe("repair");
	expect(lastState(h).repairLease).toBeUndefined();

	await completeBuildEvidence(h, "bun test live-four-repair");
	await dispatchGate(h, "live-gate-4");
	await gatePass(h, "live-gate-4");
	expect(lastState(h).phase).toBe("finalizing");
});

test("liveness 5a: v2 repair_preparing without lease migrates out instead of deadlocking", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-five-a");

	await restoreFromCrafted(h, (crafted) => {
		crafted.phase = "repair_preparing";
		crafted.gateAttempt = 1;
		crafted.gateCalls = 1;
		crafted.gateRetryMode = "repair";
		crafted.stateVersion = 2;
		delete crafted.repairLease;
		delete crafted.gateLease;
	});

	expect(lastState(h).phase).toBe("awaiting_human");
	expect(lastState(h).stateVersion).toBe(5);
});

test("liveness 5b: v3 repair_preparing without lease self-heals from the durable record", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-five-b");

	await restoreFromCrafted(h, (crafted) => {
		crafted.phase = "repair_preparing";
		crafted.gateAttempt = 1;
		crafted.gateCalls = 1;
		crafted.gateRetryMode = "repair";
		crafted.stateVersion = 3;
		delete crafted.repairLease;
		delete crafted.gateLease;
	});

	expect(lastState(h).phase).toBe("building");
	expect(lastState(h).gateAttempt).toBe(1);
	expect(JSON.parse(readFileSync(buildRecordPath(h), "utf8")).round).toBe(2);
});

test("liveness 5c: repair_preparing without lease and an unreadable record degrades to paused", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-five-c");
	const rp = buildRecordPath(h);
	rmSync(rp);
	mkdirSync(rp);

	await restoreFromCrafted(h, (crafted) => {
		crafted.phase = "repair_preparing";
		crafted.gateAttempt = 1;
		crafted.gateCalls = 1;
		crafted.gateRetryMode = "repair";
		crafted.stateVersion = 3;
		delete crafted.repairLease;
		delete crafted.gateLease;
	});

	expect(lastState(h).phase).toBe("awaiting_human");
	expect(JSON.parse(readFileSync(runMarkerPath(h), "utf8")).status).toBe("paused");
});

test("liveness 6: failed /flowcontinue setup emits no success marker or notification", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-six-a");
	await dispatchGate(h, "live-gate-6a");
	await gateFail(h, "live-gate-6a");
	expect(lastState(h).phase).toBe("building");
	await completeBuildEvidence(h, "bun test live-six-b");
	await dispatchGate(h, "live-gate-6b");
	await gateFail(h, "live-gate-6b");
	expect(lastState(h).phase).toBe("awaiting_human");

	const rp = buildRecordPath(h);
	rmSync(rp);
	mkdirSync(rp);
	const notificationsBefore = h.notifications.length;
	await h.commands.get("flowcontinue")!.handler("retry repair", h.ctx);

	expect(lastState(h).phase).toBe("awaiting_human");
	expect(JSON.parse(readFileSync(runMarkerPath(h), "utf8")).status).toBe("paused");
	expect(h.notifications.slice(notificationsBefore).some((m) => m.includes("Human repair cycle started"))).toBe(false);
	expect(h.notifications.slice(notificationsBefore).some((m) => m.includes("failed to start the repair evidence round"))).toBe(true);
});

const handoffPlan = (criticalFiles: string[], verification: string[]) =>
	[
		"## Critical files",
		...criticalFiles,
		"## Implementation",
		"- Update behavior in the handler.",
		"## Acceptance",
		"- [ ] Expected behavior must remain observable.",
		"## Verification",
		"```sh",
		...verification,
		"```",
		"Consider edge cases.",
		...Array.from({ length: 21 }, (_, index) => `Additional detail line ${index + 1}`),
	].join("\n");

test("liveness 7: root-level files are accepted as critical-file targets", () => {
	// The bare `bun test` verification keeps any path out of the plan body, so
	// the target check can only be satisfied by the Critical files entries.
	const result = assessHandoff(handoffPlan(["- package.json", "- README.md", "- .gitignore"], ["bun test"]));
	expect(result.blockers.map((b) => b.code)).not.toContain("TARGET_MISSING");
});

test("liveness 8: decorated placeholders are rejected across sections", () => {
	for (const entry of ["- TBD::later", "- TBD later", "- echo TBD", "- N/A::decide-later"]) {
		const result = assessHandoff(handoffPlan([entry], ["bun test tests/placeholder.test.ts"]));
		expect(result.status).toBe("NEEDS_UPDATE");
		expect(result.blockers.map((b) => b.code)).toContain("TARGET_MISSING");
	}

	const verification = assessHandoff(handoffPlan(["- extensions/leanflow/index.ts"], ["echo TBD"]));
	expect(verification.status).toBe("NEEDS_UPDATE");
	expect(verification.blockers.map((b) => b.code)).toContain("VERIFICATION_MISSING");
});
test("liveness 9: verification accepts approved command shapes and rejects dangerous lookalikes", () => {
	for (const command of ["./scripts/test.sh", "bin/rails test", "bundle exec rspec"]) {
		const result = assessHandoff(handoffPlan(["- extensions/leanflow/index.ts"], [command]));
		expect(result.blockers.map((blocker) => blocker.code)).not.toContain("VERIFICATION_MISSING");
	}
	for (const command of [
		"git status",
		"npm publish",
		"pnpm publish",
		"make install",
		"curl https://example.com",
		"rm -rf /",
		"bun test --watch",
		"bun test ../outside.test.ts",
		"bun test tests/a.test.ts\nrm -rf /",
	]) {
		const result = assessHandoff(handoffPlan(["- extensions/leanflow/index.ts"], [command]));
		expect(result.blockers.map((blocker) => blocker.code)).toContain("VERIFICATION_MISSING");
	}
});

test("liveness 10: decorated CJK placeholders are rejected across sections", () => {
	const acceptance = assessHandoff(
		handoffPlan(["- extensions/leanflow/index.ts"], ["bun test"]).replace(
			"- [ ] Expected behavior must remain observable.",
			"- [ ] 待定后补",
		),
	);
	expect(acceptance.blockers.map((blocker) => blocker.code)).toContain("ACCEPTANCE_MISSING");
	const target = assessHandoff(handoffPlan(["- 待补充::symbol"], ["bun test"]));
	expect(target.blockers.map((blocker) => blocker.code)).toContain("TARGET_MISSING");
});

test("regression: repair-Gate plan drift clears the baseline and satisfies invariants", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test drift-repair-a");
	await dispatchGate(h, "drift-gate-1");
	await gateFail(h, "drift-gate-1");
	expect(lastState(h).phase).toBe("building");
	await completeBuildEvidence(h, "bun test drift-repair-b");
	await dispatchGate(h, "drift-gate-2");
	expect(lastState(h).phase).toBe("gating");
	expect(lastState(h).baselineCaptured).toBe(true);

	// Drift the canonical plan while the repair Gate is in flight.
	const planPath = resolveRunMarkerPath(h.ctx.localProtocolOptions, gateArtifacts().plan)!;
	writeFileSync(planPath, `${readFileSync(planPath, "utf8")}\nplan drift`);
	await gatePass(h, "drift-gate-2");

	const settled = lastState(h);
	expect(["planning", "awaiting_approval"]).toContain(settled.phase as string);
	expect(settled.baselineCaptured).toBeFalsy();
	expect(checkInvariants(settled as never)).toEqual([]);
});

test("liveness: unreadable canonical plan during Gate returns to persisted planning repair", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test unreadable-plan");
	await dispatchGate(h, "unreadable-plan-gate");
	const persistedBefore = h.states.length;
	const planPath = resolveRunMarkerPath(h.ctx.localProtocolOptions, gateArtifacts().plan)!;
	rmSync(planPath);

	await gatePass(h, "unreadable-plan-gate");

	const settled = lastState(h);
	expect(settled.phase).toBe("planning");
	expect(settled.gateLease).toBeUndefined();
	expect(settled.proposalBoundary).toBeUndefined();
	expect(settled.proposedPlanArtifact).toBeUndefined();
	expect(settled.proposedPlanDigest).toBeUndefined();
	expect(settled.approvedPlanArtifact).toBeUndefined();
	expect(settled.approvalInvalidated).toBe(true);
	expect(settled.handoffStatus).toBe("NEEDS_UPDATE");
	expect(JSON.parse(readFileSync(runMarkerPath(h), "utf8")).status).toBe("invalidated");
	expect(h.states.length).toBeGreaterThan(persistedBefore);
	expect(checkInvariants(settled as never)).toEqual([]);
	expect(h.notifications).toEqual(
		expect.arrayContaining([expect.stringContaining("canonical plan is unreadable")]),
	);
	expect(h.editorTexts.at(-1)).toBe(
		`/plan Repair the existing LeanFlow plan at local://${EXAMPLE_SLUG}-plan.md in place. Preserve its run ID, fix only the invalid final-plan content, write the same artifact, then re-propose ${EXAMPLE_SLUG}. Do not repeat repository investigation.`,
	);
});

test("liveness 9: building round reconciliation persists the corrected gateAttempt", async () => {
	const h = createHarness();
	await enterDocumentationBuild(h);
	await completeBuildEvidence(h, "bun test live-nine");
	const rp = buildRecordPath(h);
	writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), round: 2, observations: [] }));
	const persistedBefore = h.states.length;

	await restoreFromCrafted(h, (crafted) => {
		crafted.phase = "building";
		crafted.gateAttempt = 0;
		crafted.gateRetryMode = "repair";
		crafted.stateVersion = 3;
		delete crafted.gateLease;
		delete crafted.repairLease;
	});

	expect(h.states.length).toBeGreaterThan(persistedBefore);
	expect(lastState(h).phase).toBe("building");
	expect(lastState(h).gateAttempt).toBe(1);
	const persisted = h.branch.at(-1) as { type: string; customType: string; data: Record<string, unknown> };
	expect(persisted.customType).toBe("leanflow-state");
	expect(persisted.data.gateAttempt).toBe(1);
});
