import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import leanflow from "../extensions/leanflow/index";

type TestContext = {
	hasUI: boolean;
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	ui: {
		input: () => Promise<string | undefined>;
		notify: () => void;
		setEditorText: () => void;
		setStatus: () => void;
	};
	sessionManager: { getBranch: () => unknown[] };
	localProtocolOptions: { getArtifactsDir: () => string };
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
	writtenArtifacts?: string[];
};

type Harness = {
	branch: unknown[];
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
	const artifactsDir = mkdtempSync(join(tmpdir(), "leanflow-test-"));
	mkdirSync(join(artifactsDir, "local"), { recursive: true });
	const ctx: TestContext = {
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			input: async () => undefined,
			notify: () => undefined,
			setEditorText: () => undefined,
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
	return { branch, commands, ctx, handlers, states };
}

async function writeInitialPlan(
	harness: Harness,
	content = "Update src/example.ts with the requested behavior and run focused tests.\nLSP applicability: required",
): Promise<void> {
	await harness.commands.get("flow")!.handler("example", harness.ctx);
	await harness.handlers.get("tool_call")!(
		{
			toolName: "write",
			toolCallId: "plan",
			input: {
				path: "local://example-plan.md",
				content,
			},
		},
		harness.ctx,
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
	for (const file of ["", "   ", "../outside.ts", "/tmp/outside.ts"]) {
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
		version: 1,
		runId: "4f414c4c-8f8f-4dca-8df3-9e0fabada555",
		planSlug: "example",
		planArtifact: "local://different-plan.md",
		phase: "awaiting_approval",
		scoutCalls: 0,
		startedAt: 1_780_000_000_000,
		stats: {},
		lspProbeStatus: "pending",
	};
	writeFileSync(
		join(ordinary.ctx.localProtocolOptions.getArtifactsDir(), "local", "example-leanflow-run.json"),
		JSON.stringify(mismatched),
	);
	expect(await ordinaryContext({ messages: approvalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);

	const harness = createHarness();
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;
	const marker = {
		version: 1,
		runId: "4f414c4c-8f8f-4dca-8df3-9e0fabada555",
		planSlug: "example",
		planArtifact: "local://example-plan.md",
		phase: "awaiting_approval",
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
	const markerPath = join(harness.ctx.localProtocolOptions.getArtifactsDir(), "local", "example-leanflow-run.json");
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
		lspProbeStatus: "pending",
		handoffWarnings: ["warning"],
		stats: { planning: { input: 11, responses: 2 } },
	});

	expect(await call({ toolName: "edit", toolCallId: "fresh-edit-before-probe", input: {} }, harness.ctx)).toMatchObject({
		block: true,
		reason: expect.stringContaining("xd://lsp"),
	});
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
});
