import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import leanflow, { resolveRunMarkerPath } from "../extensions/leanflow/index";

type TestContext = {
	hasUI: boolean;
	cwd: string;
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	ui: {
		input: () => Promise<string | undefined>;
		notify: () => void;
		setEditorText: (text: string) => void;
		setStatus: () => void;
	};
	sessionManager: { getBranch: () => unknown[] };
	localProtocolOptions: { getArtifactsDir: () => string; getSessionId?: () => string };
};

type CommandDefinition = { handler: (args: string, ctx: TestContext) => Promise<void> };
type ToolHandler = (event: Record<string, unknown>, ctx: TestContext) => Promise<unknown>;
type PersistedState = {
	phase: string;
	handoffStatus?: string;
	planArtifact?: string;
	proposalBoundary?: number;
	proposedPlanArtifact?: string;
	approvedPlanArtifact?: string;
	runId?: string;
	runMarkerArtifact?: string;
	lspProbeStatus: "not_required" | "pending" | "completed";
	lspProbeTarget?: string;
	stats?: {
		awaitingApproval: { elapsedMs: number };
		gateErrors: number;
		repairRounds: number;
		repairSuccesses: number;
	};
	writtenArtifacts?: string[];
};

type Harness = {
	branch: unknown[];
	editorTexts: string[];
	commands: Map<string, CommandDefinition>;
	ctx: TestContext;
	handlers: Map<string, ToolHandler>;
	states: PersistedState[];
};

function createHarness(): Harness {
	const handlers = new Map<string, ToolHandler>();
	const commands = new Map<string, CommandDefinition>();
	const branch: unknown[] = [];
	const states: PersistedState[] = [];
	const editorTexts: string[] = [];
	const artifactsDir = mkdtempSync(join(tmpdir(), "leanflow-test-"));
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
			notify: () => undefined,
			setEditorText: (text: string) => editorTexts.push(text),
			setStatus: () => undefined,
		},
		sessionManager: { getBranch: () => branch },
		localProtocolOptions: { getArtifactsDir: () => artifactsDir },
	};
	const pi = {
		on: (event: string, handler: ToolHandler) => handlers.set(event, handler),
		registerCommand: (name: string, definition: CommandDefinition) => commands.set(name, definition),
		appendEntry: (customType: string, state: PersistedState) => {
			const snapshot = structuredClone(state);
			states.push(snapshot);
			branch.push({ type: "custom", customType, data: snapshot });
		},
	};
	leanflow(pi as never);
	return { branch, commands, ctx, editorTexts, handlers, states };
}

function runMarkerPath(harness: Harness): string {
	return join(
		harness.ctx.localProtocolOptions.getArtifactsDir(),
		"local",
		`example-${harness.states.at(-1)!.runId}-leanflow-run.json`,
	);
}

async function writeInitialPlan(
	harness: Harness,
	content = "Update src/example.ts with the requested behavior and run focused tests.\nLSP applicability: required",
): Promise<void> {
	await harness.commands.get("flow")!.handler("example", harness.ctx);
	const planContent = `${content}\nLeanFlow run ID: ${harness.states.at(-1)!.runId}`;
	await harness.handlers.get("tool_call")!(
		{
			toolName: "write",
			toolCallId: "plan",
			input: {
				path: "local://example-plan.md",
				content: planContent,
			},
		},
		harness.ctx,
	);
	const planFile = resolveRunMarkerPath(harness.ctx.localProtocolOptions, "local://example-plan.md")!;
	mkdirSync(dirname(planFile), { recursive: true });
	writeFileSync(
		planFile,
		planContent,
	);
	await harness.handlers.get("tool_result")!(
		{ toolName: "write", toolCallId: "plan", isError: false },
		harness.ctx,
	);
	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");
}

const approvalMessages = [
	{ role: "user", content: "update src/example.ts", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "write",
				arguments: { path: "xd://propose", content: "example" },
			},
		],
		timestamp: 2,
	},
	{
		role: "developer",
		content: [
			{
				type: "text",
				text: [
					"Plan approved.",
					"<instruction>",
					"You MUST read `local://example-plan.md` before executing.",
					"The file content is the authoritative plan; visible/compressed context is secondary.",
					"</instruction>",

				].join("\n"),
			},
		],
		timestamp: 3,
	},
];
test("proposal is fail-closed until the canonical plan is valid and marked", async () => {
	const planning = createHarness();
	await planning.commands.get("flow")!.handler("example", planning.ctx);
	const planningProposal = await planning.handlers.get("tool_call")!(
		{ toolName: "write", toolCallId: "planning-proposal", input: { path: "xd://propose", content: "example" } },
		planning.ctx,
	);
	expect(planningProposal).toMatchObject({ block: true, reason: expect.stringContaining("only allowed") });

	const needsUpdate = createHarness();
	await needsUpdate.commands.get("flow")!.handler("example", needsUpdate.ctx);
	const runId = needsUpdate.states.at(-1)!.runId;
	const invalidContent = `Needs more detail.\nLeanFlow run ID: ${runId}`;
	await needsUpdate.handlers.get("tool_call")!(
		{
			toolName: "write",
			toolCallId: "invalid-plan",
			input: { path: "local://example-plan.md", content: invalidContent },
		},
		needsUpdate.ctx,
	);
	const invalidPath = resolveRunMarkerPath(needsUpdate.ctx.localProtocolOptions, "local://example-plan.md")!;
	writeFileSync(invalidPath, invalidContent);
	await needsUpdate.handlers.get("tool_result")!(
		{ toolName: "write", toolCallId: "invalid-plan", isError: false },
		needsUpdate.ctx,
	);
	expect(needsUpdate.states.at(-1)!.phase).toBe("planning");
	expect(
		await needsUpdate.handlers.get("tool_call")!(
			{ toolName: "write", toolCallId: "invalid-proposal", input: { path: "xd://propose", content: "example" } },
			needsUpdate.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("only allowed") });

	const missingMarker = createHarness();
	await writeInitialPlan(missingMarker);
	expect(
		await missingMarker.handlers.get("tool_call")!(
			{ toolName: "write", toolCallId: "wrong-slug", input: { path: "xd://propose", content: "wrong" } },
			missingMarker.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("durable run marker") });
	rmSync(runMarkerPath(missingMarker));
	expect(
		await missingMarker.handlers.get("tool_call")!(
			{ toolName: "write", toolCallId: "missing-marker", input: { path: "xd://propose", content: "example" } },
			missingMarker.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("durable run marker") });
});

test("proposal dispatch and Refine remain in Planner context and revised plans are assessed", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;

	expect(
		await call(
			{ toolName: "write", toolCallId: "propose", input: { path: "xd://propose", content: "example" } },
			harness.ctx,
		),
	).toBeUndefined();
	await result({ toolName: "write", toolCallId: "propose", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "awaiting_approval",
		proposalBoundary: expect.any(Number),
		proposedPlanArtifact: "local://example-plan.md",
		approvedPlanArtifact: undefined,
		lspProbeStatus: "pending",
	});
	expect(await context({ messages: approvalMessages }, harness.ctx)).toBeUndefined();

	harness.branch.push({ type: "mode_change", mode: "plan" });
	expect(await context({ messages: approvalMessages }, harness.ctx)).toBeUndefined();

	await call(
		{
			toolName: "write",
			toolCallId: "revised-plan",
			input: { path: "local://example-plan.md", content: "Needs more detail." },
		},
		harness.ctx,
	);
	writeFileSync(
		resolveRunMarkerPath(harness.ctx.localProtocolOptions, "local://example-plan.md")!,
		"Needs more detail.",
	);
	await result({ toolName: "write", toolCallId: "revised-plan", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "planning",
		handoffStatus: "NEEDS_UPDATE",
		proposalBoundary: undefined,
		proposedPlanArtifact: undefined,
		approvedPlanArtifact: undefined,
	});
});

test("native approval requires a real write-device diagnostics result before the first mutation", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;

	await call(
		{ toolName: "write", toolCallId: "propose", input: { path: "xd://propose", content: "example" } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose", isError: false }, harness.ctx);

	const beforeApproval = await call(
		{ toolName: "edit", toolCallId: "edit-before-approval", input: {} },
		harness.ctx,
	);
	expect(beforeApproval).toMatchObject({ block: true, reason: expect.stringContaining("native approval") });
	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");

	harness.branch.push({ type: "mode_change", mode: "none" });
	const afterModeExit = await call(
		{ toolName: "edit", toolCallId: "edit-after-mode-exit", input: {} },
		harness.ctx,
	);
	expect(afterModeExit).toMatchObject({ block: true, reason: expect.stringContaining("exact native approval") });

	const contextResult = await context({ messages: approvalMessages }, harness.ctx);
	expect(contextResult).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});

	expect(
		await call(
			{ toolName: "write", toolCallId: "other-device", input: { path: "xd://other", content: "{}" } },
			harness.ctx,
		),
	).toBeUndefined();
	expect(harness.states.at(-1)!.phase).toBe("building");

	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "malformed-probe",
				input: { path: "xd://lsp", content: "{" },
			},
			harness.ctx,
		),
	).toBeUndefined();
	await result({ toolName: "write", toolCallId: "malformed-probe", isError: false }, harness.ctx);
	expect(harness.states.at(-1)!.lspProbeStatus).toBe("pending");
	for (const file of ["", "   ", "../outside.ts", "/tmp/outside.ts", "src/does-not-exist.ts"]) {
		const toolCallId = `invalid-probe-${JSON.stringify(file)}`;
		await call(
			{
				toolName: "write",
				toolCallId,
				input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file }) },
			},
			harness.ctx,
		);
		await result({ toolName: "write", toolCallId, isError: true }, harness.ctx);
		expect(harness.states.at(-1)!.lspProbeStatus).toBe("pending");
	}

	const blocked = await call({ toolName: "edit", toolCallId: "edit-before-probe", input: {} }, harness.ctx);
	expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("xd://lsp") });

	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "probe",
				input: {
					path: "xd://lsp",
					content: JSON.stringify({ action: "diagnostics", file: "src/example.ts" }),
				},
			},
			harness.ctx,
		),
	).toBeUndefined();
	expect(harness.states.at(-1)!.lspProbeStatus).toBe("pending");
	await result({ toolName: "write", toolCallId: "probe", isError: true }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "completed",
		lspProbeTarget: "src/example.ts",
	});

	expect(
		await call(
			{ toolName: "write", toolCallId: "first-build-artifact", input: { path: "local://example-build.md", content: "build" } },
			harness.ctx,
		),
	).toBeUndefined();
	expect(harness.states.at(-1)!.phase).toBe("building");
	await result({ toolName: "write", toolCallId: "first-build-artifact", isError: false }, harness.ctx);
	expect(harness.states.at(-1)!.writtenArtifacts).toEqual(["build"]);

	expect(
		await call({ toolName: "edit", toolCallId: "edit-after-probe", input: {} }, harness.ctx),
	).toBeUndefined();
	expect(harness.states.at(-1)!.phase).toBe("building");
});

test("fresh approval session recovers the native plan identity before enforcing diagnostics", async () => {
	const ordinary = createHarness();
	const ordinaryContext = ordinary.handlers.get("context")!;
	expect(await ordinaryContext({ messages: approvalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);
	const mismatched = {
		version: 2,
		runId: "4f414c4c-8f8f-4dca-8df3-9e0fabada555",
		planSlug: "example",
		planArtifact: "local://different-plan.md",
		status: "awaiting_approval",
		updatedAt: Date.now(),
		phaseStartedAt: Date.now() - 500,
		scoutCalls: 0,
		startedAt: 1_780_000_000_000,
		stats: {},
		lspProbeStatus: "pending",
	};
	const ordinaryPlanRunId = "d94517d9-5882-4d02-b0fc-1ae90a912c6a";
	writeFileSync(
		join(ordinary.ctx.localProtocolOptions.getArtifactsDir(), "local", "example-plan.md"),
		`Ordinary plan.\nLeanFlow run ID: ${ordinaryPlanRunId}`,
	);
	writeFileSync(
		join(ordinary.ctx.localProtocolOptions.getArtifactsDir(), "local", `example-${mismatched.runId}-leanflow-run.json`),
		JSON.stringify(mismatched),
	);
	const staleSameSlug = { ...mismatched, planArtifact: "local://example-plan.md" };
	writeFileSync(
		join(ordinary.ctx.localProtocolOptions.getArtifactsDir(), "local", `example-${staleSameSlug.runId}-leanflow-run.json`),
		JSON.stringify(staleSameSlug),
	);
	expect(await ordinaryContext({ messages: approvalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);
	expect(await ordinaryContext({ messages: approvalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);

	const harness = createHarness();
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;
	const finalPlanContent = [
		"Update src/example.ts with the approved behavior.",
		"Run focused tests and verify the changed source path.",
		"LSP applicability: required",
		`LeanFlow run ID: 4f414c4c-8f8f-4dca-8df3-9e0fabada555`,
	].join("\n");
	const marker = {
		version: 2,
		runId: "4f414c4c-8f8f-4dca-8df3-9e0fabada555",
		planSlug: "example",
		planArtifact: "local://example-plan.md",
		planDigest: createHash("sha256").update("stale pre-overlay plan").digest("hex"),
		status: "awaiting_approval",
		updatedAt: Date.now(),
		phaseStartedAt: Date.now() - 500,
		scoutCalls: 2,
		startedAt: 1_780_000_000_000,
		handoffStatus: "READY_WITH_WARNINGS",
		handoffWarnings: ["warning"],
		stats: {
			planning: { input: 11, output: 7, cacheRead: 3, responses: 2, elapsedMs: 9 },
			awaitingApproval: { input: 1, output: 1, cacheRead: 0, responses: 1, elapsedMs: 2 },
			building: { input: 0, output: 0, cacheRead: 0, responses: 0, elapsedMs: 0 },
			gating: { input: 0, output: 0, cacheRead: 0, responses: 0, elapsedMs: 0 },
			gatePasses: 0,
			gateVerdictFailures: 0,
			gateErrors: 0,
			gateReadinessBlocks: 0,
			repairRounds: 0,
			repairSuccesses: 0,
			terminalFailures: 0,
		},
		lspProbeStatus: "pending",
	};
	const markerPath = join(harness.ctx.localProtocolOptions.getArtifactsDir(), "local", `example-${marker.runId}-leanflow-run.json`);
	writeFileSync(
		join(harness.ctx.localProtocolOptions.getArtifactsDir(), "local", "example-plan.md"),
		finalPlanContent,
	);
	writeFileSync(markerPath, JSON.stringify(marker));

	expect(await context({ messages: approvalMessages }, harness.ctx)).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		runId: marker.runId,
		scoutCalls: 2,
		planArtifact: "local://example-plan.md",
		proposedPlanArtifact: "local://example-plan.md",
		approvedPlanArtifact: "local://example-plan.md",
		planDigest: createHash("sha256").update(finalPlanContent).digest("hex"),
		lspProbeStatus: "pending",
		stats: { planning: { input: 11, responses: 2 } },
	});

	expect(await call({ toolName: "edit", toolCallId: "fresh-edit-before-probe", input: {} }, harness.ctx)).toMatchObject({
		block: true,
		reason: expect.stringContaining("xd://lsp"),
	});
	expect(harness.states.at(-1)!.stats!.awaitingApproval.elapsedMs).toBeGreaterThanOrEqual(502);
	await call(
		{
			toolName: "write",
			toolCallId: "fresh-probe",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/example.ts" }) },
		},
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "fresh-probe", isError: false }, harness.ctx);
	expect(await call({ toolName: "edit", toolCallId: "fresh-edit-after-probe", input: {} }, harness.ctx)).toBeUndefined();
	expect(harness.states.at(-1)!.phase).toBe("building");
});

test("documentation-only plans skip the pre-build LSP probe", async () => {
	const harness = createHarness();
	await writeInitialPlan(
		harness,
		"Update README content and verify the rendered text.\nLSP applicability: not_required",
	);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-docs", input: { path: "xd://propose", content: "example" } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-docs", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", lspProbeStatus: "not_required" });
	expect(await call({ toolName: "edit", toolCallId: "docs-edit", input: { path: "README.md" } }, harness.ctx)).toBeUndefined();
});

test("successful edits refresh all repair evidence artifacts", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-repair", input: { path: "xd://propose", content: "example" } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-repair", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	for (const kind of ["build", "diff", "evidence"]) {
		await call(
			{
				toolName: "write",
				toolCallId: `initial-${kind}`,
				input: { path: `local://example-${kind}.md`, content: kind },
			},
			harness.ctx,
		);
		await result({ toolName: "write", toolCallId: `initial-${kind}`, isError: false }, harness.ctx);
	}
	await call({ toolName: "task", toolCallId: "gate-1", input: { agent: "gate", task: "review" } }, harness.ctx);
	await result(
		{
			toolName: "task",
			toolCallId: "gate-1",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)!.writtenArtifacts).toEqual([]);

	await call(
		{
			toolName: "edit",
			toolCallId: "repair-evidence",
			input: { paths: ["local://example-build.md", "local://example-diff.md", "local://example-evidence.md"] },
		},
		harness.ctx,
	);
	await result({ toolName: "edit", toolCallId: "repair-evidence", isError: false }, harness.ctx);
	expect(harness.states.at(-1)!.writtenArtifacts?.sort()).toEqual(["build", "diff", "evidence"]);
	expect(
		await call({ toolName: "task", toolCallId: "gate-2", input: { agent: "gate", task: "review" } }, harness.ctx),
	).toBeUndefined();
	await result(
		{
			toolName: "task",
			toolCallId: "gate-2",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)!.stats!.repairSuccesses).toBe(1);
});

test("duplicate and fenced LSP declarations fail safe as required", async () => {
	const duplicate = createHarness();
	await writeInitialPlan(
		duplicate,
		"Change docs.\nLSP applicability: not_required\nLSP applicability: required",
	);
	expect(duplicate.states.at(-1)!.lspProbeStatus).toBe("pending");
	expect(duplicate.states.at(-1)!.handoffWarnings?.join("\n")).toContain("exactly one");

	const fenced = createHarness();
	await writeInitialPlan(
		fenced,
		"Change docs.\n```text\nLSP applicability: not_required\n```\nRun verification.",
	);
	expect(fenced.states.at(-1)!.lspProbeStatus).toBe("pending");
	expect(fenced.states.at(-1)!.handoffWarnings?.join("\n")).toContain("found 0");
});

test("NEEDS_UPDATE invalidates the prior active marker", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{
			toolName: "write",
			toolCallId: "needs-update",
			input: { path: "local://example-plan.md", content: "Needs more detail." },
		},
		harness.ctx,
	);
	writeFileSync(
		resolveRunMarkerPath(harness.ctx.localProtocolOptions, "local://example-plan.md")!,
		"Needs more detail.",
	);
	await result({ toolName: "write", toolCallId: "needs-update", isError: false }, harness.ctx);
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("invalidated");
});

test("flowcancel abandons an active recovery marker", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	await harness.commands.get("flowcancel")!.handler("", harness.ctx);
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("abandoned");
	expect(harness.states.at(-1)!.phase).toBe("idle");
});

test("marker storage uses the session-scoped fallback local root", async () => {
	const harness = createHarness();
	const sessionId = `leanflow-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	harness.ctx.localProtocolOptions = {
		getArtifactsDir: () => "",
		getSessionId: () => sessionId,
	};
	await writeInitialPlan(harness);
	const runId = harness.states.at(-1)!.runId!;
	const markerPath = join(tmpdir(), "omp-local", sessionId, `example-${runId}-leanflow-run.json`);
	expect(existsSync(markerPath)).toBe(true);
	const artifact = `local://example-${runId}-leanflow-run.json`;
	const windowsPath = resolveRunMarkerPath(
		{ getArtifactsDir: () => `C:\\${"very-long-root\\".repeat(20)}`, getSessionId: () => sessionId },
		artifact,
		"win32",
	);
	expect(windowsPath).toBe(join(tmpdir(), "omp-local", sessionId, `example-${runId}-leanflow-run.json`));
	rmSync(join(tmpdir(), "omp-local", sessionId), { recursive: true, force: true });
});

test("Gate operational errors preserve evidence and do not enter repair", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-error", input: { path: "xd://propose", content: "example" } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-error", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	for (const kind of ["build", "diff", "evidence"]) {
		await call(
			{
				toolName: "write",
				toolCallId: `error-${kind}`,
				input: { path: `local://example-${kind}.md`, content: kind },
			},
			harness.ctx,
		);
		await result({ toolName: "write", toolCallId: `error-${kind}`, isError: false }, harness.ctx);
	}
	await call({ toolName: "task", toolCallId: "gate-error", input: { agent: "gate", task: "review" } }, harness.ctx);
	await result({ toolName: "task", toolCallId: "gate-error", isError: true, content: [] }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		writtenArtifacts: ["build", "diff", "evidence"],
		stats: { gateErrors: 1, repairRounds: 0 },
	});
	const retryContext = await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(JSON.stringify(retryContext)).toContain("retry Gate with unchanged evidence");
	expect(JSON.stringify(retryContext)).not.toContain("implement it");
	expect(
		await call({ toolName: "task", toolCallId: "gate-retry", input: { agent: "gate", task: "retry" } }, harness.ctx),
	).toBeUndefined();
	await result(
		{
			toolName: "task",
			toolCallId: "gate-retry",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)!.stats).toMatchObject({ repairRounds: 0, repairSuccesses: 0 });
});

test("Gate PASS completes marker and preserves filtering through final agent end", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-pass", input: { path: "xd://propose", content: "example" } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-pass", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	for (const kind of ["build", "diff", "evidence"]) {
		await call(
			{
				toolName: "write",
				toolCallId: `pass-${kind}`,
				input: { path: `local://example-${kind}.md`, content: kind },
			},
			harness.ctx,
		);
		await result({ toolName: "write", toolCallId: `pass-${kind}`, isError: false }, harness.ctx);
	}
	await call({ toolName: "task", toolCallId: "gate-pass", input: { agent: "gate", task: "review" } }, harness.ctx);
	await result(
		{
			toolName: "task",
			toolCallId: "gate-pass",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)!.phase).toBe("finalizing");
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("completed");
	const finalContext = await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(finalContext).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});
	const finalPrompt = JSON.stringify(finalContext);
	expect(finalPrompt).not.toContain("implement it");
	expect(finalPrompt).not.toContain("Then call Gate");
	expect(finalPrompt).toContain("Do not call tools");
	expect(await call({ toolName: "edit", toolCallId: "late-edit", input: { path: "README.md" } }, harness.ctx)).toMatchObject({
		block: true,
		reason: expect.stringContaining("finalizing"),
	});
	await harness.handlers.get("agent_end")!({ willContinue: true }, harness.ctx);
	expect(harness.states.at(-1)!.phase).toBe("finalizing");
	await harness.handlers.get("agent_end")!({}, harness.ctx);
	expect(harness.states.at(-1)!.phase).toBe("idle");
});

test("second Gate FAIL marks the run failed before final response", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-fail", input: { path: "xd://propose", content: "example" } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-fail", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	for (const kind of ["build", "diff", "evidence"]) {
		await call(
			{
				toolName: "write",
				toolCallId: `fail-${kind}`,
				input: { path: `local://example-${kind}.md`, content: kind },
			},
			harness.ctx,
		);
		await result({ toolName: "write", toolCallId: `fail-${kind}`, isError: false }, harness.ctx);
	}
	for (const attempt of [1, 2]) {
		await call({ toolName: "task", toolCallId: `gate-fail-${attempt}`, input: { agent: "gate", task: "review" } }, harness.ctx);
		await result(
			{
				toolName: "task",
				toolCallId: `gate-fail-${attempt}`,
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [{ severity: "blocking" }] }) }],
			},
			harness.ctx,
		);
		if (attempt === 1) {
			await call(
				{
					toolName: "edit",
					toolCallId: "refresh-failed-evidence",
					input: { paths: ["local://example-build.md", "local://example-diff.md", "local://example-evidence.md"] },
				},
				harness.ctx,
			);
			await result({ toolName: "edit", toolCallId: "refresh-failed-evidence", isError: false }, harness.ctx);
		}
	}
	expect(harness.states.at(-1)!.phase).toBe("finalizing");
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("failed");
});

test("canonical plan edits are reread and reassessed from actual content", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update documentation and verify text.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const runId = harness.states.at(-1)!.runId;
	const planPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, "local://example-plan.md")!;

	const requiredContent = [
		"Update src/example.ts and verify the requested behavior.",
		"Run focused tests for the changed source.",
		"LSP applicability: required",
		`LeanFlow run ID: ${runId}`,
	].join("\n");
	expect(
		await call(
			{ toolName: "edit", toolCallId: "plan-required", input: { path: "local://example-plan.md" } },
			harness.ctx,
		),
	).toBeUndefined();
	writeFileSync(planPath, requiredContent);
	await result({ toolName: "edit", toolCallId: "plan-required", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "awaiting_approval",
		lspProbeStatus: "pending",
		proposedPlanArtifact: undefined,
		planDigest: createHash("sha256").update(requiredContent).digest("hex"),
	});

	expect(
		await call(
			{
				toolName: "edit",
				toolCallId: "mixed-plan-edit",
				input: { paths: ["local://example-plan.md", "src/example.ts"] },
			},
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("awaiting exact native approval") });

	const docsContent = [
		"Update documentation only and verify the rendered text.",
		"No source paths are changed by this plan.",
		"LSP applicability: not_required",
		`LeanFlow run ID: ${runId}`,
	].join("\n");
	await call({ toolName: "edit", toolCallId: "plan-docs", input: { path: "local://example-plan.md" } }, harness.ctx);
	writeFileSync(planPath, docsContent);
	await result({ toolName: "edit", toolCallId: "plan-docs", isError: false }, harness.ctx);
	expect(harness.states.at(-1)!.lspProbeStatus).toBe("not_required");

	const duplicateIdentity = `${docsContent}\nLeanFlow run ID: ${runId}`;
	await call({ toolName: "edit", toolCallId: "plan-duplicate-id", input: { path: "local://example-plan.md" } }, harness.ctx);
	writeFileSync(planPath, duplicateIdentity);
	await result({ toolName: "edit", toolCallId: "plan-duplicate-id", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({ phase: "planning", handoffStatus: "NEEDS_UPDATE" });
	expect(JSON.parse(readFileSync(runMarkerPath(harness), "utf8")).status).toBe("invalidated");
});

test("native approval rereads overlay-modified plan content before BUILD", async () => {
	const valid = createHarness();
	await writeInitialPlan(valid, "Update documentation and verify text.\nLSP applicability: not_required");
	const validCall = valid.handlers.get("tool_call")!;
	const validResult = valid.handlers.get("tool_result")!;
	await validCall(
		{ toolName: "write", toolCallId: "overlay-propose", input: { path: "xd://propose", content: "example" } },
		valid.ctx,
	);
	await validResult({ toolName: "write", toolCallId: "overlay-propose", isError: false }, valid.ctx);
	valid.branch.push({ type: "mode_change", mode: "none" });
	const finalContent = [
		"Update src/example.ts after plan review and verify behavior.",
		"Run focused source tests.",
		"LSP applicability: required",
		`LeanFlow run ID: ${valid.states.at(-1)!.runId}`,
	].join("\n");
	writeFileSync(resolveRunMarkerPath(valid.ctx.localProtocolOptions, "local://example-plan.md")!, finalContent);
	await valid.handlers.get("context")!({ messages: approvalMessages }, valid.ctx);
	expect(valid.states.at(-1)).toMatchObject({
		phase: "building",
		lspProbeStatus: "pending",
		planDigest: createHash("sha256").update(finalContent).digest("hex"),
		proposedPlanDigest: createHash("sha256").update(finalContent).digest("hex"),
	});
	expect(
		await validCall(
			{
				toolName: "write",
				toolCallId: "post-approval-plan-write",
				input: { path: "local://example-plan.md", content: finalContent },
			},
			valid.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("immutable") });
	expect(
		await validCall(
			{ toolName: "edit", toolCallId: "post-approval-plan-edit", input: { path: "local://example-plan.md" } },
			valid.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("immutable") });

	const invalid = createHarness();
	await writeInitialPlan(invalid, "Update documentation and verify text.\nLSP applicability: not_required");
	const invalidCall = invalid.handlers.get("tool_call")!;
	const invalidResult = invalid.handlers.get("tool_result")!;
	await invalidCall(
		{ toolName: "write", toolCallId: "invalid-overlay-propose", input: { path: "xd://propose", content: "example" } },
		invalid.ctx,
	);
	await invalidResult({ toolName: "write", toolCallId: "invalid-overlay-propose", isError: false }, invalid.ctx);
	invalid.branch.push({ type: "mode_change", mode: "none" });
	writeFileSync(
		resolveRunMarkerPath(invalid.ctx.localProtocolOptions, "local://example-plan.md")!,
		"Overlay removed the required run identity.\nLSP applicability: required",
	);
	expect(await invalid.handlers.get("context")!({ messages: approvalMessages }, invalid.ctx)).toBeUndefined();
	expect(
		await invalidCall({ toolName: "edit", toolCallId: "invalid-overlay-build", input: { path: "src/example.ts" } }, invalid.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("became invalid") });
	expect(invalid.states.at(-1)).toMatchObject({ phase: "planning", approvalInvalidated: true });
	expect(invalid.editorTexts.at(-1)).toContain("/plan Repair the existing LeanFlow plan");
	const repairedContent = [
		"Update documentation only after repairing the reviewed plan.",
		"Verify the rendered text and final diff.",
		"LSP applicability: not_required",
		`LeanFlow run ID: ${invalid.states.at(-1)!.runId}`,
	].join("\n");
	expect(
		await invalidCall(
			{ toolName: "edit", toolCallId: "repair-invalid-plan", input: { path: "local://example-plan.md" } },
			invalid.ctx,
		),
	).toBeUndefined();
	writeFileSync(
		resolveRunMarkerPath(invalid.ctx.localProtocolOptions, "local://example-plan.md")!,
		repairedContent,
	);
	await invalidResult({ toolName: "edit", toolCallId: "repair-invalid-plan", isError: false }, invalid.ctx);
	expect(invalid.states.at(-1)!.phase).toBe("awaiting_approval");
	expect(
		await invalidCall(
			{ toolName: "write", toolCallId: "repair-propose-before-mode", input: { path: "xd://propose", content: "example" } },
			invalid.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("re-enter native plan mode") });
	invalid.branch.push({ type: "mode_change", mode: "plan" });
	expect(
		await invalidCall(
			{ toolName: "write", toolCallId: "repair-propose", input: { path: "xd://propose", content: "example" } },
			invalid.ctx,
		),
	).toBeUndefined();
	await invalidResult({ toolName: "write", toolCallId: "repair-propose", isError: false }, invalid.ctx);
	expect(invalid.states.at(-1)).toMatchObject({
		phase: "awaiting_approval",
		proposalBoundary: expect.any(Number),
		proposedPlanArtifact: "local://example-plan.md",
		approvalRepairBoundary: undefined,
	});
});
