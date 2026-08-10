import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
	MAX_GATE_ARTIFACT_BYTES,
	composeCompleteDiff,
	createBuildEvidenceRecord,
	migrateBuildEvidenceRecord,
	parseBuildEvidenceRecord,
	renderBuildArtifacts,
	selectValidationObservations,
	validationSemanticStates,
} from "../extensions/leanflow/evidence";
import type { BuildEvidenceObservationV3, GitCommandEvidence } from "../extensions/leanflow/evidence";
import {
	createApprovedValidationContract,
	parseApprovedValidation,
	parseValidationContract,
} from "../extensions/leanflow/validation";
import {
	createFinalizedGateSnapshot,
	finalizedGateSnapshotDigest,
	parseFinalizedGateSnapshot,
} from "../extensions/leanflow/provenance";

function git(cwd: string, args: string[], acceptedCodes: number[] = [0]): { stdout: string; stderr: string; code: number } {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const code = result.exitCode;
	const stdout = Buffer.from(result.stdout).toString("utf8");
	const stderr = Buffer.from(result.stderr).toString("utf8");
	if (!acceptedCodes.includes(code)) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return { stdout, stderr, code };
}

const runId = "44042e49-0bdb-4903-b66b-75decae8f043";
const planSlug = "example";
const planDigest = createHash("sha256").update("approved plan", "utf8").digest("hex");
const repositoryFingerprint = "f".repeat(64);
const approved = parseApprovedValidation("bun test tests/leanflow_evidence.test.ts")!;
const contract = createApprovedValidationContract(planDigest, [approved]);
const identity = { runId, planSlug, planDigest, approvedValidationDigest: contract.digest, round: 1 };

function successfulObservation(
	text = "1 pass\n0 fail\n2 expect() calls\nRan 1 test across 1 file.",
	toolCallId = "validation-1",
): BuildEvidenceObservationV3 {
	return {
		toolCallId,
		operationId: `operation-${toolCallId}`,
		runId: identity.runId,
		round: identity.round,
		planDigest: identity.planDigest,
		approvedValidationDigest: identity.approvedValidationDigest,
		toolName: "validation",
		validationId: approved.id,
		command: approved.displayCommand,
		executable: approved.executable,
		argv: [...approved.argv],
		repositoryFingerprintBefore: repositoryFingerprint,
		repositoryFingerprintAfter: repositoryFingerprint,
		startedAt: 10,
		finishedAt: 20,
		isError: false,
		exitCode: 0,
		text,
	};
}

test("renders deterministic complete artifacts from manifest-bound validation evidence", () => {
	const cwd = mkdtempSync(join(tmpdir(), "leanflow-evidence-"));
	try {
		git(cwd, ["init", "-q"]);
		git(cwd, ["config", "user.email", "leanflow@example.test"]);
		git(cwd, ["config", "user.name", "LeanFlow Test"]);
		writeFileSync(join(cwd, "tracked.txt"), "baseline\n");
		writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		git(cwd, ["add", "tracked.txt", "binary.bin"]);
		git(cwd, ["commit", "-qm", "baseline"]);
		const baselineHead = git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
		const baselineStatus = git(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trimEnd();

		writeFileSync(join(cwd, "tracked.txt"), "baseline\ntracked change\n");
		writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 9, 8, 7, 6]));
		writeFileSync(join(cwd, "untracked.txt"), "untracked content\n");
		writeFileSync(join(cwd, "empty.txt"), "");

		const tracked = git(cwd, ["diff", "--binary", baselineHead, "--"]);
		const untracked = git(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", "untracked.txt"], [1]);
		const completeDiff = composeCompleteDiff(tracked.stdout, [{ path: "untracked.txt", patch: untracked.stdout }], ["empty.txt"]);
		const record = createBuildEvidenceRecord(identity);
		record.baseline = { head: baselineHead, status: baselineStatus, capturedAt: 1_700_000_000_000 };
		record.observations.push(
			{
				toolCallId: "lsp-initial",
				toolName: "lsp",
				lspRequest: { action: "diagnostics", file: "tracked.txt", timeout: 60 },
				isError: false,
				text: "typescript-language-server: no diagnostics",
			},
			successfulObservation(),
		);
		const validations = selectValidationObservations(record, contract, repositoryFingerprint);
		const finalStatus = git(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trimEnd();
		const gitCommands: GitCommandEvidence[] = [
			{ command: `git diff --binary ${baselineHead} --`, exitCode: 0, output: tracked.stdout },
			{ command: "git diff --no-index --binary -- /dev/null untracked.txt", exitCode: 1, output: untracked.stdout },
		];
		const input = {
			planArtifact: "local://example-plan.md",
			record,
			finalHead: baselineHead,
			finalStatus,
			changedPaths: ["untracked.txt", "tracked.txt", "binary.bin", "empty.txt"],
			validations,
			gitCommands,
			completeDiff,
		};
		const rendered = renderBuildArtifacts(input);

		expect(rendered).toEqual(renderBuildArtifacts(input));
		expect(rendered.diff).toContain("tracked change");
		expect(rendered.diff).toContain("GIT binary patch");
		expect(rendered.diff).toContain("untracked.txt");
		expect(rendered.diff).toContain("- `empty.txt`");
		expect(rendered.build).toContain(`- HEAD: \`${baselineHead}\``);
		expect(rendered.build).toContain("1 pass");
		expect(rendered.evidence).toContain("## LSP 1: diagnostics");
		expect(rendered.evidence).toContain("## Validation 1:");
		expect(rendered.evidence).toContain(approved.id);
		expect(rendered.build).toContain(runId);
		expect(rendered.diff).toContain(runId);
		expect(rendered.evidence).toContain(runId);
		expect(() =>
			renderBuildArtifacts({
				...input,
				completeDiff: { patch: "x".repeat(MAX_GATE_ARTIFACT_BYTES + 1), emptyUntrackedFiles: [] },
			}),
		).toThrow("1 MiB");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("validation selection uses the approved tuple and current repository fingerprint", () => {
	const record = createBuildEvidenceRecord(identity);
	expect(validationSemanticStates(record, contract, repositoryFingerprint)).toEqual([{ id: approved.id, status: "missing" }]);
	expect(() => selectValidationObservations(record, contract, repositoryFingerprint)).toThrow("missing");

	record.observations.push(successfulObservation());
	expect(selectValidationObservations(record, contract, repositoryFingerprint)).toHaveLength(1);
	expect(validationSemanticStates(record, contract, repositoryFingerprint)[0]).toMatchObject({
		id: approved.id,
		status: "passed",
		observationId: "validation-1",
	});

	record.observations.push({
		...successfulObservation("failed", "validation-2"),
		isError: true,
		exitCode: 1,
	});
	expect(() => selectValidationObservations(record, contract, repositoryFingerprint)).toThrow("failed");
});

test("legacy validation observations parse as history but cannot authorize the current record", () => {
	const record = createBuildEvidenceRecord(identity);
	const historical = successfulObservation();
	delete historical.operationId;
	delete historical.runId;
	delete historical.round;
	delete historical.planDigest;
	delete historical.approvedValidationDigest;
	record.observations.push(historical);
	expect(parseBuildEvidenceRecord(record, identity)).toBe(record);
	expect(validationSemanticStates(record, contract, repositoryFingerprint)).toEqual([{ id: approved.id, status: "missing" }]);
	expect(() => selectValidationObservations(record, contract, repositoryFingerprint)).toThrow("missing");

	record.observations.push({
		...successfulObservation("mismatched record provenance", "validation-mismatch"),
		runId: "3f414c4c-8f8f-4dca-8df3-9e0fabada555",
	});
	expect(() => parseBuildEvidenceRecord(record, identity)).toThrow("provenance does not match");
});

test("v1 and v2 records migrate to v3 without granting historical or foreign provenance authority", () => {
	const v1 = {
		version: 1,
		runId,
		planSlug,
		planDigest,
		round: 1,
		observations: [
			{
				toolCallId: "v1-bash",
				toolName: "bash" as const,
				command: "git diff --check",
				isError: false,
				exitCode: 0,
				text: "",
			},
		],
	};
	const migratedV1 = migrateBuildEvidenceRecord(v1, identity);
	expect(migratedV1).toMatchObject({ version: 3, ...identity });
	expect(migratedV1.observations).toEqual(v1.observations);
	expect(parseBuildEvidenceRecord(migratedV1, identity)).toBe(migratedV1);

	const historyOnly = successfulObservation("historical v2");
	delete historyOnly.operationId;
	delete historyOnly.runId;
	delete historyOnly.round;
	delete historyOnly.planDigest;
	delete historyOnly.approvedValidationDigest;
	const migratedV2 = migrateBuildEvidenceRecord(
		{
			...createBuildEvidenceRecord(identity),
			version: 2,
			observations: [historyOnly],
		},
		identity,
	);
	expect(migratedV2.version).toBe(3);
	expect(validationSemanticStates(migratedV2, contract, repositoryFingerprint)).toEqual([
		{ id: approved.id, status: "missing" },
	]);
	expect(() => selectValidationObservations(migratedV2, contract, repositoryFingerprint)).toThrow("missing");

	expect(() =>
		migrateBuildEvidenceRecord(
			{
				...createBuildEvidenceRecord(identity),
				version: 2,
				observations: [
					{
						...successfulObservation("foreign v2"),
						runId: "3f414c4c-8f8f-4dca-8df3-9e0fabada555",
					},
				],
			},
			identity,
		),
	).toThrow("provenance does not match");

	const partial = successfulObservation("partial v2");
	delete partial.runId;
	delete partial.round;
	delete partial.planDigest;
	delete partial.approvedValidationDigest;
	expect(() =>
		migrateBuildEvidenceRecord(
			{ ...createBuildEvidenceRecord(identity), version: 2, observations: [partial] },
			identity,
		),
	).toThrow("incomplete operation provenance");
});

test("failed validation can become passed progress while unapproved history grants no authority", () => {
	const recovered = createBuildEvidenceRecord(identity);
	recovered.observations.push(
		{ ...successfulObservation("failed first", "validation-failed"), isError: true, exitCode: 1 },
		successfulObservation("passed second", "validation-passed"),
	);
	expect(validationSemanticStates(recovered, contract, repositoryFingerprint)[0]).toMatchObject({
		status: "passed",
		observationId: "validation-passed",
	});
	expect(selectValidationObservations(recovered, contract, repositoryFingerprint)).toHaveLength(1);

	const poisoned = createBuildEvidenceRecord(identity);
	poisoned.observations.push({
		...successfulObservation("unapproved success", "validation-unapproved"),
		validationId: `validation-${"0".repeat(64)}`,
	});
	expect(() => validationSemanticStates(poisoned, contract, repositoryFingerprint)).toThrow("not approved");
});

test("validation contract parsing accepts multiple safe commands and fails closed on mixed unsafe input", () => {
	const safePlan = [
		"## Verification",
		"`bun test tests/leanflow_evidence.test.ts`",
		"`python3 -m unittest discover -s tests -p 'test_*.py' -v`",
		"Run the generated application manually after these commands.",
	].join("\n");
	const safe = parseValidationContract(safePlan, planDigest);
	expect(safe.rejected).toEqual([]);
	expect(safe.contract?.validations.map((validation) => validation.displayCommand)).toEqual([
		"bun test tests/leanflow_evidence.test.ts",
		"python3 -m unittest discover -s tests -p 'test_*.py' -v",
	]);

	const mixed = parseValidationContract(
		["## Verification", "`bun test tests/leanflow_evidence.test.ts`", "`npm publish`"].join("\n"),
		planDigest,
	);
	expect(mixed.approved).toHaveLength(1);
	expect(mixed.rejected).toEqual([
		expect.objectContaining({ raw: "npm publish", reason: expect.stringContaining("not a validation") }),
	]);
	expect(mixed.contract).toBeUndefined();
	const writableBuild = parseValidationContract(
		["## Verification", "`bun build extensions/leanflow/index.ts --outfile extensions/leanflow/index.ts`"].join(
			"\n",
		),
		planDigest,
	);
	expect(writableBuild.contract).toBeUndefined();
	expect(writableBuild.rejected[0]?.reason).toContain("under /tmp");

	const proseOnly = parseValidationContract(
		["## Verification", "Review the output and confirm the behavior manually."].join("\n"),
		planDigest,
	);
	expect(proseOnly.approved).toEqual([]);
	expect(proseOnly.rejected).toEqual([]);
	expect(proseOnly.contract).toBeUndefined();
});


test("finalized manifest schema binds every provenance digest and rejects tampering", () => {
	const fingerprint = {
		head: "a".repeat(40),
		trackedDiffDigest: "b".repeat(64),
		untrackedDigest: "c".repeat(64),
		combinedDigest: "d".repeat(64),
	};
	const validationStates = [
		{
			id: approved.id,
			status: "passed" as const,
			observationId: "validation-1",
			normalizedOutputDigest: "e".repeat(64),
			repositoryFingerprintAfter: fingerprint.combinedDigest,
		},
	];
	const manifest = createFinalizedGateSnapshot({
		runId,
		planSlug,
		planDigest,
		approvedValidationDigest: contract.digest,
		buildRecordRound: 1,
		buildRecordDigest: "1".repeat(64),
		buildArtifactDigest: "2".repeat(64),
		diffArtifactDigest: "3".repeat(64),
		evidenceArtifactDigest: "4".repeat(64),
		repositoryFingerprint: fingerprint,
		validationStates,
		finalizedAt: "2026-08-10T00:00:00.000Z",
	});
	expect(parseFinalizedGateSnapshot(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
	expect(manifest.version).toBe(2);
	expect(manifest.finalizationCommitNonce).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	expect(parseFinalizedGateSnapshot({ ...manifest, version: 1 })).toBeUndefined();
	const { finalizationCommitNonce: _legacyNonce, ...legacyManifest } = manifest;
	expect(parseFinalizedGateSnapshot(legacyManifest)).toBeUndefined();
	const repeatedOutput = createFinalizedGateSnapshot({
		runId,
		planSlug,
		planDigest,
		approvedValidationDigest: contract.digest,
		buildRecordRound: 1,
		buildRecordDigest: "1".repeat(64),
		buildArtifactDigest: "2".repeat(64),
		diffArtifactDigest: "3".repeat(64),
		evidenceArtifactDigest: "4".repeat(64),
		repositoryFingerprint: fingerprint,
		validationStates: [{ ...validationStates[0]!, observationId: "validation-2" }],
		finalizedAt: "2026-08-10T00:00:00.000Z",
	});
	expect(repeatedOutput.semanticEvidenceDigest).toBe(manifest.semanticEvidenceDigest);
	expect(repeatedOutput.validationStatesDigest).not.toBe(manifest.validationStatesDigest);
	expect(finalizedGateSnapshotDigest(manifest)).toHaveLength(64);
	for (const key of [
		"planDigest",
		"buildRecordDigest",
		"buildArtifactDigest",
		"diffArtifactDigest",
		"evidenceArtifactDigest",
	] as const) {
		const tampered = parseFinalizedGateSnapshot({ ...manifest, [key]: "0".repeat(64) });
		expect(tampered).toBeDefined();
		expect(finalizedGateSnapshotDigest(tampered!)).not.toBe(finalizedGateSnapshotDigest(manifest));
	}
	expect(
		parseFinalizedGateSnapshot({ ...manifest, approvedValidationDigest: "0".repeat(64) }),
	).toBeUndefined();
	expect(
		parseFinalizedGateSnapshot({
			...manifest,
			validationStates: [{ ...manifest.validationStates[0]!, normalizedOutputDigest: "f".repeat(64) }],
		}),
	).toBeUndefined();
	expect(
		parseFinalizedGateSnapshot({
			...manifest,
			repositoryFingerprint: { ...manifest.repositoryFingerprint, combinedDigest: "f".repeat(64) },
		}),
	).toBeUndefined();
});
test("record and validation contract identity mismatches fail closed", () => {
	const record = createBuildEvidenceRecord(identity);
	expect(() =>
		parseBuildEvidenceRecord(record, {
			...identity,
			planDigest: createHash("sha256").update("different", "utf8").digest("hex"),
		}),
	).toThrow("identity");
	expect(() =>
		parseBuildEvidenceRecord(record, {
			...identity,
			approvedValidationDigest: "a".repeat(64),
		}),
	).toThrow("identity");
});
