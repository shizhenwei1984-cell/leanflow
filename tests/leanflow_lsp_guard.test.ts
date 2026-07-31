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
	lspProbeCompleted: boolean;
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

async function writeInitialPlan(harness: Harness): Promise<void> {
	await harness.commands.get("flow")!.handler("example", harness.ctx);
	await harness.handlers.get("tool_call")!(
		{
			toolName: "write",
			toolCallId: "plan",
			input: {
				path: "local://example-plan.md",
				content: "Update src/example.ts with the requested behavior and run focused tests.",
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
		content:
			"Plan approved.\n\n<instruction>\nYou MUST read local://example-plan.md before executing.\n</instruction>",
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
		lspProbeCompleted: false,
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
	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");

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
	expect(harness.states.at(-1)!.lspProbeCompleted).toBe(false);

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
	expect(harness.states.at(-1)!.lspProbeCompleted).toBe(false);
	await result({ toolName: "write", toolCallId: "probe", isError: true }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeCompleted: true,
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
	const harness = createHarness();
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;
	const messages = [
		{ role: "user", content: "update src/example.ts", timestamp: 1 },
		{
			role: "developer",
			content:
				"Plan approved.\n\n<instruction>\nYou MUST read local://example-plan.md before executing.\n</instruction>",
			timestamp: 2,
		},
	];

	expect(await context({ messages }, harness.ctx)).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});
	expect(harness.states.at(-1)).toMatchObject({
		phase: "awaiting_approval",
		planArtifact: "local://example-plan.md",
		proposedPlanArtifact: "local://example-plan.md",
		approvedPlanArtifact: "local://example-plan.md",
		lspProbeCompleted: false,
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
