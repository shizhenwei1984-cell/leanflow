import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { canonicalGateTask, validateGateTaskCall } from "../extensions/leanflow/guard";

const artifacts = {
	plan: "local://example-plan.md",
	build: "local://example-build.md",
	diff: "local://example-diff.md",
	evidence: "local://example-evidence.md",
};

// The package exposes these runtime-only private APIs from TypeScript source; a variable import avoids
// pulling the package's entire unpublished prompt/source graph into this repository's strict tsc check.
async function loadOmpSchemaApis() {
	const sourceRoot = join(
		import.meta.dir,
		"..",
		"node_modules",
		"@oh-my-pi",
		"pi-coding-agent",
		"src",
	);
	const agentsModule = await import(join(sourceRoot, "task", "agents.ts"));
	const validatorModule = await import(join(sourceRoot, "tools", "output-schema-validator.ts"));
	return {
		parseAgent: agentsModule.parseAgent,
		buildOutputValidator: validatorModule.buildOutputValidator,
	};
}

test("Gate agent owns a valid strict verdict schema", async () => {
	const { parseAgent, buildOutputValidator } = await loadOmpSchemaApis();
	const filePath = join(import.meta.dir, "..", "agents", "gate.md");
	const agent = parseAgent(filePath, readFileSync(filePath, "utf8"), "project");
	const { validator, error } = buildOutputValidator(agent.output);

	expect(error).toBeUndefined();
	expect(validator).toBeDefined();
	expect(validator!.validate({ verdict: "PASS", findings: [] }).success).toBe(true);
	expect(
		validator!.validate({
			verdict: "FAIL",
			findings: [
				{
					category: "correctness",
					severity: "blocking",
					file: "extensions/leanflow/index.ts",
					location: "tool_call",
					issue: "Gate shape was not validated.",
					required_fix: "Validate before incrementing the Gate budget.",
				},
			],
		}).success,
	).toBe(true);
	expect(validator!.validate({ verdict: "BLOCKED", findings: [] }).success).toBe(true);
	expect(
		validator!.validate({
			verdict: "FAIL",
			findings: [
				{
					category: "unsupported",
					severity: "blocking",
					file: "x",
					location: "x",
					issue: "x",
					required_fix: "x",
				},
			],
		}).success,
	).toBe(false);
});

test("canonical Gate batch item has no caller schema", () => {
	const item = {
		agent: "gate",
		task: canonicalGateTask(artifacts),
		schemaMode: "strict",
	};
	const input = { context: "LeanFlow Gate", tasks: [item] };

	expect(Object.keys(item)).toEqual(["agent", "task", "schemaMode"]);
	expect("outputSchema" in item).toBe(false);
	expect(validateGateTaskCall(input, artifacts)).toEqual({ block: false });
});
