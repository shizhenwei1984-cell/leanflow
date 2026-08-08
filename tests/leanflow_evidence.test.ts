import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
	MAX_GATE_ARTIFACT_BYTES,
	composeCompleteDiff,
	createBuildEvidenceRecord,
	parseBuildEvidenceRecord,
	renderBuildArtifacts,
	selectValidationObservations,
} from "../extensions/leanflow/evidence";
import type { BuildEvidenceObservationV1, GitCommandEvidence } from "../extensions/leanflow/evidence";

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

function successfulObservation(command: string, text = "1 pass\n0 fail\n2 expect() calls\nRan 1 test across 1 file."): BuildEvidenceObservationV1 {
	return {
		toolCallId: `call-${command}`,
		toolName: "bash",
		command,
		isError: false,
		exitCode: 0,
		text,
	};
}

test("renders deterministic complete artifacts from real git outputs", () => {
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
		const completeDiff = composeCompleteDiff(
			tracked.stdout,
			[{ path: "untracked.txt", patch: untracked.stdout }],
			["empty.txt"],
		);
		const record = createBuildEvidenceRecord({ runId, planSlug, planDigest, round: 1 });
		record.baseline = { head: baselineHead, status: baselineStatus, capturedAt: 1_700_000_000_000 };
		record.observations.push(
			{
				toolCallId: "lsp-initial",
				toolName: "lsp",
				lspRequest: { action: "diagnostics", file: "tracked.txt", timeout: 60 },
				isError: false,
				text: "typescript-language-server: no diagnostics",
			},
			successfulObservation("bun test tests/*.test.ts"),
		);
		const validations = selectValidationObservations(record, ["bun test tests/*.test.ts"]);
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
		expect(rendered.build).toContain("- `binary.bin`");
		expect(rendered.build).toContain("1 pass");
		expect(rendered.evidence).toContain("## LSP 1: diagnostics");
		expect(rendered.evidence).toContain("## Git 1:");
		expect(rendered.evidence).toContain("## Validation 1:");
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

test("validation selection is exact and fail-closed", () => {
	const record = createBuildEvidenceRecord({ runId, planSlug, planDigest, round: 1 });
	record.observations.push(successfulObservation("bun test"));

	expect(selectValidationObservations(record, ["bun test"])).toHaveLength(1);
	expect(() => selectValidationObservations(record, [" bun test "])).toThrow("not recorded");
	expect(() => selectValidationObservations(record, ["bun test", "bun test"])).toThrow("globally unique");
	expect(() => selectValidationObservations(record, ["missing"])).toThrow("not recorded");

	record.observations.push({
		...successfulObservation("bun test", "failed"),
		toolCallId: "later-failure",
		isError: true,
		exitCode: 1,
	});
	expect(() => selectValidationObservations(record, ["bun test"])).toThrow("exit code 0");

	const timedOut = createBuildEvidenceRecord({ runId, planSlug, planDigest, round: 1 });
	timedOut.observations.push({
		...successfulObservation("bun test", "timed out"),
		timedOut: true,
		isError: true,
		exitCode: undefined,
	});
	expect(() => selectValidationObservations(timedOut, ["bun test"])).toThrow("exit code 0");
});

test("record identity mismatches fail closed", () => {
	const record = createBuildEvidenceRecord({ runId, planSlug, planDigest, round: 1 });
	expect(() =>
		parseBuildEvidenceRecord(record, {
			runId,
			planSlug,
			planDigest: createHash("sha256").update("different", "utf8").digest("hex"),
			round: 1,
		}),
	).toThrow("identity");
});
