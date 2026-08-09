import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { canonicalGateTask } from "../extensions/leanflow/guard";
import { assessHandoff, formatHandoffNotification } from "../extensions/leanflow/handoff";
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

type CommandDefinition = { handler: (args: string, ctx: TestContext) => Promise<void> };
type ToolHandler = (event: Record<string, unknown>, ctx: TestContext) => Promise<unknown>;
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: TestContext,
	) => Promise<{ content?: unknown; isError?: boolean }>;
};
type PersistedState = {
	phase: string;
	gateCalls: number;
	gateAttempt: number;
	handoffStatus?: string;
	handoffWarnings?: string[];
	handoffBlockers?: string[];
	planSlug?: string;
	planArtifact?: string;
	proposalBoundary?: number;
	proposedPlanArtifact?: string;
	approvedPlanArtifact?: string;
	runId?: string;
	planDigest?: string;
	runMarkerArtifact?: string;
	lspProbeStatus: "not_required" | "pending" | "completed";
	lspProbeTarget?: string;
	baselineCaptured?: boolean;
	buildMutationObserved?: boolean;
	stats?: {
		awaitingApproval: { elapsedMs: number };
		gateErrors: number;
		repairRounds: number;
		repairSuccesses: number;
	};
	terminalOutcome?: "pass" | "fail_after_retry" | "gate_operational_failure";
	persistenceDegraded?: boolean;
	persistenceFailureStage?: "precondition" | "marker" | "pointer";
	persistenceFailurePath?: string;
	persistenceFailureCode?: string;
	persistenceFailureMessage?: string;
	writtenArtifacts?: string[];
	gateRetryMode?: "repair" | "operational" | "evidence";
	humanRepairCycles?: number;
	lastGateFindings?: string;
	gateDispatches?: number;
	gateLease?: { toolCallId: string; snapshotDigest?: string };
};

type Harness = {
	branch: unknown[];
	editorTexts: string[];
	notifications: string[];
	commands: Map<string, CommandDefinition>;
	ctx: TestContext;
	handlers: Map<string, ToolHandler>;
	states: PersistedState[];
	tools: Map<string, RegisteredTool>;
	execCalls: { command: string; args: string[] }[];
	execResults: ExecResult[];
};

function createHarness(options: { execResults?: ExecResult[] } = {}): Harness {
	const handlers = new Map<string, ToolHandler>();
	const commands = new Map<string, CommandDefinition>();
	const tools = new Map<string, RegisteredTool>();
	const branch: unknown[] = [];
	const states: PersistedState[] = [];
	const editorTexts: string[] = [];
	const notifications: string[] = [];
	const execCalls: { command: string; args: string[] }[] = [];
	const execResults = [...(options.execResults ?? [])];
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
			notify: (message: string) => notifications.push(message),
			setEditorText: (text: string) => editorTexts.push(text),
			setStatus: () => undefined,
		},
		sessionManager: { getBranch: () => branch },
		localProtocolOptions: { getArtifactsDir: () => artifactsDir },
	};
	const defaultExec = (command: string, args: string[]): ExecResult => {
		if (command !== "git") return { stdout: "", stderr: `unexpected executable: ${command}`, code: 127, killed: false };
		if (args[0] === "rev-parse") {
			return { stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0, killed: false };
		}
		if (args[0] === "status" || args[0] === "ls-files") {
			return { stdout: "", stderr: "", code: 0, killed: false };
		}
		if (args[0] === "diff" && args.includes("--no-index")) {
			return { stdout: "diff --git a/dev/null b/untracked\n", stderr: "", code: 1, killed: false };
		}
		if (args[0] === "diff") return { stdout: "", stderr: "", code: 0, killed: false };
		return { stdout: "", stderr: `unexpected git arguments: ${args.join(" ")}`, code: 2, killed: false };
	};
	const pi = {
		zod: { z },
		on: (event: string, handler: ToolHandler) => handlers.set(event, handler),
		registerCommand: (name: string, definition: CommandDefinition) => commands.set(name, definition),
		registerTool: (definition: RegisteredTool & { name: string }) => tools.set(definition.name, definition),
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args: [...args] });
			return execResults.shift() ?? defaultExec(command, args);
		},
		appendEntry: (customType: string, state: PersistedState) => {
			const snapshot = structuredClone(state);
			states.push(snapshot);
			branch.push({ type: "custom", customType, data: snapshot });
		},
	};
	leanflow(pi as never);
	return {
		branch,
		commands,
		ctx,
		editorTexts,
		execCalls,
		execResults,
		handlers,
		notifications,
		states,
		tools,
	};
}

const EXAMPLE_TASK = "example";
const EXAMPLE_SLUG = `example-${createHash("sha256").update(EXAMPLE_TASK, "utf8").digest("hex").slice(0, 8)}`;
const EXAMPLE_PLAN_ARTIFACT = `local://${EXAMPLE_SLUG}-plan.md`;
const EXAMPLE_BUILD_ARTIFACT = `local://${EXAMPLE_SLUG}-build.md`;
const EXAMPLE_DIFF_ARTIFACT = `local://${EXAMPLE_SLUG}-diff.md`;
const EXAMPLE_EVIDENCE_ARTIFACT = `local://${EXAMPLE_SLUG}-evidence.md`;
const LEGACY_SLUG = "example";
const LEGACY_PLAN_ARTIFACT = `local://${LEGACY_SLUG}-plan.md`;

function gateArtifacts(slug = EXAMPLE_SLUG) {
	const prefix = `local://${slug}`;
	return {
		plan: `${prefix}-plan.md`,
		build: `${prefix}-build.md`,
		diff: `${prefix}-diff.md`,
		evidence: `${prefix}-evidence.md`,
	};
}

function gateCallInput(options: { batch?: boolean; slug?: string } = {}): Record<string, unknown> {
	const artifacts = gateArtifacts(options.slug);
	const item = {
		agent: "gate",
		task: canonicalGateTask(artifacts),
		schemaMode: "strict",
	};
	return options.batch === false ? item : { context: "LeanFlow Gate", tasks: [item] };
}

function buildRecordPath(harness: Harness): string {
	const runId = harness.states.at(-1)!.runId!;
	return resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		`local://.leanflow/runs/${runId}-build-record.json`,
	)!;
}

async function executeRegisteredTool(
	harness: Harness,
	name: "leanflow_capture_baseline" | "leanflow_finalize_artifacts",
	params: Record<string, unknown>,
	toolCallId = `${name}-${harness.states.length}`,
) {
	const guardResult = await harness.handlers.get("tool_call")!(
		{ toolName: name, toolCallId, input: params },
		harness.ctx,
	);
	if (
		guardResult &&
		typeof guardResult === "object" &&
		"block" in guardResult &&
		guardResult.block === true
	) {
		throw new Error(`custom tool blocked: ${JSON.stringify(guardResult)}`);
	}
	const tool = harness.tools.get(name);
	if (!tool) throw new Error(`missing registered tool: ${name}`);
	return tool.execute(toolCallId, params, undefined, undefined, harness.ctx);
}

async function recordSuccessfulValidation(
	harness: Harness,
	command: string,
	output = "1 pass\n0 fail\n2 expect() calls\nRan 1 test across 1 file.",
): Promise<void> {
	const toolCallId = `validation-${harness.states.length}`;
	const callResult = await harness.handlers.get("tool_call")!(
		{ toolName: "bash", toolCallId, input: { command } },
		harness.ctx,
	);
	if (
		callResult &&
		typeof callResult === "object" &&
		"block" in callResult &&
		callResult.block === true
	) {
		throw new Error(`validation blocked: ${JSON.stringify(callResult)}`);
	}
	await harness.handlers.get("tool_result")!(
		{
			toolName: "bash",
			toolCallId,
			isError: false,
			details: {},
			content: [{ type: "text", text: output }],
		},
		harness.ctx,
	);
}

async function completeBuildEvidence(
	harness: Harness,
	command = "bun test tests/*.test.ts",
): Promise<void> {
	if (harness.states.at(-1)!.baselineCaptured !== true) {
		const capture = await executeRegisteredTool(harness, "leanflow_capture_baseline", {});
		if (capture.isError) throw new Error(`baseline capture failed: ${JSON.stringify(capture.content)}`);
	}
	await recordSuccessfulValidation(harness, command);
	const finalized = await executeRegisteredTool(harness, "leanflow_finalize_artifacts", {
		validationCommands: [command],
	});
	if (finalized.isError) throw new Error(`artifact finalization failed: ${JSON.stringify(finalized.content)}`);
}

async function enterDocumentationBuild(harness: Harness): Promise<void> {
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-doc-build", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-doc-build", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
}

function hashedPointerArtifact(slug: string): string {
	return `local://.leanflow/active/${createHash("sha256").update(slug, "utf8").digest("hex")}.json`;
}

function legacyPointerArtifact(slug: string): string {
	return `local://.leanflow/active/${encodeURIComponent(slug)}.json`;
}

function runMarkerPath(harness: Harness): string {
	return resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		harness.states.at(-1)!.runMarkerArtifact!,
	)!;
}

function writeFreshArtifacts(
	harness: Harness,
	options: {
		planContent: string;
		markerOverrides?: Record<string, unknown>;
		pointer?: "hashed" | "legacy" | false;
		slug?: string;
	},
): { markerPath: string; pointerPath: string; runId: string } {
	const runId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
	const slug = options.slug ?? LEGACY_SLUG;
	const planArtifact = `local://${slug}-plan.md`;
	const markerArtifact = `local://.leanflow/runs/${runId}.json`;
	const markerPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, markerArtifact)!;
	const pointerArtifact =
		options.pointer === "legacy" ? legacyPointerArtifact(slug) : hashedPointerArtifact(slug);
	const pointerPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, pointerArtifact)!;
	const planPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, planArtifact)!;
	mkdirSync(dirname(planPath), { recursive: true });
	writeFileSync(planPath, options.planContent);
	const marker = {
		version: 2,
		runId,
		planSlug: slug,
		planArtifact,
		planDigest: createHash("sha256").update(options.planContent).digest("hex"),
		status: "awaiting_approval",
		updatedAt: Date.now(),
		phaseStartedAt: Date.now() - 500,
		scoutCalls: 0,
		startedAt: Date.now() - 1_000,
		stats: {
			planning: { input: 0, output: 0, cacheRead: 0, responses: 0, elapsedMs: 0 },
			awaitingApproval: { input: 0, output: 0, cacheRead: 0, responses: 0, elapsedMs: 0 },
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
		...options.markerOverrides,
	};
	mkdirSync(dirname(markerPath), { recursive: true });
	mkdirSync(dirname(pointerPath), { recursive: true });
	writeFileSync(markerPath, JSON.stringify(marker));
	if (options.pointer !== false) {
		writeFileSync(
			pointerPath,
			JSON.stringify({
				version: 1,
				runId,
				markerArtifact,
				planArtifact,
				status: "awaiting_approval",
				updatedAt: Date.now(),
			}),
		);
	}
	return { markerPath, pointerPath, runId };
}

async function writeInitialPlan(
	harness: Harness,
	content = "Update src/example.ts with the requested behavior and run focused tests.\nLSP applicability: required",
): Promise<void> {
	await harness.commands.get("flow")!.handler(EXAMPLE_TASK, harness.ctx);
	const latest = harness.states.at(-1)!;
	const planContent = [
		content,
		"## Critical files",
		"- extensions/leanflow/index.ts",
		"## Acceptance",
		"- [ ] Expected behavior must remain observable.",
		"## Verification",
		"`bun test tests/leanflow_lsp_guard.test.ts`",
		"Consider edge cases.",
		`LeanFlow run ID: ${latest.runId}`,
	].join("\n");
	const planArtifact = `local://${latest.planSlug}-plan.md`;
	await harness.handlers.get("tool_call")!(
		{
			toolName: "write",
			toolCallId: "plan",
			input: {
				path: planArtifact,
				content: planContent,
			},
		},
		harness.ctx,
	);
	const planFile = resolveRunMarkerPath(harness.ctx.localProtocolOptions, planArtifact)!;
	mkdirSync(dirname(planFile), { recursive: true });
	writeFileSync(planFile, planContent);
	await harness.handlers.get("tool_result")!(
		{ toolName: "write", toolCallId: "plan", isError: false },
		harness.ctx,
	);
	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");
}

function completeHandoffPlan(content: string): string {
	return [
		content,
		"## Critical files",
		"- extensions/leanflow/index.ts",
		"## Acceptance",
		"- [ ] Expected behavior must remain observable.",
		"## Verification",
		"```sh",
		"bun test tests/leanflow_lsp_guard.test.ts",
		"```",
		"Consider edge cases.",
	].join("\n");
}

function approvalMessagesFor(slug: string, planArtifact: string): unknown[] {
	return [
		{ role: "user", content: "update src/example.ts", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "write",
					arguments: { path: "xd://propose", content: slug },
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
						`You MUST read \`${planArtifact}\` before executing.`,
						"The file content is the authoritative plan; visible/compressed context is secondary.",
						"</instruction>",
					].join("\n"),
				},
			],
			timestamp: 3,
		},
	];
}

const approvalMessages = approvalMessagesFor(EXAMPLE_SLUG, EXAMPLE_PLAN_ARTIFACT);
const legacyApprovalMessages = approvalMessagesFor(LEGACY_SLUG, LEGACY_PLAN_ARTIFACT);

test("handoff emits deterministic structured blockers and notifications", () => {
	const metadataOnly = assessHandoff(
		[
			"Needs more detail.",
			"LeanFlow run ID: aaaaaaaa-3add-4aaa-8aaa-aaaaaaaaaaaa",
			"LSP applicability: required",
		].join("\n"),
	);
	expect(metadataOnly.status).toBe("NEEDS_UPDATE");
	expect(metadataOnly.blockers.map((blocker) => blocker.code)).toEqual([
		"TARGET_MISSING",
		"BEHAVIOR_MISSING",
		"ACCEPTANCE_MISSING",
		"VERIFICATION_MISSING",
	]);


	const targetNamedAdd = assessHandoff(
		[
			"## Critical files",
			"- src/add.ts",
			"## Acceptance",
			"- [ ] Expected result must remain observable.",
			"## Verification",
			"```sh",
			"bun test tests/add.test.ts",
			"```",
			"Consider edge cases.",
		].join("\n"),
	);
	expect(targetNamedAdd).toMatchObject({
		status: "NEEDS_UPDATE",
		blockers: [{ code: "BEHAVIOR_MISSING" }],
	});

	const multipleTargetPathsWithoutBehavior = assessHandoff(
		[
			"## Critical files",
			"- src/neutral.ts",
			"## Implementation",
			"- Coordinate src/neutral.ts with src/add.ts.",
			"## Acceptance",
			"- [ ] Expected result must remain observable.",
			"## Verification",
			"```sh",
			"bun test tests/leanflow_lsp_guard.test.ts",
			"```",
			"Consider edge cases.",
		].join("\n"),
	);
	expect(multipleTargetPathsWithoutBehavior.status).toBe("NEEDS_UPDATE");
	expect(multipleTargetPathsWithoutBehavior.blockers.map((blocker) => blocker.code)).toEqual(["BEHAVIOR_MISSING"]);

	const missingVerification = assessHandoff(
		[
			"## Critical files",
			"- extensions/leanflow/handoff.ts",
			"## Implementation",
			"- Update the handoff assessment.",
			"## Acceptance",
			"- [ ] Expected result must contain a blocker code.",
		].join("\n"),
	);
	expect(missingVerification).toMatchObject({
		status: "NEEDS_UPDATE",
		blockers: [{ code: "VERIFICATION_MISSING" }],
	});
	const notification = formatHandoffNotification(missingVerification);
	expect(notification).toContain("Blockers:\n- VERIFICATION_MISSING:");
	expect(notification.indexOf("Blockers:")).toBeLessThan(notification.indexOf("Warnings:"));
	expect(notification).not.toContain("Proceeding to approval.");

	const completePlan = [
		"# Handoff plan",
		"## Critical files",
		"- extensions/leanflow/handoff.ts",
		"## Implementation",
		"- Update structured handoff blockers.",
		"## Acceptance",
		"- [ ] Expected status must be READY.",
		"## Verification",
		"```sh",
		"bun test tests/leanflow_lsp_guard.test.ts",
		"```",
		"## Edge cases",
		"- Handle missing sections.",
		"- Detail 01",
		"- Detail 02",
		"- Detail 03",
		"- Detail 04",
		"- Detail 05",
		"- Detail 06",
		"- Detail 07",
		"- Detail 08",
		"- Detail 09",
		"- Detail 10",
		"- Detail 11",
		"- Detail 12",
		"- Detail 13",
		"- Detail 14",
		"- Detail 15",
		"- Detail 16",
		"- Detail 17",
		"- Detail 18",
		"- Detail 19",
		"- Detail 20",
		"- Detail 21",
		"- Detail 22",
		"- Detail 23",
		"- Detail 24",
		"- Detail 25",
		"- Detail 26",
		"- Detail 27",
	].join("\n");
	expect(assessHandoff(completePlan)).toMatchObject({ status: "READY", blockers: [], warnings: [] });
});

test("runtime Planner prompt requires Simplified Chinese while preserving technical identifiers", async () => {
	const harness = createHarness();
	await harness.commands.get("flow")!.handler("修复工具路由", harness.ctx);

	const prompt = harness.editorTexts.at(-1);
	expect(prompt).toStartWith("/plan ");
	expect(prompt).toContain("All communication addressed to the user MUST be in Simplified Chinese.");
	expect(prompt).toContain("Write the decision-complete canonical plan in Simplified Chinese.");
	expect(prompt).toContain(
		"Keep source code, commands, file paths, symbol names, API names, structured artifact keys, and verbatim tool or error output unchanged unless translation is necessary for comprehension.",
	);
	expect(prompt).toContain("Task: 修复工具路由");
});


test("proposal is fail-closed until the canonical plan is valid and marked", async () => {
	const planning = createHarness();
	await planning.commands.get("flow")!.handler("example", planning.ctx);
	const planningProposal = await planning.handlers.get("tool_call")!(
		{ toolName: "write", toolCallId: "planning-proposal", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		planning.ctx,
	);
	expect(planningProposal).toMatchObject({ block: true, reason: expect.stringContaining("explicitly read-only") });

	const needsUpdate = createHarness();
	await needsUpdate.commands.get("flow")!.handler("example", needsUpdate.ctx);
	const runId = needsUpdate.states.at(-1)!.runId;
	const invalidContent = `Needs more detail.\nLeanFlow run ID: ${runId}`;
	await needsUpdate.handlers.get("tool_call")!(
		{
			toolName: "write",
			toolCallId: "invalid-plan",
			input: { path: EXAMPLE_PLAN_ARTIFACT, content: invalidContent },
		},
		needsUpdate.ctx,
	);
	const invalidPath = resolveRunMarkerPath(needsUpdate.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!;
	writeFileSync(invalidPath, invalidContent);
	await needsUpdate.handlers.get("tool_result")!(
		{ toolName: "write", toolCallId: "invalid-plan", isError: false },
		needsUpdate.ctx,
	);
	expect(needsUpdate.states.at(-1)!.handoffBlockers).toEqual([
		"TARGET_MISSING",
		"BEHAVIOR_MISSING",
		"ACCEPTANCE_MISSING",
		"VERIFICATION_MISSING",
	]);
	expect(JSON.parse(readFileSync(runMarkerPath(needsUpdate), "utf8")).handoffBlockers).toEqual([
		"TARGET_MISSING",
		"BEHAVIOR_MISSING",
		"ACCEPTANCE_MISSING",
		"VERIFICATION_MISSING",
	]);
	expect(needsUpdate.states.at(-1)!.phase).toBe("planning");
	expect(
		await needsUpdate.handlers.get("tool_call")!(
			{ toolName: "write", toolCallId: "invalid-proposal", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			needsUpdate.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("explicitly read-only") });

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
			{ toolName: "write", toolCallId: "missing-marker", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			missingMarker.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("durable run marker") });
});

test("task slugs use bounded ASCII stems with stable task hashes", async () => {
	const cases = [
		{ task: "Fix user login", stem: "fix-user-login" },
		{ task: "修复 login 流程", stem: "login" },
		{ task: "审".repeat(40), stem: "task" },
	] as const;
	const slugs: string[] = [];
	for (const scenario of cases) {
		const harness = createHarness();
		await harness.commands.get("flow")!.handler(scenario.task, harness.ctx);
		const slug = harness.states.at(-1)!.planSlug!;
		const taskHash = createHash("sha256").update(scenario.task, "utf8").digest("hex").slice(0, 8);
		expect(slug).toBe(`${scenario.stem}-${taskHash}`);
		expect(slug).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
		expect(Buffer.byteLength(slug, "utf8")).toBeLessThanOrEqual(39);
		slugs.push(slug);
	}

	const otherChinese = createHarness();
	await otherChinese.commands.get("flow")!.handler("核".repeat(40), otherChinese.ctx);
	expect(otherChinese.states.at(-1)!.planSlug).not.toBe(slugs.at(-1));
});

test("forty-character Chinese tasks persist a fixed-length pointer and can propose", async () => {
	const harness = createHarness();
	const task = "审".repeat(40);
	await harness.commands.get("flow")!.handler(task, harness.ctx);
	const state = harness.states.at(-1)!;
	const slug = state.planSlug!;
	const planArtifact = `local://${slug}-plan.md`;
	const planContent = completeHandoffPlan(
		[
			"修改 src/example.ts 并运行验证。",
			"LSP applicability: required",
			`LeanFlow run ID: ${state.runId}`,
		].join("\n"),
	);
	const call = harness.handlers.get("tool_call")!;
	await call(
		{ toolName: "write", toolCallId: "unicode-plan", input: { path: planArtifact, content: planContent } },
		harness.ctx,
	);
	writeFileSync(resolveRunMarkerPath(harness.ctx.localProtocolOptions, planArtifact)!, planContent);
	await harness.handlers.get("tool_result")!(
		{ toolName: "write", toolCallId: "unicode-plan", isError: false },
		harness.ctx,
	);

	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");
	const pointerPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, hashedPointerArtifact(slug))!;
	expect(basename(pointerPath)).toMatch(/^[0-9a-f]{64}\.json$/);
	expect(Buffer.byteLength(basename(pointerPath), "utf8")).toBe(69);
	expect(existsSync(pointerPath)).toBe(true);
	const legacyPointerPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, legacyPointerArtifact(task))!;
	expect(Buffer.byteLength(basename(legacyPointerPath), "utf8")).toBeGreaterThan(255);
	expect(
		await call(
			{ toolName: "write", toolCallId: "unicode-proposal", input: { path: "xd://propose", content: slug } },
			harness.ctx,
		),
	).toBeUndefined();
});

test("proposal dispatch and Refine remain in Planner context and revised plans are assessed", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;

	expect(
		await call(
			{ toolName: "write", toolCallId: "propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			harness.ctx,
		),
	).toBeUndefined();
	await result({ toolName: "write", toolCallId: "propose", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "awaiting_approval",
		proposalBoundary: expect.any(Number),
		proposedPlanArtifact: EXAMPLE_PLAN_ARTIFACT,
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
			input: { path: EXAMPLE_PLAN_ARTIFACT, content: "Needs more detail." },
		},
		harness.ctx,
	);
	writeFileSync(
		resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!,
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
		{ toolName: "write", toolCallId: "propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose", isError: false }, harness.ctx);

	const beforeApproval = await call(
		{ toolName: "edit", toolCallId: "edit-before-approval", input: {} },
		harness.ctx,
	);
	expect(beforeApproval).toMatchObject({ block: true, reason: expect.stringContaining("native plan approval") });
	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");

	harness.branch.push({ type: "mode_change", mode: "none" });
	const afterModeExit = await call(
		{ toolName: "edit", toolCallId: "edit-after-mode-exit", input: {} },
		harness.ctx,
	);
	expect(afterModeExit).toMatchObject({ block: true, reason: expect.stringContaining("native plan approval") });

	const contextResult = await context({ messages: approvalMessages }, harness.ctx);
	expect(contextResult).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});

	expect(
		await call(
			{ toolName: "write", toolCallId: "other-device", input: { path: "xd://other", content: "{}" } },
			harness.ctx,
		),
	).toMatchObject({ block: true });
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
	).toMatchObject({ block: true });
	expect(harness.states.at(-1)!.lspProbeStatus).toBe("pending");
	for (const file of ["", "   ", "../outside.ts", "/tmp/outside.ts"]) {
		const toolCallId = `invalid-probe-${JSON.stringify(file)}`;
		expect(
			await call(
				{
					toolName: "write",
					toolCallId,
					input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file }) },
				},
				harness.ctx,
			),
		).toMatchObject({ block: true });
		expect(harness.states.at(-1)!.lspProbeStatus).toBe("pending");
	}
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "missing-probe-target",
				input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/does-not-exist.ts" }) },
			},
			harness.ctx,
		),
	).toBeUndefined();
	await result(
		{
			toolName: "write",
			toolCallId: "missing-probe-target",
			isError: true,
			content: [{ type: "text", text: "No LSP server accepted the missing target." }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)!.lspProbeStatus).toBe("pending");

	const blocked = await call({ toolName: "edit", toolCallId: "edit-before-probe", input: {} }, harness.ctx);
	expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("valid LSP diagnostics probe") });

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
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "pending",
		lspLease: { toolCallId: "probe", kind: "lsp", lspTarget: "src/example.ts" },
	});
	await result({ toolName: "write", toolCallId: "probe", isError: true }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "completed",
		lspProbeTarget: "src/example.ts",
		lspLease: undefined,
	});


	expect(
		await call(
			{ toolName: "write", toolCallId: "direct-build-artifact", input: { path: EXAMPLE_BUILD_ARTIFACT, content: "build" } },
			harness.ctx,
		),
	).toMatchObject({
		block: true,
		reason: expect.stringContaining("extension-generated"),
	});
	expect(
		await call({ toolName: "edit", toolCallId: "edit-before-baseline", input: {} }, harness.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("immutable BUILD baseline") });
	const capture = await executeRegisteredTool(harness, "leanflow_capture_baseline", {});
	expect(capture.isError).not.toBe(true);
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", baselineCaptured: true });
	expect(
		await call({ toolName: "edit", toolCallId: "edit-after-baseline", input: {} }, harness.ctx),
	).toBeUndefined();
});
test("session restoration clears a pending LSP lease and ignores its late result", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "leased-probe-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "leased-probe-propose", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "leased-probe",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/example.ts" }) },
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "pending",
		lspLease: { toolCallId: "leased-probe", lspTarget: "src/example.ts" },
	});

	await harness.handlers.get("session_switch")!({}, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		lspProbeStatus: "pending",
		lspLease: undefined,
	});
	const stateCountAfterRestore = harness.states.length;

	await result({ toolName: "write", toolCallId: "leased-probe", isError: false }, harness.ctx);
	expect(harness.states).toHaveLength(stateCountAfterRestore);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "pending",
		lspLease: undefined,
	});

	await call(
		{
			toolName: "write",
			toolCallId: "replacement-probe",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/example.ts" }) },
		},
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "replacement-probe", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "completed",
		lspProbeTarget: "src/example.ts",
		lspLease: undefined,
	});
});

test("the observed xd LSP dispatch and issue report remain reachable before the baseline", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-native-lsp", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-native-lsp", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	const diagnosticsFile = "lib/SS/Logic/Visitor/Attendance.pm";
	mkdirSync(dirname(join(harness.ctx.cwd, diagnosticsFile)), { recursive: true });
	writeFileSync(join(harness.ctx.cwd, diagnosticsFile), "package SS::Logic::Visitor::Attendance;\n");

	const reportContent = "lsp: native diagnostics was blocked before the LeanFlow baseline";
	const routedReportToolCallId = "routed-report-native-lsp";
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: routedReportToolCallId,
				input: { path: "xd://report_issue", content: reportContent },
			},
			harness.ctx,
		),
	).toBeUndefined();
	const nativeReportToolCallId = "native-report-native-lsp";
	expect(
		await call(
			{
				toolName: "report_issue",
				toolCallId: nativeReportToolCallId,
				input: { report: reportContent },
			},
			harness.ctx,
		),
	).toBeUndefined();
	await result(
		{
			toolName: "report_issue",
			toolCallId: nativeReportToolCallId,
			isError: false,
			content: [{ type: "text", text: "Noted, thanks!" }],
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: routedReportToolCallId,
			isError: false,
			details: { xdev: { tool: "report_issue", mode: "execute", args: { report: reportContent } } },
			content: [{ type: "text", text: "Noted, thanks!" }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)!.buildMutationObserved).not.toBe(true);

	const diagnosticsInput = { action: "diagnostics", file: diagnosticsFile, timeout: 300 };
	const routedToolCallId = "routed-lsp-diagnostics";
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: routedToolCallId,
				input: { path: "xd://lsp", content: JSON.stringify(diagnosticsInput) },
			},
			harness.ctx,
		),
	).toBeUndefined();

	const nativeToolCallId = "native-lsp-diagnostics";
	expect(
		await call(
			{
				toolName: "lsp",
				toolCallId: nativeToolCallId,
				input: diagnosticsInput,
			},
			harness.ctx,
		),
	).toBeUndefined();
	await result(
		{
			toolName: "lsp",
			toolCallId: nativeToolCallId,
			isError: true,
			content: [{ type: "text", text: "No LSP server accepted the target." }],
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: routedToolCallId,
			isError: true,
			details: { xdev: { tool: "lsp", mode: "execute", args: diagnosticsInput, tier: "read" } },
			content: [{ type: "text", text: "No LSP server accepted the target." }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "completed",
		lspProbeTarget: diagnosticsFile,
	});

	const captureToolCallId = "baseline-after-native-lsp";
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: captureToolCallId,
				input: { path: "xd://leanflow_capture_baseline", content: "{}" },
			},
			harness.ctx,
		),
	).toBeUndefined();
	const capture = await harness.tools
		.get("leanflow_capture_baseline")!
		.execute(captureToolCallId, {}, undefined, undefined, harness.ctx);
	expect(capture.isError).not.toBe(true);
});


test("admits strict xd-routed extension tools without recording repository mutations", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	const call = harness.handlers.get("tool_call")!;

	for (const input of [
		{ path: "xd://leanflow_capture_baseline", content: "not json" },
		{ path: "xd://leanflow_capture_baseline", content: JSON.stringify({ unexpected: true }) },
		{ path: "xd://leanflow_finalize_artifacts", content: JSON.stringify({ validationCommands: [] }) },
		{
			path: "xd://leanflow_finalize_artifacts",
			content: JSON.stringify({ validationCommands: ["bun test"], unexpected: true }),
		},
	]) {
		expect(
			await call({ toolName: "write", toolCallId: `malformed-route-${input.content}`, input }, harness.ctx),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("strict schema"),
		});
	}

	const validationCommands = ["bun test tests/leanflow_lsp_guard.test.ts"];
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "routed-finalize-before-baseline",
				input: {
					path: "xd://leanflow_finalize_artifacts",
					content: JSON.stringify({ validationCommands }),
				},
			},
			harness.ctx,
		),
	).toMatchObject({
		block: true,
		reason: expect.stringContaining("immutable BUILD baseline"),
	});

	const captureToolCallId = "routed-baseline";
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: captureToolCallId,
				input: { path: "xd://leanflow_capture_baseline", content: "{}" },
			},
			harness.ctx,
		),
	).toBeUndefined();
	expect(harness.states.at(-1)!.buildMutationObserved).not.toBe(true);
	const capture = await harness.tools
		.get("leanflow_capture_baseline")!
		.execute(captureToolCallId, {}, undefined, undefined, harness.ctx);
	expect(capture.isError).not.toBe(true);

	await recordSuccessfulValidation(harness, validationCommands[0]!);
	const finalizeToolCallId = "routed-finalize";
	const finalizeParams = { validationCommands };
	const stateCountBeforeFinalize = harness.states.length;
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: finalizeToolCallId,
				input: {
					path: "xd://leanflow_finalize_artifacts",
					content: JSON.stringify(finalizeParams),
				},
			},
			harness.ctx,
		),
	).toBeUndefined();
	expect(harness.states).toHaveLength(stateCountBeforeFinalize);
	const finalized = await harness.tools
		.get("leanflow_finalize_artifacts")!
		.execute(finalizeToolCallId, finalizeParams, undefined, undefined, harness.ctx);
	expect(finalized.isError).not.toBe(true);
});


test("accepts documented diagnostics timeout before the BUILD baseline", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-timeout", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-timeout", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);

	const probeTarget = "extensions/leanflow/index.ts";
	mkdirSync(dirname(join(harness.ctx.cwd, probeTarget)), { recursive: true });
	writeFileSync(join(harness.ctx.cwd, probeTarget), "export {};\n");

	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "probe-timeout",
				input: {
					path: "xd://lsp",
					content: JSON.stringify({
						action: "diagnostics",
						file: probeTarget,
						timeout: 60,
					}),
				},
			},
			harness.ctx,
		),
	).toBeUndefined();
	await result({ toolName: "write", toolCallId: "probe-timeout", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "completed",
		lspProbeTarget: probeTarget,
	});
});

test("BUILD record setup failure keeps approval out of BUILD", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	mkdirSync(buildRecordPath(harness), { recursive: true });

	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-build-record-failure", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-build-record-failure", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	const snapshotsBeforeApproval = harness.states.length;
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);

	expect(harness.states.at(-1)).toMatchObject({ phase: "awaiting_approval" });
	expect(harness.states.slice(snapshotsBeforeApproval)).not.toContainEqual(expect.objectContaining({ phase: "building" }));
	expect(harness.notifications.at(-1)).toContain("Cannot enter BUILD:");
});

test("fresh recovery falls back to a legacy percent-encoded pointer", async () => {
	const harness = createHarness();
	const slug = "审".repeat(10);
	const runId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
	const planArtifact = `local://${slug}-plan.md`;
	const planContent = completeHandoffPlan(
		[
			"修改 src/example.ts 并运行验证。",
			`LeanFlow run ID: ${runId}`,
			"LSP applicability: required",
		].join("\n"),
	);
	const artifacts = writeFreshArtifacts(harness, { planContent, pointer: "legacy", slug });
	const hashedPath = resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		hashedPointerArtifact(slug),
	)!;
	expect(basename(artifacts.pointerPath)).toContain(encodeURIComponent("审"));
	expect(Buffer.byteLength(basename(artifacts.pointerPath), "utf8")).toBeLessThan(255);
	expect(existsSync(artifacts.pointerPath)).toBe(true);
	expect(existsSync(hashedPath)).toBe(false);

	expect(
		await harness.handlers.get("context")!({ messages: approvalMessagesFor(slug, planArtifact) }, harness.ctx),
	).toMatchObject({ messages: [{ role: "user" }, { customType: "leanflow-builder-context" }] });
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		runId,
		planArtifact,
	});
	expect(existsSync(hashedPath)).toBe(true);
});

test("fresh recovery repairs a marker-only run whose legacy pointer name is too long", async () => {
	const harness = createHarness();
	const slug = "审".repeat(40);
	const runId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
	const planArtifact = `local://${slug}-plan.md`;
	const planContent = completeHandoffPlan(
		[
			"修改 src/example.ts 并运行验证。",
			`LeanFlow run ID: ${runId}`,
			"LSP applicability: required",
		].join("\n"),
	);
	writeFreshArtifacts(harness, { planContent, pointer: false, slug });
	const legacyPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, legacyPointerArtifact(slug))!;
	expect(Buffer.byteLength(basename(legacyPath), "utf8")).toBeGreaterThan(255);

	expect(
		await harness.handlers.get("context")!({ messages: approvalMessagesFor(slug, planArtifact) }, harness.ctx),
	).toMatchObject({ messages: [{ role: "user" }, { customType: "leanflow-builder-context" }] });
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		runId,
		planSlug: slug,
		planArtifact,
	});
	expect(
		existsSync(resolveRunMarkerPath(harness.ctx.localProtocolOptions, hashedPointerArtifact(slug))!),
	).toBe(true);
});

test("fresh approval session recovers the native plan identity before enforcing diagnostics", async () => {
	const ordinary = createHarness();
	const ordinaryContext = ordinary.handlers.get("context")!;
	expect(await ordinaryContext({ messages: legacyApprovalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);
	writeFreshArtifacts(ordinary, {
		planContent:
			"Ordinary plan.\nLeanFlow run ID: 4f414c4c-8f8f-4dca-8df3-9e0fabada555\nLSP applicability: required",
		markerOverrides: { planArtifact: "local://different-plan.md" },
		pointer: false,
	});
	expect(await ordinaryContext({ messages: legacyApprovalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);
	writeFreshArtifacts(ordinary, {
		planContent:
			"Ordinary plan.\nLeanFlow run ID: 4f414c4c-8f8f-4dca-8df3-9e0fabada555\nLSP applicability: required",
		markerOverrides: { status: "completed" },
		pointer: false,
	});
	expect(await ordinaryContext({ messages: legacyApprovalMessages }, ordinary.ctx)).toBeUndefined();
	expect(ordinary.states).toHaveLength(0);

	const harness = createHarness();
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const context = harness.handlers.get("context")!;
	const finalPlanContent = completeHandoffPlan(
		[
			"Update src/example.ts with the approved behavior.",
			"Run focused tests and verify the changed source path.",
			"LSP applicability: required",
			`LeanFlow run ID: 4f414c4c-8f8f-4dca-8df3-9e0fabada555`,
		].join("\n"),
	);
	const marker = {
		version: 2,
		runId: "4f414c4c-8f8f-4dca-8df3-9e0fabada555",
		planSlug: LEGACY_SLUG,
		planArtifact: LEGACY_PLAN_ARTIFACT,
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
	const markerArtifact = `local://.leanflow/runs/${marker.runId}.json`;
	const markerPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, markerArtifact)!;
	writeFileSync(
		resolveRunMarkerPath(harness.ctx.localProtocolOptions, LEGACY_PLAN_ARTIFACT)!,
		finalPlanContent,
	);
	mkdirSync(dirname(markerPath), { recursive: true });
	writeFileSync(markerPath, JSON.stringify(marker));
	const legacyPointerPath = resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		legacyPointerArtifact(LEGACY_SLUG),
	)!;
	mkdirSync(dirname(legacyPointerPath), { recursive: true });
	writeFileSync(
		legacyPointerPath,
		JSON.stringify({
			version: 1,
			runId: marker.runId,
			markerArtifact,
			planArtifact: LEGACY_PLAN_ARTIFACT,
			status: "awaiting_approval",
			updatedAt: Date.now(),
		}),
	);

	expect(await context({ messages: legacyApprovalMessages }, harness.ctx)).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		runId: marker.runId,
		scoutCalls: 2,
		planArtifact: LEGACY_PLAN_ARTIFACT,
		proposedPlanArtifact: LEGACY_PLAN_ARTIFACT,
		approvedPlanArtifact: LEGACY_PLAN_ARTIFACT,
		planDigest: createHash("sha256").update(finalPlanContent).digest("hex"),
		lspProbeStatus: "pending",
		stats: { planning: { input: 11, responses: 2 } },
	});

	expect(await call({ toolName: "edit", toolCallId: "fresh-edit-before-probe", input: {} }, harness.ctx)).toMatchObject({
		block: true,
		reason: expect.stringContaining("valid LSP diagnostics probe"),
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
	expect((await executeRegisteredTool(harness, "leanflow_capture_baseline", {})).isError).not.toBe(true);
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
		{ toolName: "write", toolCallId: "propose-docs", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-docs", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", lspProbeStatus: "not_required" });
	expect((await executeRegisteredTool(harness, "leanflow_capture_baseline", {})).isError).not.toBe(true);
	expect(await call({ toolName: "edit", toolCallId: "docs-edit", input: { path: "README.md" } }, harness.ctx)).toBeUndefined();
});

test("successful edits refresh all repair evidence artifacts", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-repair", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-repair", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await completeBuildEvidence(harness, "bun test initial");
	const initialRecord = JSON.parse(readFileSync(buildRecordPath(harness), "utf8"));
	expect(initialRecord).toMatchObject({ round: 1, baseline: { head: "a".repeat(40) } });
	expect(initialRecord.observations).toHaveLength(1);
	await call({ toolName: "task", toolCallId: "gate-1", input: gateCallInput() }, harness.ctx);
	await result(
		{
			toolName: "task",
			toolCallId: "gate-1",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		baselineCaptured: true,
		gateCalls: 1,
		writtenArtifacts: [],
	});
	const repairRecord = JSON.parse(readFileSync(buildRecordPath(harness), "utf8"));
	expect(repairRecord).toMatchObject({ round: 2, baseline: initialRecord.baseline, observations: [] });
	expect(
		await call(
			{
				toolName: "edit",
				toolCallId: "repair-direct-artifacts",
				input: { paths: [EXAMPLE_BUILD_ARTIFACT, EXAMPLE_DIFF_ARTIFACT, EXAMPLE_EVIDENCE_ARTIFACT] },
			},
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("extension-generated") });

	await completeBuildEvidence(harness, "bun test repair");
	expect(harness.states.at(-1)!.writtenArtifacts?.sort()).toEqual(["build", "diff", "evidence"]);
	expect(
		await call({ toolName: "task", toolCallId: "gate-2", input: gateCallInput() }, harness.ctx),
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

test("rejects malformed Gate calls before consuming an attempt", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test gate-shape");
	const canonical = gateCallInput();
	const item = (canonical.tasks as Record<string, unknown>[])[0]!;
	class NonPlainGateCall {
		agent = "gate";
		task = String(item.task);
		schemaMode = "strict";
	}
	const customPrototypeGateCall = Object.assign(Object.create({ inherited: true }), item);
	const malformed: unknown[] = [
		{ context: "LeanFlow Gate", tasks: [{ ...item, outputSchema: { type: "object" } }] },
		{ ...item, outputSchema: { type: "object" } },
		{ context: "", tasks: [item] },
		{ context: "LeanFlow Gate", tasks: [item, item] },
		{ ...item, task: `${item.task} local://wrong-evidence.md` },
		{ agent: "gate", task: item.task },
		{ context: "LeanFlow Gate", tasks: [item], agent: "gate" },
		new NonPlainGateCall(),
		customPrototypeGateCall,
	];
	for (const [index, input] of malformed.entries()) {
		expect(
			await harness.handlers.get("tool_call")!(
				{ toolName: "task", toolCallId: `malformed-gate-${index}`, input },
				harness.ctx,
			),
		).toMatchObject({ block: true });
		expect(harness.states.at(-1)).toMatchObject({
			phase: "building",
			gateCalls: 0,
			gateAttempt: 0,
		});
		expect(harness.states.at(-1)!.gateDispatches ?? 0).toBe(0);
	}
});

test("accepts one strict Gate call with canonical artifact references", async () => {
	for (const batch of [true, false]) {
		const harness = createHarness();
		await enterDocumentationBuild(harness);
		await completeBuildEvidence(harness, `bun test gate-${batch ? "batch" : "flat"}`);
		expect(
			await harness.handlers.get("tool_call")!(
				{
					toolName: "task",
					toolCallId: `valid-gate-${batch ? "batch" : "flat"}`,
					input: gateCallInput({ batch }),
				},
				harness.ctx,
			),

		).toBeUndefined();
		const artifacts = gateArtifacts();
		const readArtifact = (artifact: string) =>
			readFileSync(resolveRunMarkerPath(harness.ctx.localProtocolOptions, artifact)!, "utf8");
		const expectedSnapshot = createHash("sha256")
			.update(
				`${harness.states.at(-1)!.planDigest}\n${readArtifact(artifacts.build)}\n${readArtifact(artifacts.diff)}\n${readArtifact(artifacts.evidence)}`,
				"utf8",
			)
			.digest("hex");
		expect(harness.states.at(-1)).toMatchObject({
			phase: "gating",
			gateCalls: 0,
			gateDispatches: 1,
			gateAttempt: 1,
			gateLease: {
				toolCallId: `valid-gate-${batch ? "batch" : "flat"}`,
				snapshotDigest: expectedSnapshot,
			},
		});
		await harness.handlers.get("tool_result")!(
			{
				toolName: "task",
				toolCallId: `valid-gate-${batch ? "batch" : "flat"}`,
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
			},
			harness.ctx,
		);
		expect(harness.states.at(-1)).toMatchObject({
			phase: "finalizing",
			gateCalls: 1,
			gateLease: undefined,
		});
	}
});

test("snapshot preflight blocks missing canonical artifacts without dispatching Gate", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test snapshot-missing");
	const evidencePath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, gateArtifacts().evidence)!;
	rmSync(evidencePath);

	expect(
		await harness.handlers.get("tool_call")!(
			{ toolName: "task", toolCallId: "snapshot-missing-evidence", input: gateCallInput() },
			harness.ctx,
		),
	).toMatchObject({
		block: true,
		reason: expect.stringContaining("canonical evidence artifact is missing or unreadable"),
	});
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateAttempt: 0,
	});
	expect(harness.states.at(-1)!.gateDispatches ?? 0).toBe(0);
});

test("snapshot preflight blocks Gate while BUILD evidence is unsettled", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test snapshot-pending");
	const call = harness.handlers.get("tool_call")!;
	await call(
		{ toolName: "lsp", toolCallId: "snapshot-pending-observation", input: { action: "hover", file: "src/example.ts" } },
		harness.ctx,
	);

	expect(
		await call({ toolName: "task", toolCallId: "snapshot-pending-gate", input: gateCallInput() }, harness.ctx),
	).toMatchObject({
		block: true,
		reason: expect.stringContaining("BUILD evidence observation(s) are still pending"),
	});
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", gateCalls: 0, gateAttempt: 0 });
});

test("snapshot preflight rejects a stale canonical plan without consuming Gate budget", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test snapshot-plan");
	const planPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, gateArtifacts().plan)!;
	writeFileSync(planPath, `${readFileSync(planPath, "utf8")}\nstale plan`);

	expect(
		await harness.handlers.get("tool_call")!(
			{ toolName: "task", toolCallId: "snapshot-stale-plan", input: gateCallInput() },
			harness.ctx,
		),
	).toMatchObject({
		block: true,
		reason: expect.stringContaining("canonical plan digest does not match the approved plan"),
	});
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", gateCalls: 0, gateAttempt: 0 });
});

test("snapshot preflight rejects a mismatched BUILD record without dispatching Gate", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test snapshot-record");
	const recordPath = buildRecordPath(harness);
	const record = JSON.parse(readFileSync(recordPath, "utf8"));
	writeFileSync(recordPath, JSON.stringify({ ...record, round: 99 }));

	expect(
		await harness.handlers.get("tool_call")!(
			{ toolName: "task", toolCallId: "snapshot-invalid-record", input: gateCallInput() },
			harness.ctx,
		),
	).toMatchObject({
		block: true,
		reason: expect.stringContaining("BUILD record validation failed"),
	});
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", gateCalls: 0, gateAttempt: 0 });
});

test("repair record setup failure pauses for human recovery", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test repair-record-failure");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call({ toolName: "task", toolCallId: "repair-record-failure-gate", input: gateCallInput() }, harness.ctx);
	const recordPath = buildRecordPath(harness);
	rmSync(recordPath);
	mkdirSync(recordPath);

	await result(
		{
			toolName: "task",
			toolCallId: "repair-record-failure-gate",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [{ severity: "blocking" }] }) }],
		},
		harness.ctx,
	);

	expect(harness.states.at(-1)).toMatchObject({ phase: "building", gateCalls: 0, gateRetryMode: "operational" });
	expect(harness.notifications.some((message) => message.includes("Gate result was discarded"))).toBe(true);
});

test("plan drift during Gate becomes an operational recovery", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test snapshot-plan-drift");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call({ toolName: "task", toolCallId: "snapshot-plan-drift", input: gateCallInput() }, harness.ctx);
	const planPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, gateArtifacts().plan)!;
	writeFileSync(planPath, `${readFileSync(planPath, "utf8")}\nplan drift`);

	await result(
		{
			toolName: "task",
			toolCallId: "snapshot-plan-drift",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateDispatches: 1,
		gateRetryMode: "operational",
		stats: { gateErrors: 1 },
	});
	expect(harness.notifications.some((m) => m.includes("retry with unchanged evidence."))).toBe(true);
});
test("session restoration reconciles an interrupted Gate as an interruption", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test gate-lease");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call({ toolName: "task", toolCallId: "leased-gate", input: gateCallInput() }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "gating",
		gateCalls: 0,
		gateLease: { toolCallId: "leased-gate", kind: "gate" },
	});

	await harness.handlers.get("session_switch")!({}, harness.ctx);
	const afterSwitch = harness.states.at(-1)!;
	expect(afterSwitch.phase).toBe("building");
	expect(afterSwitch.gateCalls).toBe(0);
	expect(afterSwitch.gateLease).toBeUndefined();
	expect(afterSwitch.gateRetryMode).toBe("operational");
	expect(afterSwitch.stats!.gateErrors).toBe(0);
	const stateCountAfterRestore = harness.states.length;

	await result(
		{
			toolName: "task",
			toolCallId: "leased-gate",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states).toHaveLength(stateCountAfterRestore);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateLease: undefined,
		gateRetryMode: "operational",
	});
});

test("findings-first nested BLOCKED Gate result returns to evidence recovery without consuming verdict budget", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test blocked-gate");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call({ toolName: "task", toolCallId: "blocked-gate", input: gateCallInput() }, harness.ctx);
	await result(
		{
			toolName: "task",
			toolCallId: "blocked-gate",
			isError: false,
			content: [
				{
					type: "text",
					text: '{"findings":[{"category":"evidence","severity":"blocking"}],"verdict":"BLOCKED"}',
				},
			],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateDispatches: 1,
		gateLease: undefined,
		gateRetryMode: "evidence",
		writtenArtifacts: [],
		stats: { gateBlocked: 1, gateErrors: 0 },
	});
	expect(
		await call({ toolName: "edit", toolCallId: "blocked-evidence-source-edit", input: { path: "src/example.ts" } }, harness.ctx),
	).toMatchObject({ block: true });
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "blocked-evidence-source-write",
				input: { path: "src/example.ts", content: "export {};\n" },
			},
			harness.ctx,
		),
	).toMatchObject({ block: true });
	await recordSuccessfulValidation(harness, "bun test tests/leanflow_lsp_guard.test.ts");
	const finalized = await executeRegisteredTool(harness, "leanflow_finalize_artifacts", {
		validationCommands: ["bun test tests/leanflow_lsp_guard.test.ts"],
	});
	expect(finalized.isError).not.toBe(true);

	const allowedEvidenceValidationCommands = [
		"bun test",
		"bun test tests/leanflow_lsp_guard.test.ts",
		"bun test tests/*.test.ts",
		"bunx tsc --noEmit",
		"python3 -m unittest discover -s tests -p 'test_*.py' -v",
		'python -m unittest discover -s tests -p "test_*.py" -v',
		"git diff --check",
		"bun build extensions/leanflow/index.ts --target bun --outfile /tmp/leanflow-bundle.js",
	];
	for (const [index, command] of allowedEvidenceValidationCommands.entries()) {
		// This calls only the guard. A successful result is deliberately not
		// fabricated: the allowlist decision must happen before Bash executes.
		expect(
			await call(
				{ toolName: "bash", toolCallId: `allowed-evidence-validation-${index}`, input: { command } },
				harness.ctx,
			),
		).toBeUndefined();
	}

	const rejectedEvidenceValidationCommands = [
		"bun test --watch",
		"bun test tests/../src/example.test.ts",
		"bunx tsc --noEmit --pretty false",
		"python3 -m unittest discover -s tests -p 'test_*.py' -v --failfast",
		"git diff --check --output=src/example.ts",
		"git diff --check --output src/example.ts",
		"git diff --check --stat",
		"bun build extensions/leanflow/index.ts --target bun --outfile src/example.js",
		"bun build extensions/leanflow/index.ts --target bun --outdir /tmp/leanflow-build",
		"bun build extensions/leanflow/index.ts --target bun --outfile=/tmp/leanflow-bundle.js",
		"git diff --check && printf 'export {};' > src/example.ts",
	];
	for (const [index, command] of rejectedEvidenceValidationCommands.entries()) {
		const stateCountBefore = harness.states.length;
		const stateBefore = JSON.stringify(harness.states.at(-1));
		expect(
			await call(
				{ toolName: "bash", toolCallId: `blocked-evidence-validation-${index}`, input: { command } },
				harness.ctx,
			),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("Gate evidence recovery must reuse the implementation unchanged"),
		});
		expect(harness.states).toHaveLength(stateCountBefore);
		expect(JSON.stringify(harness.states.at(-1))).toBe(stateBefore);
	}
});

test("evidence recovery accepts only command-only Bash validations while Gate is in flight", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test evidence-retry-gate");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;

	await call({ toolName: "task", toolCallId: "evidence-retry-blocked-gate", input: gateCallInput() }, harness.ctx);
	await result(
		{
			toolName: "task",
			toolCallId: "evidence-retry-blocked-gate",
			isError: false,
			content: [{ type: "text", text: '{"verdict":"BLOCKED","findings":[]}' }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({ phase: "building", gateRetryMode: "evidence" });

	await recordSuccessfulValidation(harness, "git diff --check");
	const recordWithPlainValidation = JSON.parse(readFileSync(buildRecordPath(harness), "utf8"));
	expect(recordWithPlainValidation.observations).toContainEqual(
		expect.objectContaining({ toolName: "bash", command: "git diff --check" }),
	);
	const finalized = await executeRegisteredTool(harness, "leanflow_finalize_artifacts", {
		validationCommands: ["git diff --check"],
	});
	expect(finalized.isError).not.toBe(true);

	expect(
		await call({ toolName: "task", toolCallId: "evidence-retry-inflight-gate", input: gateCallInput() }, harness.ctx),
	).toBeUndefined();
	expect(harness.states.at(-1)).toMatchObject({ phase: "gating", gateRetryMode: "evidence" });
	const stateCountBeforeDeniedCalls = harness.states.length;
	const stateBeforeDeniedCalls = JSON.stringify(harness.states.at(-1));
	const recordBeforeDeniedCalls = readFileSync(buildRecordPath(harness), "utf8");
	const deniedInputs: Array<[string, Record<string, unknown>]> = [
		["mutating command", { command: "git diff --check && touch src/example.ts" }],
		["PATH environment", { command: "git diff --check", env: { PATH: "/tmp/attacker" } }],
		["working directory", { command: "git diff --check", cwd: "/tmp" }],
		["timeout", { command: "git diff --check", timeout: 1 }],
		["unknown option", { command: "git diff --check", unexpected: "value" }],
		["PTY", { command: "git diff --check", pty: true }],
		["async execution", { command: "git diff --check", async: true }],
	];
	for (const [name, input] of deniedInputs) {
		expect(
			await call(
				{ toolName: "bash", toolCallId: `blocked-evidence-gating-${name}`, input },
				harness.ctx,
			),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("Gate evidence recovery must reuse the implementation unchanged"),
		});
		expect(harness.states).toHaveLength(stateCountBeforeDeniedCalls);
		expect(JSON.stringify(harness.states.at(-1))).toBe(stateBeforeDeniedCalls);
		expect(readFileSync(buildRecordPath(harness), "utf8")).toBe(recordBeforeDeniedCalls);
	}
});

test("findings-first nested FAIL Gate result settles as a verdict failure", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test findings-first-fail");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call({ toolName: "task", toolCallId: "findings-first-fail", input: gateCallInput() }, harness.ctx);
	await result(
		{
			toolName: "task",
			toolCallId: "findings-first-fail",
			isError: false,
			content: [
				{
					type: "text",
					text: '{"findings":[{"category":"correctness","severity":"blocking"}],"verdict":"FAIL"}',
				},
			],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		gateCalls: 1,
		gateRetryMode: "repair",
		gateLease: undefined,
		lastGateFindings: '{"findings":[{"category":"correctness","severity":"blocking"}],"verdict":"FAIL"}',
		writtenArtifacts: [],
		stats: { gateErrors: 0, gateVerdictFailures: 1 },
	});
});

test("BUILD sequence reaches batch Gate through generated artifacts", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "smoke-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "smoke-propose", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "smoke-pre-lsp",
			input: {
				path: "xd://lsp",
				content: JSON.stringify({ action: "diagnostics", file: "src/example.ts", timeout: 60 }),
			},
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: "smoke-pre-lsp",
			isError: false,
			content: [{ type: "text", text: "typescript-language-server: pre-edit clean" }],
		},
		harness.ctx,
	);
	expect((await executeRegisteredTool(harness, "leanflow_capture_baseline", {})).isError).not.toBe(true);
	expect(
		await call(
			{ toolName: "edit", toolCallId: "smoke-source-edit", input: { path: "src/example.ts" } },
			harness.ctx,
		),
	).toBeUndefined();
	await result({ toolName: "edit", toolCallId: "smoke-source-edit", isError: false }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "smoke-post-lsp",
			input: {
				path: "xd://lsp",
				content: JSON.stringify({ action: "diagnostics", file: "src/example.ts", timeout: 60 }),
			},
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: "smoke-post-lsp",
			isError: false,
			content: [{ type: "text", text: "typescript-language-server: post-edit clean" }],
		},
		harness.ctx,
	);
	await recordSuccessfulValidation(harness, "bun test smoke");
	const finalized = await executeRegisteredTool(harness, "leanflow_finalize_artifacts", {
		validationCommands: ["bun test smoke"],
	});
	expect(finalized.isError).not.toBe(true);
	const build = readFileSync(resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_BUILD_ARTIFACT)!, "utf8");
	expect(build).toContain("### LSP 1: diagnostics");
	expect(build).toContain("### LSP 2: diagnostics");
	expect(build).toContain("### Validation 1: bun test smoke");
	expect(
		await call({ toolName: "task", toolCallId: "smoke-batch-gate", input: gateCallInput() }, harness.ctx),
	).toBeUndefined();
	expect(harness.states.at(-1)).toMatchObject({
		phase: "gating",
		gateCalls: 0,
		gateDispatches: 1,
		gateAttempt: 1,
		gateLease: { toolCallId: "smoke-batch-gate" },
	});
});

test("records only allowed bash and LSP results and clears skipped pending calls", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "record-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "record-propose", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "record-initial-lsp",
			input: {
				path: "xd://lsp",
				content: JSON.stringify({ action: "diagnostics", file: "src/example.ts", timeout: 60 }),
			},
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: "record-initial-lsp",
			isError: false,
			content: [{ type: "text", text: "typescript-language-server: no diagnostics" }],
		},
		harness.ctx,
	);
	expect(
		await call({ toolName: "bash", toolCallId: "blocked-before-baseline", input: { command: "echo blocked" } }, harness.ctx),
	).toMatchObject({ block: true });
	expect((await executeRegisteredTool(harness, "leanflow_capture_baseline", {})).isError).not.toBe(true);

	await call({ toolName: "bash", toolCallId: "recorded-bash", input: { command: "bun test focused" } }, harness.ctx);
	await result(
		{
			toolName: "bash",
			toolCallId: "recorded-bash",
			isError: false,
			details: {},
			content: [{ type: "text", text: "1 pass\n0 fail\nRan 1 test." }],
		},
		harness.ctx,
	);
	await call(
		{
			toolName: "write",
			toolCallId: "recorded-lsp-status",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "status", timeout: 60 }) },
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: "recorded-lsp-status",
			isError: false,
			content: [{ type: "text", text: "typescript-language-server: running" }],
		},
		harness.ctx,
	);
	expect(
		await call(
			{ toolName: "write", toolCallId: "blocked-direct-diff", input: { path: EXAMPLE_DIFF_ARTIFACT, content: "x" } },
			harness.ctx,
		),
	).toMatchObject({ block: true });

	const beforeSkipped = JSON.parse(readFileSync(buildRecordPath(harness), "utf8"));
	expect(beforeSkipped.observations).toHaveLength(3);
	expect(beforeSkipped.observations.map((observation: { toolName: string }) => observation.toolName)).toEqual([
		"lsp",
		"bash",
		"lsp",
	]);
	await call({ toolName: "bash", toolCallId: "skipped-bash", input: { command: "bun test skipped" } }, harness.ctx);
	await harness.handlers.get("agent_end")!({ willContinue: true }, harness.ctx);
	await result(
		{
			toolName: "bash",
			toolCallId: "skipped-bash",
			isError: false,
			details: {},
			content: [{ type: "text", text: "must not be recorded" }],
		},
		harness.ctx,
	);
	const afterSkipped = JSON.parse(readFileSync(buildRecordPath(harness), "utf8"));
	expect(afterSkipped.observations).toEqual(beforeSkipped.observations);
});

test("observation persistence failure remains fail-closed after agent end", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "failure-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "failure-propose", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "failure-lsp",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/example.ts" }) },
		},
		harness.ctx,
	);
	const recordPath = buildRecordPath(harness);
	rmSync(recordPath, { force: true });
	mkdirSync(recordPath, { recursive: true });
	await result(
		{
			toolName: "write",
			toolCallId: "failure-lsp",
			isError: false,
			content: [{ type: "text", text: "no diagnostics" }],
		},
		harness.ctx,
	);
	await harness.handlers.get("agent_end")!({ willContinue: true }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		lspProbeStatus: "completed",
		baselineCaptured: false,
		buildMutationObserved: true,
		writtenArtifacts: [],
	});
	const capture = await executeRegisteredTool(harness, "leanflow_capture_baseline", {});
	expect(capture.isError).toBe(true);
	expect(JSON.stringify(capture.content)).toContain("/flowcancel");
});

test("partial artifact writes never mark Gate evidence ready", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	expect((await executeRegisteredTool(harness, "leanflow_capture_baseline", {})).isError).not.toBe(true);
	await recordSuccessfulValidation(harness, "bun test partial-write");
	const diffPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_DIFF_ARTIFACT)!;
	mkdirSync(diffPath, { recursive: true });

	const finalized = await executeRegisteredTool(harness, "leanflow_finalize_artifacts", {
		validationCommands: ["bun test partial-write"],
	});
	expect(finalized.isError).toBe(true);
	expect(harness.states.at(-1)!.writtenArtifacts).toEqual([]);
	expect(existsSync(resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_BUILD_ARTIFACT)!)).toBe(true);
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

	const backtickFence = createHarness();
	await writeInitialPlan(
		backtickFence,
		[
			"Change source and run focused tests.",
			"```md",
			"~~~",
			"LSP applicability: not_required",
			"~~~",
			"```",
			"LSP applicability: required",
		].join("\n"),
	);
	expect(backtickFence.states.at(-1)!.handoffWarnings?.join("\n") ?? "").not.toContain("exactly one");

	const tildeFence = createHarness();
	await writeInitialPlan(
		tildeFence,
		[
			"Change source and run focused tests.",
			"~~~md",
			"```",
			"LSP applicability: not_required",
			"```",
			"~~~",
			"LSP applicability: required",
		].join("\n"),
	);
	expect(tildeFence.states.at(-1)!.handoffWarnings?.join("\n") ?? "").not.toContain("exactly one");
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
			input: { path: EXAMPLE_PLAN_ARTIFACT, content: "Needs more detail." },
		},
		harness.ctx,
	);
	writeFileSync(
		resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!,
		"Needs more detail.",
	);
	await result({ toolName: "write", toolCallId: "needs-update", isError: false }, harness.ctx);
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("invalidated");
});

test("flowstatus is read-only in every phase and reports deep Gate readiness", async () => {
	const harness = createHarness();
	const idleSnapshots = harness.states.length;

	await harness.commands.get("flowstatus")!.handler("", harness.ctx);

	expect(harness.states).toHaveLength(idleSnapshots);
	expect(harness.notifications.at(-1)).toBe(
		[
			"LeanFlow status:",
			"- Phase: idle",
			"- Run ID: unavailable",
			"- Plan digest: unavailable",
			"- Repair round: 0",
			"- Gate verdicts: 0/2",
			"- Gate dispatches: 0",
			"- Gate blocked: 0",
			"- Consecutive errors: 0/4",
			"- Pending evidence observations: 0",
			"- Baseline captured: no",
			"- Written artifacts: 0/3 (none / build, diff, evidence)",
			"- LSP probe: pending",
			"- Human repair cycles: 0",
			"- Gate readiness: BLOCKED: missing artifact marks: build.md, diff.md, evidence.md",
		].join("\n"),
	);

	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness);
	const state = harness.states.at(-1)!;
	await harness.commands.get("flowstatus")!.handler("", harness.ctx);
	expect(harness.notifications.at(-1)).toContain("- Gate readiness: READY (deep:");
	const evidencePath = resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		`local://${state.planSlug}-evidence.md`,
	)!;
	rmSync(evidencePath);
	const buildingSnapshots = harness.states.length;

	await harness.commands.get("flowstatus")!.handler("", harness.ctx);

	expect(harness.states).toHaveLength(buildingSnapshots);
	expect(harness.notifications.at(-1)).toContain("- Gate readiness: BLOCKED:");
});

test("flowcancel abandons an active recovery marker", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{
			toolName: "write",
			toolCallId: "flowcancel-propose",
			input: { path: "xd://propose", content: EXAMPLE_SLUG },
		},
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "flowcancel-propose", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "flowcancel-pre-lsp",
			input: {
				path: "xd://lsp",
				content: JSON.stringify({ action: "diagnostics", file: "src/example.ts", timeout: 60 }),
			},
		},
		harness.ctx,
	);
	await result(
		{
			toolName: "write",
			toolCallId: "flowcancel-pre-lsp",
			isError: false,
			content: [{ type: "text", text: "typescript-language-server: pre-edit clean" }],
		},
		harness.ctx,
	);
	expect((await executeRegisteredTool(harness, "leanflow_capture_baseline", {})).isError).not.toBe(true);
	expect(
		await call(
			{ toolName: "edit", toolCallId: "flowcancel-source-edit", input: { path: "src/example.ts" } },
			harness.ctx,
		),
	).toBeUndefined();
	await result({ toolName: "edit", toolCallId: "flowcancel-source-edit", isError: false }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		baselineCaptured: true,
		buildMutationObserved: true,
	});
	await harness.commands.get("flowcancel")!.handler("", harness.ctx);
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("abandoned");
	expect(harness.states.at(-1)).toMatchObject({
		phase: "idle",
		baselineCaptured: false,
		buildMutationObserved: false,
	});
});
test("flowcancel clears persisted lease and Gate recovery state", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	const activeState = harness.states.at(-1)!;
	const now = Date.now();
	harness.branch.push({
		type: "custom",
		customType: "leanflow-state",
		data: {
			...activeState,
			phase: "building",
			lspProbeStatus: "completed",
			gateLease: {
				toolCallId: "cancel-gate",
				kind: "gate",
				runId: activeState.runId!,
				cycle: 3,
				startedAt: now,
				snapshotDigest: "snapshot",
			},
			lspLease: {
				toolCallId: "cancel-lsp",
				kind: "lsp",
				runId: activeState.runId!,
				cycle: 0,
				startedAt: now,
				lspTarget: "src/example.ts",
			},
			gateDispatches: 3,
			humanRepairCycles: 2,
			lastGateFindings: '{"findings":["must clear"]}',
		},
	});
	await harness.handlers.get("session_switch")!({}, harness.ctx);

	await harness.commands.get("flowcancel")!.handler("", harness.ctx);
	const cancelled = harness.states.at(-1)! as unknown as Record<string, unknown>;
	for (const field of [
		"gateLease",
		"lspLease",
		"gateDispatches",
		"humanRepairCycles",
		"lastGateFindings",
	]) {
		expect(cancelled[field]).toBeUndefined();
	}
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
	const artifact = `local://.leanflow/runs/${runId}.json`;
	const markerPath = join(tmpdir(), "omp-local", sessionId, ".leanflow", "runs", `${runId}.json`);
	expect(existsSync(markerPath)).toBe(true);
	const windowsPath = resolveRunMarkerPath(
		{ getArtifactsDir: () => `C:\\${"very-long-root\\".repeat(20)}`, getSessionId: () => sessionId },
		artifact,
		"win32",
	);
	expect(windowsPath).toBe(join(tmpdir(), "omp-local", sessionId, ".leanflow", "runs", `${runId}.json`));
	rmSync(join(tmpdir(), "omp-local", sessionId), { recursive: true, force: true });
});

test("Gate operational errors preserve evidence and do not enter repair", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-error", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-error", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await completeBuildEvidence(harness, "bun test operational");
	const recordBeforeRetry = readFileSync(buildRecordPath(harness), "utf8");
	await call({ toolName: "task", toolCallId: "gate-error", input: gateCallInput() }, harness.ctx);
	await result({ toolName: "task", toolCallId: "gate-error", isError: true, content: [] }, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "building",
		gateCalls: 0,
		gateRetryMode: "operational",
		writtenArtifacts: ["build", "diff", "evidence"],
		stats: { gateErrors: 1, repairRounds: 0 },
	});
	const retryContext = await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(JSON.stringify(retryContext)).toContain("retry Gate with unchanged evidence");
	expect(JSON.stringify(retryContext)).not.toContain("implement it");
	expect(
		await call({ toolName: "edit", toolCallId: "operational-edit", input: { path: "README.md" } }, harness.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("unchanged") });
	expect(readFileSync(buildRecordPath(harness), "utf8")).toBe(recordBeforeRetry);
	expect(
		await call({ toolName: "task", toolCallId: "gate-retry", input: gateCallInput() }, harness.ctx),
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

test("four consecutive Gate operational errors pause instead of looping indefinitely", async () => {
	const harness = createHarness();
	await enterDocumentationBuild(harness);
	await completeBuildEvidence(harness, "bun test operational-cap");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;

	for (const attempt of [1, 2, 3, 4]) {
		await call({ toolName: "task", toolCallId: `operational-cap-${attempt}`, input: gateCallInput() }, harness.ctx);
		await result({ toolName: "task", toolCallId: `operational-cap-${attempt}`, isError: true, content: [] }, harness.ctx);
	}

	expect(harness.states.at(-1)).toMatchObject({
		phase: "awaiting_human",
		gateCalls: 0,
		gateRetryMode: "operational",
		stats: { gateErrors: 4 },
	});
	expect(JSON.parse(readFileSync(runMarkerPath(harness), "utf8")).status).toBe("paused");
});

test("Gate PASS completes marker and preserves filtering through final agent end", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-pass", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-pass", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await completeBuildEvidence(harness, "bun test pass");
	await call({ toolName: "task", toolCallId: "gate-pass", input: gateCallInput() }, harness.ctx);
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
	expect(
		await call(
			{
				toolName: "todo",
				toolCallId: "final-todo-done",
				input: { op: "done", task: "Run LeanFlow Gate and repair findings" },
			},
			harness.ctx,
		),
	).toBeUndefined();
	const nullPrototypeInput = Object.assign(Object.create(null), {
		op: "done",
		task: "Run LeanFlow Gate and repair findings",
	});
	expect(
		await call(
			{
				toolName: "todo",
				toolCallId: "final-todo-null-prototype",
				input: nullPrototypeInput,
			},
			harness.ctx,
		),
	).toBeUndefined();
	class FinalizingTodoInput {
		op = "done";
		task = "Run LeanFlow Gate and repair findings";
	}
	const customPrototypeInput = Object.assign(Object.create({ inherited: true }), {
		op: "done",
		task: "Run LeanFlow Gate and repair findings",
	});
	const nonPlainTodoInputs = [new FinalizingTodoInput(), customPrototypeInput];
	for (const [index, input] of nonPlainTodoInputs.entries()) {
		expect(
			await call(
				{
					toolName: "todo",
					toolCallId: `final-todo-non-plain-${index}`,
					input,
				},
				harness.ctx,
			),
		).toMatchObject({
			block: true,
			reason: expect.stringContaining("no tools"),
		});
	}
	for (const event of [
		{ toolName: "read", toolCallId: "final-read", input: { path: "README.md" } },
		{ toolName: "grep", toolCallId: "final-grep", input: { pattern: "x" } },
		{ toolName: "write", toolCallId: "final-lsp", input: { path: "xd://lsp", content: "{}" } },
		{ toolName: "web_search", toolCallId: "final-web", input: { query: "x" } },
		{ toolName: "task", toolCallId: "final-task", input: { agent: "gate", task: "again" } },
		{ toolName: "edit", toolCallId: "final-edit", input: { path: "README.md" } },
		{
			toolName: "write",
			toolCallId: "final-plan-named-write",
			input: { path: "docs/release-plan.md", content: "x" },
		},
		{ toolName: "todo", toolCallId: "final-todo-no-target", input: { op: "done" } },
		{ toolName: "todo", toolCallId: "final-todo-phase", input: { op: "done", phase: "Gate" } },
		{
			toolName: "todo",
			toolCallId: "final-todo-task-and-phase",
			input: { op: "done", task: "Run LeanFlow Gate and repair findings", phase: "Gate" },
		},
		{ toolName: "todo", toolCallId: "final-todo-empty-task", input: { op: "done", task: "   " } },
		{
			toolName: "todo",
			toolCallId: "final-todo-extra-field",
			input: { op: "done", task: "Run LeanFlow Gate and repair findings", reason: "x" },
		},
		{ toolName: "todo", toolCallId: "final-todo-view", input: { op: "view" } },
		{
			toolName: "todo",
			toolCallId: "final-todo-drop",
			input: { op: "drop", task: "Run LeanFlow Gate and repair findings" },
		},
		{
			toolName: "todo",
			toolCallId: "final-todo-batch",
			input: { ops: [{ op: "done", task: "Run LeanFlow Gate and repair findings" }] },
		},
	]) {
		expect(await call(event, harness.ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("no tools"),
		});
	}
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("completed");
	const finalContext = await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(finalContext).toMatchObject({
		messages: [{ role: "user" }, { customType: "leanflow-builder-context" }],
	});
	const finalPrompt = JSON.stringify(finalContext);
	expect(finalPrompt).not.toContain("implement it");
	expect(finalPrompt).not.toContain("Then call Gate");
	expect(finalPrompt).toContain('exactly one todo tool with input {\\"op\\":\\"done\\",\\"task\\":\\"existing task content\\"}');
	expect(finalPrompt).toContain("Do not call any other tools");
	expect(await call({ toolName: "edit", toolCallId: "late-edit", input: { path: "README.md" } }, harness.ctx)).toMatchObject({
		block: true,
		reason: expect.stringContaining("no tools"),
	});
	await harness.handlers.get("agent_end")!({ willContinue: true }, harness.ctx);
	expect(harness.states.at(-1)!.phase).toBe("finalizing");
	await harness.handlers.get("agent_end")!({}, harness.ctx);
	expect(harness.states.at(-1)!.phase).toBe("idle");
});

test("terminal PASS remains authoritative when marker persistence fails", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-marker-failure", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-marker-failure", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await completeBuildEvidence(harness, "bun test marker-failure");
	await call(
		{ toolName: "task", toolCallId: "gate-marker-failure", input: gateCallInput() },
		harness.ctx,
	);
	chmodSync(dirname(runMarkerPath(harness)), 0o500);
	await result(
		{
			toolName: "task",
			toolCallId: "gate-marker-failure",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "PASS", findings: [] }) }],
		},
		harness.ctx,
	);
	expect(harness.states.at(-1)).toMatchObject({ phase: "finalizing", terminalOutcome: "pass" });
	const finalContext = await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	expect(JSON.stringify(finalContext)).toContain("Gate passed");
});

test("second Gate FAIL pauses the run and flowcontinue starts a human repair cycle", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-fail", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-fail", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await completeBuildEvidence(harness, "bun test fail-1");
	for (const attempt of [1, 2]) {
		await call({ toolName: "task", toolCallId: `gate-fail-${attempt}`, input: gateCallInput() }, harness.ctx);
		await result(
			{
				toolName: "task",
				toolCallId: `gate-fail-${attempt}`,
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [{ severity: "blocking" }] }) }],
			},
			harness.ctx,
		);
		if (attempt === 1) await completeBuildEvidence(harness, "bun test fail-2");
	}
	expect(harness.states.at(-1)).toMatchObject({
		phase: "awaiting_human",
		gateCalls: 2,
		lastGateFindings: JSON.stringify({ verdict: "FAIL", findings: [{ severity: "blocking" }] }),
	});
	expect(harness.states.at(-1)!.terminalOutcome).toBeUndefined();
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("paused");

	expect(
		await call({ toolName: "edit", toolCallId: "paused-edit", input: { path: "src/example.ts" } }, harness.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("paused") });
	expect(
		await call(
			{ toolName: "write", toolCallId: "paused-local-write", input: { path: "local://paused-note.md", content: "note" } },
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "paused-finalize",
				input: {
					path: "xd://leanflow_finalize_artifacts",
					content: JSON.stringify({ validationCommands: ["bun test tests/leanflow_lsp_guard.test.ts"] }),
				},
			},
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
	expect(
		await call({ toolName: "task", toolCallId: "paused-gate", input: gateCallInput() }, harness.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("no subagents") });
	expect(
		await call({ toolName: "read", toolCallId: "paused-read", input: { path: "src/example.ts" } }, harness.ctx),
	).toBeUndefined();
	const repairRecordPath = buildRecordPath(harness);
	const repairRecord = readFileSync(repairRecordPath, "utf8");
	rmSync(repairRecordPath);
	mkdirSync(repairRecordPath);
	const preContinueNotifications = harness.notifications.length;
	await harness.commands.get("flowcontinue")!.handler("repair the blocking finding", harness.ctx);
	expect(harness.states.at(-1).phase).toBe("awaiting_human");
	expect(harness.notifications.length).toBeGreaterThan(preContinueNotifications);
	rmSync(repairRecordPath, { recursive: true });
	writeFileSync(repairRecordPath, repairRecord);


	await harness.commands.get("flowcontinue")!.handler("repair the blocking finding", harness.ctx);
	const afterContinue = harness.states.at(-1)!;
	expect(afterContinue.phase).toBe("building");
	expect(afterContinue.gateCalls).toBe(0);
	expect(afterContinue.gateRetryMode).toBe("repair");
	expect(afterContinue.writtenArtifacts).toEqual([]);
	expect(afterContinue.humanRepairCycles).toBeGreaterThanOrEqual(1);
	expect(JSON.parse(readFileSync(buildRecordPath(harness), "utf8"))).toMatchObject({ round: 3 });
	expect(JSON.parse(readFileSync(runMarkerPath(harness), "utf8")).status).toBe("building");
	expect(harness.editorTexts.at(-1)).toContain("repair the blocking finding");
	expect(harness.editorTexts.at(-1)).toContain("Gate FAIL");

	await harness.commands.get("flowcontinue")!.handler("", harness.ctx);
	expect(harness.notifications.at(-1)).toBe("LeanFlow: No paused Gate failure to continue.");
});

test("flowfinishfailed explicitly finalizes a paused Gate failure", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update docs only.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "write", toolCallId: "propose-finish-failed", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "propose-finish-failed", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await completeBuildEvidence(harness, "bun test finish-failed-1");
	for (const attempt of [1, 2]) {
		await call({ toolName: "task", toolCallId: `finish-failed-gate-${attempt}`, input: gateCallInput() }, harness.ctx);
		await result(
			{
				toolName: "task",
				toolCallId: `finish-failed-gate-${attempt}`,
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "FAIL", findings: [{ severity: "blocking" }] }) }],
			},
			harness.ctx,
		);
		if (attempt === 1) await completeBuildEvidence(harness, "bun test finish-failed-2");
	}

	await harness.commands.get("flowfinishfailed")!.handler("", harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({
		phase: "finalizing",
		terminalOutcome: "fail_after_retry",
	});
	expect(JSON.parse(readFileSync(runMarkerPath(harness), "utf8")).status).toBe("failed");
	expect(harness.notifications.at(-1)).toBe("LeanFlow: Marked run as failed; finalizing.");

	await harness.commands.get("flowfinishfailed")!.handler("", harness.ctx);
	expect(harness.notifications.at(-1)).toBe("LeanFlow: No paused Gate failure to mark as failed.");
});

test("canonical plan edits are reread and reassessed from actual content", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness, "Update documentation and verify text.\nLSP applicability: not_required");
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const runId = harness.states.at(-1)!.runId;
	const planPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!;

	const requiredContent = completeHandoffPlan(
		[
			"Update src/example.ts and verify the requested behavior.",
			"Run focused tests for the changed source.",
			"LSP applicability: required",
			`LeanFlow run ID: ${runId}`,
		].join("\n"),
	);
	expect(
		await call(
			{ toolName: "edit", toolCallId: "plan-required", input: { path: EXAMPLE_PLAN_ARTIFACT } },
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
				input: { paths: [EXAMPLE_PLAN_ARTIFACT, "src/example.ts"] },
			},
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("native plan approval") });

	const docsContent = completeHandoffPlan(
		[
			"Update documentation only and verify the rendered text.",
			"No source paths are changed by this plan.",
			"LSP applicability: not_required",
			`LeanFlow run ID: ${runId}`,
		].join("\n"),
	);
	await call({ toolName: "edit", toolCallId: "plan-docs", input: { path: EXAMPLE_PLAN_ARTIFACT } }, harness.ctx);
	writeFileSync(planPath, docsContent);
	await result({ toolName: "edit", toolCallId: "plan-docs", isError: false }, harness.ctx);
	expect(harness.states.at(-1)!.lspProbeStatus).toBe("not_required");

	const duplicateIdentity = `${docsContent}\nLeanFlow run ID: ${runId}`;
	await call({ toolName: "edit", toolCallId: "plan-duplicate-id", input: { path: EXAMPLE_PLAN_ARTIFACT } }, harness.ctx);
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
		{ toolName: "write", toolCallId: "overlay-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		valid.ctx,
	);
	await validResult({ toolName: "write", toolCallId: "overlay-propose", isError: false }, valid.ctx);
	valid.branch.push({ type: "mode_change", mode: "none" });
	const finalContent = completeHandoffPlan(
		[
			"Update src/example.ts after plan review and verify behavior.",
			"Run focused source tests.",
			"LSP applicability: required",
			`LeanFlow run ID: ${valid.states.at(-1)!.runId}`,
		].join("\n"),
	);
	writeFileSync(resolveRunMarkerPath(valid.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!, finalContent);
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
				input: { path: EXAMPLE_PLAN_ARTIFACT, content: finalContent },
			},
			valid.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("immutable") });
	expect(
		await validCall(
			{ toolName: "edit", toolCallId: "post-approval-plan-edit", input: { path: EXAMPLE_PLAN_ARTIFACT } },
			valid.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("immutable") });

	const invalid = createHarness();
	await writeInitialPlan(invalid, "Update documentation and verify text.\nLSP applicability: not_required");
	const invalidCall = invalid.handlers.get("tool_call")!;
	const invalidResult = invalid.handlers.get("tool_result")!;
	await invalidCall(
		{ toolName: "write", toolCallId: "invalid-overlay-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		invalid.ctx,
	);
	await invalidResult({ toolName: "write", toolCallId: "invalid-overlay-propose", isError: false }, invalid.ctx);
	invalid.branch.push({ type: "mode_change", mode: "none" });
	writeFileSync(
		resolveRunMarkerPath(invalid.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!,
		"Overlay removed the required run identity.\nLSP applicability: required",
	);
	expect(await invalid.handlers.get("context")!({ messages: approvalMessages }, invalid.ctx)).toBeUndefined();
	expect(
		await invalidCall({ toolName: "edit", toolCallId: "invalid-overlay-build", input: { path: "src/example.ts" } }, invalid.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("before native plan approval") });
	expect(invalid.states.at(-1)).toMatchObject({ phase: "planning", approvalInvalidated: true });
	expect(invalid.editorTexts.at(-1)).toContain("/plan Repair the existing LeanFlow plan");
	const repairedContent = completeHandoffPlan(
		[
			"Update documentation only after repairing the reviewed plan.",
			"Verify the rendered text and final diff.",
			"LSP applicability: not_required",
			`LeanFlow run ID: ${invalid.states.at(-1)!.runId}`,
		].join("\n"),
	);
	expect(
		await invalidCall(
			{ toolName: "edit", toolCallId: "repair-invalid-plan", input: { path: EXAMPLE_PLAN_ARTIFACT } },
			invalid.ctx,
		),
	).toBeUndefined();
	writeFileSync(
		resolveRunMarkerPath(invalid.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!,
		repairedContent,
	);
	await invalidResult({ toolName: "edit", toolCallId: "repair-invalid-plan", isError: false }, invalid.ctx);
	expect(invalid.states.at(-1)!.phase).toBe("awaiting_approval");
	expect(
		await invalidCall(
			{ toolName: "write", toolCallId: "repair-propose-before-mode", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			invalid.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("re-enter native plan mode") });
	invalid.branch.push({ type: "mode_change", mode: "plan" });
	expect(
		await invalidCall(
			{ toolName: "write", toolCallId: "repair-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			invalid.ctx,
		),
	).toBeUndefined();
	await invalidResult({ toolName: "write", toolCallId: "repair-propose", isError: false }, invalid.ctx);
	expect(invalid.states.at(-1)).toMatchObject({
		phase: "awaiting_approval",
		proposalBoundary: expect.any(Number),
		proposedPlanArtifact: EXAMPLE_PLAN_ARTIFACT,
		approvalRepairBoundary: undefined,
	});
});

test("repository mutation guards distinguish canonical and plan-named working-tree paths", async () => {
	const planning = createHarness();
	await planning.commands.get("flow")!.handler("example", planning.ctx);
	const call = planning.handlers.get("tool_call")!;
	for (const event of [
		{ toolName: "edit", toolCallId: "planning-edit", input: { path: "src/example.ts" } },
		{ toolName: "ast_edit", toolCallId: "planning-ast", input: {} },
		{ toolName: "bash", toolCallId: "planning-bash", input: { command: "touch changed" } },
		{ toolName: "write", toolCallId: "planning-named-plan", input: { path: "docs/release-plan.md", content: "x" } },
	]) {
		expect(await call(event, planning.ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("before native plan approval"),
		});
	}
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "planning-canonical",
				input: { path: EXAMPLE_PLAN_ARTIFACT, content: "plan" },
			},
			planning.ctx,
		),
	).toBeUndefined();
	planning.branch.push({ type: "mode_change", mode: "none" });
	expect(
		await call({ toolName: "edit", toolCallId: "manual-exit-edit", input: { path: "src/example.ts" } }, planning.ctx),
	).toMatchObject({ block: true, reason: expect.stringContaining("before native plan approval") });

	const awaiting = createHarness();
	await writeInitialPlan(awaiting);
	expect(
		await awaiting.handlers.get("tool_call")!(
			{
				toolName: "write",
				toolCallId: "awaiting-named-plan",
				input: { path: "docs/release-plan.md", content: "x" },
			},
			awaiting.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("native plan approval") });

	const building = createHarness();
	await writeInitialPlan(building, "Update documentation only and verify text.\nLSP applicability: not_required");
	const buildingCall = building.handlers.get("tool_call")!;
	const buildingResult = building.handlers.get("tool_result")!;
	await buildingCall(
		{ toolName: "write", toolCallId: "build-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		building.ctx,
	);
	await buildingResult({ toolName: "write", toolCallId: "build-propose", isError: false }, building.ctx);
	building.branch.push({ type: "mode_change", mode: "none" });
	await building.handlers.get("context")!({ messages: approvalMessages }, building.ctx);
	expect((await executeRegisteredTool(building, "leanflow_capture_baseline", {})).isError).not.toBe(true);
	expect(
		await buildingCall(
			{
				toolName: "write",
				toolCallId: "building-named-plan",
				input: { path: "docs/release-plan.md", content: "x" },
			},
			building.ctx,
		),
	).toBeUndefined();
});

test("proposal waits for canonical plan mutation result", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	expect(
		await call(
			{ toolName: "edit", toolCallId: "unsettled-plan-edit", input: { path: EXAMPLE_PLAN_ARTIFACT } },
			harness.ctx,
		),
	).toBeUndefined();
	expect(
		await call(
			{ toolName: "write", toolCallId: "racing-proposal", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("mutation to finish") });
});

test("agent end clears and refreshes an interrupted canonical plan mutation", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const runId = harness.states.at(-1)!.runId!;
	const planPath = resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!;

	expect(
		await call(
			{
				toolName: "edit",
				toolCallId: "interrupted-plan-edit",
				input: { path: EXAMPLE_PLAN_ARTIFACT },
			},
			harness.ctx,
		),
	).toBeUndefined();

	writeFileSync(planPath, `Needs more detail.\nLeanFlow run ID: ${runId}`);
	await harness.handlers.get("agent_end")!({}, harness.ctx);
	expect(harness.states.at(-1)).toMatchObject({ phase: "planning", handoffStatus: "NEEDS_UPDATE" });

	const repairedContent = completeHandoffPlan(
		[
			"Update src/example.ts with the requested behavior and run focused tests.",
			`LeanFlow run ID: ${runId}`,
			"LSP applicability: required",
		].join("\n"),
	);
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "repaired-plan",
				input: { path: EXAMPLE_PLAN_ARTIFACT, content: repairedContent },
			},
			harness.ctx,
		),
	).toBeUndefined();
	writeFileSync(planPath, repairedContent);
	await result({ toolName: "write", toolCallId: "repaired-plan", isError: false }, harness.ctx);

	expect(harness.states.at(-1)!.phase).toBe("awaiting_approval");
	expect(
		await call(
			{
				toolName: "write",
				toolCallId: "proposal-after-interrupt",
				input: { path: "xd://propose", content: EXAMPLE_SLUG },
			},
			harness.ctx,
		),
	).toBeUndefined();
});

test("turn and continuing-agent cleanup preserve later pending plan mutations", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	await call(
		{ toolName: "edit", toolCallId: "settled-skipped-edit", input: { path: EXAMPLE_PLAN_ARTIFACT } },
		harness.ctx,
	);
	await call(
		{ toolName: "edit", toolCallId: "later-plan-edit", input: { path: EXAMPLE_PLAN_ARTIFACT } },
		harness.ctx,
	);

	await harness.handlers.get("turn_end")!(
		{ toolResults: [{ toolCallId: "settled-skipped-edit" }] },
		harness.ctx,
	);
	await harness.handlers.get("agent_end")!({ willContinue: true, messages: [] }, harness.ctx);
	expect(
		await call(
			{ toolName: "write", toolCallId: "proposal-before-later-result", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			harness.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("mutation to finish") });

	await result({ toolName: "edit", toolCallId: "later-plan-edit", isError: true }, harness.ctx);
	expect(
		await call(
			{ toolName: "write", toolCallId: "proposal-after-later-result", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
			harness.ctx,
		),
	).toBeUndefined();
});

test("fresh recovery locks invalid, expired, corrupt, and ambiguous identities", async () => {
	const validPlan = (runId: string) =>
		[
			"Update src/example.ts and run focused tests.",
			`LeanFlow run ID: ${runId}`,
			"LSP applicability: required",
		].join("\n");
	const cases: Array<{
		name: string;
		plan: (runId: string) => string;
		markerOverrides?: Record<string, unknown>;
		corruptMarker?: boolean;
	}> = [
		{ name: "removed run ID", plan: () => "Update src/example.ts.\nLSP applicability: required" },
		{
			name: "changed run ID",
			plan: () =>
				"Update src/example.ts.\nLeanFlow run ID: 2d3ef6f7-f14c-4898-a658-65577ef446af\nLSP applicability: required",
		},
		{ name: "duplicate run ID", plan: (runId) => `${validPlan(runId)}\nLeanFlow run ID: ${runId}` },
		{
			name: "expired marker",
			plan: validPlan,
			markerOverrides: { updatedAt: Date.now() - 25 * 60 * 60 * 1_000 },
		},
		{ name: "corrupt marker", plan: validPlan, corruptMarker: true },
		{
			name: "pointer marker run mismatch",
			plan: validPlan,
			markerOverrides: { runId: "2d3ef6f7-f14c-4898-a658-65577ef446af" },
		},
	];
	for (const scenario of cases) {
		const harness = createHarness();
		const runId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
		const artifacts = writeFreshArtifacts(harness, {
			planContent: scenario.plan(runId),
			markerOverrides: scenario.markerOverrides,
		});
		if (scenario.corruptMarker) writeFileSync(artifacts.markerPath, "{");
		expect(await harness.handlers.get("context")!({ messages: legacyApprovalMessages }, harness.ctx), scenario.name).toBeUndefined();
		expect(harness.states.at(-1), scenario.name).toMatchObject({
			phase: "planning",
			approvalInvalidated: true,
		});
	}

	const ambiguous = createHarness();
	const first = writeFreshArtifacts(ambiguous, {
		planContent: validPlan("4f414c4c-8f8f-4dca-8df3-9e0fabada555"),
		pointer: false,
	});
	const secondRunId = "2d3ef6f7-f14c-4898-a658-65577ef446af";
	const secondMarker = JSON.parse(readFileSync(first.markerPath, "utf8"));
	secondMarker.runId = secondRunId;
	const secondMarkerPath = resolveRunMarkerPath(
		ambiguous.ctx.localProtocolOptions,
		`local://.leanflow/runs/${secondRunId}.json`,
	)!;
	writeFileSync(secondMarkerPath, JSON.stringify(secondMarker));
	const corruptPointer = createHarness();
	const corruptPointerRunId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
	const corruptPointerPlan = validPlan(corruptPointerRunId);
	const corruptPointerPlanPath = resolveRunMarkerPath(
		corruptPointer.ctx.localProtocolOptions,
		EXAMPLE_PLAN_ARTIFACT,
	)!;
	writeFileSync(corruptPointerPlanPath, corruptPointerPlan);
	const corruptHashedPointerPath = resolveRunMarkerPath(
		corruptPointer.ctx.localProtocolOptions,
		hashedPointerArtifact(EXAMPLE_SLUG),
	)!;
	mkdirSync(dirname(corruptHashedPointerPath), { recursive: true });
	writeFileSync(corruptHashedPointerPath, "{");
	expect(await corruptPointer.handlers.get("context")!({ messages: approvalMessages }, corruptPointer.ctx)).toBeUndefined();
	expect(corruptPointer.states.at(-1)).toMatchObject({ phase: "planning", approvalInvalidated: true });

	expect(await ambiguous.handlers.get("context")!({ messages: legacyApprovalMessages }, ambiguous.ctx)).toBeUndefined();
	expect(ambiguous.states.at(-1)).toMatchObject({ phase: "planning", approvalInvalidated: true });
});

test("locked phases allow only explicit read-only LSP actions", async () => {
	const planning = createHarness();
	await planning.commands.get("flow")!.handler("example", planning.ctx);
	const call = planning.handlers.get("tool_call")!;
	for (const [action, input] of [
		["diagnostics", { action: "diagnostics", file: "src/example.ts" }],
		["references", { action: "references", file: "src/example.ts", line: 1, symbol: "example" }],
	] as const) {
		expect(
			await call(
				{ toolName: "write", toolCallId: `safe-${action}`, input: { path: "xd://lsp", content: JSON.stringify(input) } },
				planning.ctx,
			),
		).toBeUndefined();
	}
	for (const event of [
		{
			toolName: "write",
			toolCallId: "locked-rename",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "src/example.ts", line: 1, symbol: "example", new_name: "changed" }) },
		},
		{
			toolName: "write",
			toolCallId: "locked-code-action",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "code_actions", file: "src/example.ts", line: 1 }) },
		},
		{ toolName: "eval", toolCallId: "locked-eval", input: { language: "js", code: "1" } },
		{ toolName: "resolve", toolCallId: "locked-resolve", input: { action: "apply" } },
		{ toolName: "recipe", toolCallId: "locked-unknown", input: {} },
	]) {
		expect(await call(event, planning.ctx)).toMatchObject({
			block: true,
			reason: expect.stringContaining("not explicitly read-only"),
		});
	}

	const awaiting = createHarness();
	await writeInitialPlan(awaiting);
	expect(
		await awaiting.handlers.get("tool_call")!(
			{
				toolName: "write",
				toolCallId: "awaiting-rename",
				input: { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "src/example.ts", line: 1, symbol: "example", new_name: "changed" }) },
			},
			awaiting.ctx,
		),
	).toMatchObject({ block: true });

	const building = createHarness();
	await writeInitialPlan(building);
	const buildingCall = building.handlers.get("tool_call")!;
	const buildingResult = building.handlers.get("tool_result")!;
	await buildingCall(
		{ toolName: "write", toolCallId: "locked-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		building.ctx,
	);
	await buildingResult({ toolName: "write", toolCallId: "locked-propose", isError: false }, building.ctx);
	building.branch.push({ type: "mode_change", mode: "none" });
	await building.handlers.get("context")!({ messages: approvalMessages }, building.ctx);
	expect(
		await buildingCall(
			{
				toolName: "write",
				toolCallId: "building-rename",
				input: { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "src/example.ts", line: 1, symbol: "example", new_name: "changed" }) },
			},
			building.ctx,
		),
	).toMatchObject({ block: true, reason: expect.stringContaining("diagnostics probe") });
});

test("canonical and evidence artifacts use normalized filesystem identity", async () => {
	const harness = createHarness();
	await writeInitialPlan(harness);
	const call = harness.handlers.get("tool_call")!;
	const result = harness.handlers.get("tool_result")!;
	const absolutePlan = resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!;
	for (const [toolCallId, target] of [
		["hashline-plan", `[${EXAMPLE_PLAN_ARTIFACT}#ABCD]`],
		["single-slash-plan", EXAMPLE_PLAN_ARTIFACT.replace("local://", "local:/")],
		["absolute-plan", absolutePlan],
	]) {
		expect(await call({ toolName: "edit", toolCallId, input: { path: target } }, harness.ctx)).toBeUndefined();
		await result({ toolName: "edit", toolCallId, isError: false }, harness.ctx);
	}
	expect(
		await call(
			{
				toolName: "edit",
				toolCallId: "mixed-normalized-plan",
				input: { paths: [`[${EXAMPLE_PLAN_ARTIFACT}#ABCD]`, "src/example.ts"] },
			},
			harness.ctx,
		),
	).toMatchObject({ block: true });

	await call(
		{ toolName: "write", toolCallId: "normalized-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "normalized-propose", isError: false }, harness.ctx);
	harness.branch.push({ type: "mode_change", mode: "none" });
	await harness.handlers.get("context")!({ messages: approvalMessages }, harness.ctx);
	await call(
		{
			toolName: "write",
			toolCallId: "normalized-probe",
			input: { path: "xd://lsp", content: JSON.stringify({ action: "diagnostics", file: "src/example.ts" }) },
		},
		harness.ctx,
	);
	await result({ toolName: "write", toolCallId: "normalized-probe", isError: false }, harness.ctx);
	const absoluteEvidence = resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_EVIDENCE_ARTIFACT)!;
	for (const [toolCallId, target] of [
		["hashline-build", `[${EXAMPLE_BUILD_ARTIFACT}#1234]`],
		["hashline-diff", `[${EXAMPLE_DIFF_ARTIFACT}#5678]`],
		["absolute-evidence", `[${absoluteEvidence}#9ABC]`],
	]) {
		expect(
			await call({ toolName: "edit", toolCallId, input: { path: target } }, harness.ctx),
		).toMatchObject({ block: true, reason: expect.stringContaining("extension-generated") });
	}
	await completeBuildEvidence(harness, "bun test normalized-artifacts");
	expect(harness.states.at(-1)!.writtenArtifacts?.sort()).toEqual(["build", "diff", "evidence"]);
});

test("extension-owned state namespace is blocked in every authored target form", async () => {
	const harness = createHarness();
	await harness.commands.get("flow")!.handler("example", harness.ctx);
	const call = harness.handlers.get("tool_call")!;
	const absoluteState = resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		"local://.leanflow/active/example.json",
	)!;
	for (const [name, event] of [
		["local", { toolName: "write", toolCallId: "reserved-local", input: { path: "local://.leanflow/active/example.json", content: "{}" } }],
		["encoded", { toolName: "write", toolCallId: "reserved-encoded", input: { path: "local://%2Eleanflow/active/example.json", content: "{}" } }],
		["hashline", { toolName: "edit", toolCallId: "reserved-hashline", input: { path: "[local://.leanflow/active/example.json#ABCD]" } }],
		["absolute", { toolName: "edit", toolCallId: "reserved-absolute", input: { path: absoluteState } }],
		["mixed", { toolName: "edit", toolCallId: "reserved-mixed", input: { paths: ["local://notes.md", absoluteState] } }],
	] as const) {
		expect(await call(event, harness.ctx), name).toMatchObject({
			block: true,
			reason: expect.stringContaining("extension-owned"),
		});
	}
});

test("pointer persistence failures report the stage, path, and filesystem code", async () => {
	const harness = createHarness();
	await harness.commands.get("flow")!.handler(EXAMPLE_TASK, harness.ctx);
	const initial = harness.states.at(-1)!;
	const planContent = completeHandoffPlan(
		[
			"Update src/example.ts and run focused tests.",
			`LeanFlow run ID: ${initial.runId}`,
			"LSP applicability: required",
		].join("\n"),
	);
	const call = harness.handlers.get("tool_call")!;
	await call(
		{
			toolName: "write",
			toolCallId: "pointer-failure-plan",
			input: { path: EXAMPLE_PLAN_ARTIFACT, content: planContent },
		},
		harness.ctx,
	);
	writeFileSync(resolveRunMarkerPath(harness.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!, planContent);
	const activeDirectory = resolveRunMarkerPath(harness.ctx.localProtocolOptions, "local://.leanflow/active")!;
	mkdirSync(dirname(activeDirectory), { recursive: true });
	writeFileSync(activeDirectory, "blocks active pointer directory");
	await harness.handlers.get("tool_result")!(
		{ toolName: "write", toolCallId: "pointer-failure-plan", isError: false },
		harness.ctx,
	);

	const latest = harness.states.at(-1)!;
	const expectedPointerPath = resolveRunMarkerPath(
		harness.ctx.localProtocolOptions,
		hashedPointerArtifact(EXAMPLE_SLUG),
	)!;
	expect(latest).toMatchObject({
		phase: "planning",
		persistenceDegraded: true,
		persistenceFailureStage: "pointer",
		persistenceFailurePath: expectedPointerPath,
	});
	expect(["EEXIST", "ENOTDIR"]).toContain(latest.persistenceFailureCode!);
	expect(latest.persistenceFailureMessage).toContain(activeDirectory);
	expect(harness.notifications.at(-1)).toContain("during pointer write");
	expect(harness.notifications.at(-1)).toContain(`${latest.persistenceFailureCode}, path: ${expectedPointerPath}`);
	const marker = JSON.parse(readFileSync(runMarkerPath(harness), "utf8"));
	expect(marker.status).toBe("awaiting_approval");
});

test("marker durability is required before proposal and BUILD setup failures keep approval pending", async () => {
	const preProposal = createHarness();
	await preProposal.commands.get("flow")!.handler("example", preProposal.ctx);
	const planContent = completeHandoffPlan(
		[
			"Update src/example.ts and run focused tests.",
			`LeanFlow run ID: ${preProposal.states.at(-1)!.runId}`,
			"LSP applicability: required",
		].join("\n"),
	);
	const planPath = resolveRunMarkerPath(preProposal.ctx.localProtocolOptions, EXAMPLE_PLAN_ARTIFACT)!;
	writeFileSync(planPath, planContent);
	const stateRoot = resolveRunMarkerPath(preProposal.ctx.localProtocolOptions, "local://.leanflow")!;
	writeFileSync(stateRoot, "blocks marker directory creation");
	const preCall = preProposal.handlers.get("tool_call")!;
	const preResult = preProposal.handlers.get("tool_result")!;
	await preCall(
		{ toolName: "write", toolCallId: "pre-marker-failure", input: { path: EXAMPLE_PLAN_ARTIFACT, content: planContent } },
		preProposal.ctx,
	);
	await preResult({ toolName: "write", toolCallId: "pre-marker-failure", isError: false }, preProposal.ctx);
	expect(preProposal.states.at(-1)).toMatchObject({ phase: "planning", persistenceDegraded: true });

	const approved = createHarness();
	await writeInitialPlan(approved);
	const approvedCall = approved.handlers.get("tool_call")!;
	const approvedResult = approved.handlers.get("tool_result")!;
	await approvedCall(
		{ toolName: "write", toolCallId: "approved-propose", input: { path: "xd://propose", content: EXAMPLE_SLUG } },
		approved.ctx,
	);
	await approvedResult({ toolName: "write", toolCallId: "approved-propose", isError: false }, approved.ctx);
	const approvedStateRoot = resolveRunMarkerPath(approved.ctx.localProtocolOptions, "local://.leanflow")!;
	rmSync(approvedStateRoot, { recursive: true, force: true });
	writeFileSync(approvedStateRoot, "blocks marker updates");
	approved.branch.push({ type: "mode_change", mode: "none" });
	await approved.handlers.get("context")!({ messages: approvalMessages }, approved.ctx);
	expect(approved.states.at(-1)).toMatchObject({ phase: "awaiting_approval", persistenceDegraded: true });
	expect(approved.notifications.at(-1)).toContain("Cannot enter BUILD:");

	const fresh = createHarness();
	const freshRunId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
	const freshArtifacts = writeFreshArtifacts(fresh, {
		planContent: completeHandoffPlan(
			[
				"Update src/example.ts and run focused tests.",
				`LeanFlow run ID: ${freshRunId}`,
				"LSP applicability: required",
			].join("\n"),
		),
	});
	const markerDirectory = dirname(freshArtifacts.markerPath);
	const pointerDirectory = dirname(freshArtifacts.pointerPath);
	chmodSync(markerDirectory, 0o555);
	chmodSync(pointerDirectory, 0o555);
	try {
		await fresh.handlers.get("context")!({ messages: legacyApprovalMessages }, fresh.ctx);
		expect(fresh.states.at(-1)).toMatchObject({ phase: "awaiting_approval", persistenceDegraded: true });
		expect(fresh.notifications.at(-1)).toContain("Cannot enter BUILD:");
	} finally {
		chmodSync(pointerDirectory, 0o755);
		chmodSync(markerDirectory, 0o755);
	}
});

test("expired orphan markers do not claim ordinary native approvals", async () => {
	const harness = createHarness();
	const runId = "4f414c4c-8f8f-4dca-8df3-9e0fabada555";
	writeFreshArtifacts(harness, {
		planContent: `Ordinary plan.\nLeanFlow run ID: ${runId}\nLSP applicability: required`,
		markerOverrides: { updatedAt: Date.now() - 25 * 60 * 60 * 1_000 },
		pointer: false,
	});
	expect(await harness.handlers.get("context")!({ messages: legacyApprovalMessages }, harness.ctx)).toBeUndefined();
	expect(harness.states).toHaveLength(0);
});
