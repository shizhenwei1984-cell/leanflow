import { createHash } from "node:crypto";

export type ApprovedValidationKind = "test" | "lint" | "typecheck" | "build" | "smoke";

export interface ApprovedValidation {
	id: string;
	executable: string;
	argv: string[];
	digest: string;
	kind: ApprovedValidationKind;
	displayCommand: string;
}

const SHELL_SYNTAX = /[\r\n;&|<>`$(){}\[\]#!\\]/;
const FIXED_COMMANDS: Readonly<Record<string, ApprovedValidationKind>> = {
	"npm test": "test",
	"pnpm test": "test",
	"yarn test": "test",
	"npx vitest run": "test",
	"npx jest": "test",
	pytest: "test",
	"pytest -q": "test",
	"python -m pytest": "test",
	"python -m unittest": "test",
	"uv run pytest": "test",
	"go test ./...": "test",
	"cargo test": "test",
	"cargo check": "typecheck",
	"cargo clippy": "typecheck",
	"make test": "test",
	"make check": "typecheck",
	"git diff --check": "lint",
	"tsc --noEmit": "typecheck",
	"bunx tsc --noEmit": "typecheck",
	"mvn test": "test",
	"mvn verify": "test",
	"./mvnw test": "test",
	"gradle test": "test",
	"./gradlew test": "test",
	"dotnet test": "test",
	"bundle exec rspec": "test",
};

function digest(value: string): string {
	return `validation-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function parseApprovedValidation(command: string): ApprovedValidation | undefined {
	const displayCommand = command.trim();
	if (!displayCommand || SHELL_SYNTAX.test(displayCommand) || /["'\\]/.test(displayCommand)) return undefined;
	const tokens = displayCommand.split(/\s+/);
	const isFocusedBunTest =
		tokens[0] === "bun" &&
		tokens[1] === "test" &&
		tokens.slice(2).every(
			(token) =>
				!token.startsWith("-") &&
				!token.startsWith("/") &&
				/^[\w./*-]+$/.test(token) &&
				!token.split("/").includes(".."),
		);
	const isNpmRunTest =
		tokens[0] === "npm" &&
		tokens[1] === "run" &&
		tokens.length === 3 &&
		/^test(?::[\w-]+)?$/.test(tokens[2]!);
	const isProjectTestScript = /^(?:\.\/)?scripts\/(?:test|check)\.sh$/.test(tokens[0]!) && tokens.length === 1;
	const isRailsTest = tokens[0] === "bin/rails" && tokens.length === 2 && tokens[1] === "test";
	const kind = isFocusedBunTest || isNpmRunTest || isProjectTestScript || isRailsTest ? "test" : FIXED_COMMANDS[displayCommand];
	if (!kind) return undefined;
	return {
		id: digest(displayCommand),
		executable: tokens[0]!,
		argv: tokens.slice(1),
		digest: digest(displayCommand),
		kind,
		displayCommand,
	};
}
