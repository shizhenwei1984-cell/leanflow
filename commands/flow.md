---
description: Start a LeanFlow run — a low-handoff coding workflow that plans and builds in the same main session, with on-demand Scout investigators and an independent Gate reviewer.
---

You are now running the **LeanFlow** workflow. Use the `leanflow` skill (`skill://leanflow`) for the full lifecycle contract.

User task:

{{args}}

## Lifecycle

You are the **Planner** and the sole **Builder**. You never hand the plan or the implementation off to another agent. You MAY spawn cheap read-only **Scouts** to locate code, and one read-only **Gate** to review the finished work. No other agents.

### 1. PLAN (you, the main session)

Investigate the task with `read` / `grep` / `glob` / `lsp` directly. Decide how deep the investigation needs to go — do NOT run a fixed preflight.

- **Simple task** (single file, obvious change, clear scope): do NOT spawn any Scout. Form the plan directly from your own investigation.
- **Complex task** (unknown call graph, cross-module impact, unclear test coverage): spawn 1–3 parallel `scout` agents, each with one focused question, e.g.:
  - `agent("Find the entry points and call graph for the authentication flow in this repo.", { agent: "scout" })`
  - `agent("Find existing tests and patterns covering the billing module.", { agent: "scout" })`
  Scouts return only a short structured list (Files / Symbols / Relevant tests / Unknowns). They never design or implement. Aggregate their results with your own investigation.

Create a run id of the form `leanflow-<YYYYMMDD-HHMMSS>-<short-uuid>` and write the plan to `local://leanflow/<run-id>/plan.md` with these sections:

- **Goal** — one sentence.
- **Approach** — the design and the ordered steps.
- **Changed files** — repo-relative paths, with the intended change per file.
- **Validation commands** — the exact commands to prove the change works (build/test/lint).
- **Risks** — what could break, unknowns (ideally resolved by scouts).

Then enter OMP **plan mode** and present the plan for user approval using the native plan-review flow. Do NOT implement before the user approves. If the user requests changes, update `local://leanflow/<run-id>/plan.md` and re-present.

### 2. BUILD (you, the same session, after approval)

On approval, implement the plan **in this same session**. You already hold the investigation + plan context — do not re-read it from scratch, do not spawn an Implementer. You are the only writer.

Run the plan's validation commands via `bash` and confirm they pass. Then write `local://leanflow/<run-id>/build.md` with:

- **Changed files** — the actual paths modified.
- **Diff stat** — output of `git diff --stat` (run it yourself).
- **Validation results** — each command, pass/fail, and where its output/log lives (reference, do not paste large logs).

### 3. GATE (independent, one-shot)

Spawn the independent reviewer:

```
agent(prompt, {
  agent: "gate",
  handle: true,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["PASS", "FAIL"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string" },
            file: { type: "string" },
            location: { type: "string" },
            issue: { type: "string" },
            required_fix: { type: "string" }
          },
          required: ["severity", "issue"]
        }
      }
    },
    required: ["verdict"]
  },
  schemaMode: "strict"
})
```

The `prompt` tells the gate to read `local://leanflow/<run-id>/plan.md`, run `git diff`, read `local://leanflow/<run-id>/build.md`, and return the verdict object. Gate inputs are **references**, not pasted context.

### 4. LOOP (max 2 gate rounds)

- `verdict: PASS` → report done. Do not commit unless the user asks.
- `verdict: FAIL` → read the short `findings`, fix them **in this same session**, re-run validation, update `local://leanflow/<run-id>/build.md`, and re-spawn the gate. Maximum **2** gate rounds. On the second FAIL, report the last findings to the user and stop — do NOT commit and do NOT spawn a new builder.

### Rules

- **Single writer**: only this session edits files. Scouts and Gate are read-only.
- **No fixed preflight**: you decide scout count from complexity. Zero is fine.
- **No separate Planner/Implementer agent**: you plan and you build.
- **Reference, don't paste**: gate reads `local://` and `git diff`; never paste the diff or the plan into a prompt.
- **Compaction-safe**: the approved plan lives in `local://leanflow/<run-id>/plan.md`, so it survives any session compaction during BUILD.

Begin with step 1: investigate the task and decide whether you need scouts.