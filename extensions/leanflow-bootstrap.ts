/**
 * LeanFlow workflow bootstrap.
 *
 * Registers the `/flow` command so it enters OMP native plan mode with the
 * LeanFlow workflow prompt as the first plan-mode turn. A plain markdown slash
 * command only expands into a normal prompt and cannot toggle plan mode; this
 * extension command closes that gap by pre-filling the editor with `/plan`
 * followed by the rendered workflow prompt, so the operator hits Enter once
 * and lands in native plan mode (read-only tools, @plan model, xd://propose
 * approval) with the full LeanFlow lifecycle instructions already in context.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const FRONTMATTER_RE = /^---\n.*?\n---\n/s;
const ARGUMENTS_RE = /\{\{ARGUMENTS\}\}/g;

function findFlowPrompt(thisPath: string, cwd: string, agentDir: string): string {
	const candidates = [
		join(resolve(cwd), ".omp", "commands", "flow.md"),
		join(agentDir, "commands", "flow.md"),
		join(dirname(thisPath), "..", "commands", "flow.md"),
	];
	for (const candidate of candidates) {
		try {
			const text = readFileSync(candidate, "utf8");
			if (text.includes("LeanFlow")) return text.replace(FRONTMATTER_RE, "").trim();
		} catch {
			// try next candidate
		}
	}
	// Fallback: the command file shipped beside this extension in the package.
	return readFileSync(join(dirname(thisPath), "..", "commands", "flow.md"), "utf8")
		.replace(FRONTMATTER_RE, "")
		.trim();
}

export default function leanflowBootstrap(pi: ExtensionAPI): void {
	pi.registerCommand("flow", {
		description:
			"Start LeanFlow: Main plans and builds in one session, optional Scout facts, then one independent Gate. Pre-fills `/plan <workflow prompt>` so Enter enters plan mode.",
		handler: async (rawArgs, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("LeanFlow /flow requires the interactive TUI.", "error");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("/flow can only start when the session is idle with no pending messages.", "error");
				return;
			}

			const task = (rawArgs ?? "").trim();
			const agentDir = resolve(pi.pi.settings.getAgentDir());
			const modulePath = resolve(dirname(new URL(import.meta.url).pathname));
			let promptBody: string;
			try {
				promptBody = findFlowPrompt(modulePath, ctx.cwd, agentDir);
			} catch (error) {
				ctx.ui.notify(
					`LeanFlow could not load commands/flow.md: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const rendered = task ? promptBody.replace(ARGUMENTS_RE, task) : promptBody;
			// Pre-fill the editor with `/plan ` + the full workflow prompt. The
			// operator hits Enter to enter native plan mode with this as the
			// first plan-mode turn. This is the only way to enter plan mode from
			// an extension command: the extension context does not expose
			// handlePlanModeCommand, and sendUserMessage bypasses slash dispatch.
			ctx.ui.setEditorText(`/plan ${rendered}`);
			ctx.ui.setStatus("leanflow", "LeanFlow planning: Main + optional Scout only");
		},
	});
}