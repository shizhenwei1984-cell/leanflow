---
description: Start a LeanFlow run — a low-handoff coding workflow. Plan in OMP native plan mode (model @plan), build in the same session (model @default), review with an independent Gate (@slow). On-demand Scout investigators (@smol).
---

You are now running the **LeanFlow** workflow. The full lifecycle contract is in the `leanflow` skill — load `skill://leanflow` once if you need the rationale; otherwise follow these instructions directly.

User task:

{{ARGUMENTS}}

## Roles

- **You** are the **Planner** and the sole **Builder**. You never hand plan or implementation to another agent.
- **Scouts** (`@smol`, read-only) locate code/call-graphs/tests. They never design or implement. Optional, max 3 total per run.
- **Gate** (`@slow`, read-only) reviews the finished work against the approved plan. One independent spawn.

### Role check (before planning)

Before investigating, verify the model roles are configured so each phase runs on the intended model. Run `omp config get modelRoles` (or check `~/.omp/agent/config.yml` / `.omp/config.yml`). If `modelRoles.plan`, `modelRoles.smol`, or `modelRoles.slow` are unset, OMP falls back to the `default` model for that role — scouts stop being cheap, the gate loses model diversity, and "expensive model only for high-value phases" no longer holds. If any of those three roles is unset or resolves to the same model as `default`, warn the user once and proceed (do not block); the user can bind them in `config.yml` and re-run.
## 1. PLAN — use OMP native plan mode

Enter OMP **plan mode** now (the operator triggers it via the plan key or `/plan`; you do not implement until plan mode is exited via approval). In plan mode you are restricted to read-only tools, the session switches to `modelRoles.plan`, and you write the canonical plan artifact.

Investigate the task with `read` / `grep` / `glob` directly. Decide scout depth from complexity — do NOT run a fixed preflight:

- **Simple task** (single file, obvious change, clear scope): no scouts. Form the plan from your own investigation.
- **Complex task** (unknown call graph, cross-module impact, unclear tests): spawn 1–3 scouts in **one native task batch**. Each scout gets one focused question. Example batch ( scouts are `blocking: true`, so all results return in this one call):

```text
task({
  context: "LeanFlow investigation for: {{ARGUMENTS}}",
  tasks: [
    { agent: "scout", name: "scout-code",   task: "Find the entry points and call graph for the authentication flow in this repo." },
    { agent: "scout", name: "scout-tests",  task: "Find existing tests and patterns covering the billing module." }
  ]
})
```

Scouts return only a short structured list (Files / Symbols / Relevant tests / Unknowns). Aggregate their results with your own investigation. **Total scout budget for the entire run is 3**; you may not spawn more across later rounds.

### Write the plan as the canonical plan artifact

Write the plan to `local://<slug>-plan.md` where `<slug>` is a short kebab-case name for this task (e.g. `local://auth-token-refresh-plan.md`). This is the OMP-native canonical plan path — it is never renamed, survives compaction, and is what `xd://propose` references. Sections:

- **Goal** — one sentence.
- **Approach** — the design and the ordered steps.
- **Changed files** — repo-relative paths, with the intended change per file.
- **Validation commands** — the exact commands to prove the change works (build/test/lint).
- **Risks** — what could break; unknowns (ideally resolved by scouts).

Use `edit` for incremental updates; `write` only to create or fully replace. Write findings as you learn them — never batch all writing to the end.

### Request approval via `xd://propose`

When the plan is decision-complete, write the plan's `<slug>` (the same slug as your `local://<slug>-plan.md`) as plain text to `xd://propose`. This is the **only** way to request approval — never ask the user to exit plan mode in prose, never use `ask` for approval. The user then picks an execution option in the native plan-review overlay (approve / approve-and-compact / keep context) and chooses the execution model (defaults to `@default`).

If the user requests changes, update `local://<slug>-plan.md` with `edit` and write the slug to `xd://propose` again when ready.

## 2. BUILD — same session, sole writer

On approval, plan mode exits, full tools are restored, and the session switches back to the pre-plan model (or the model the user picked in the approval overlay — default `@default`). Implement the plan **in this same session**. You already hold the investigation + plan context — do not re-read it from scratch, do not spawn an Implementer. **You are the only writer.**

Run the plan's validation commands via `bash` and confirm they pass. Then write two artifacts the gate will read by reference:

- `local://<slug>-diff.md` — the full `git diff` output (run `git diff` yourself and write the result). The gate has no `bash` and cannot run git, so this is how it sees the changes.
- `local://<slug>-build.md` — with: **Changed files** (actual paths modified), **Diff stat** (`git diff --stat`), **Validation results** (each validation command from the plan, its exit code, and where its output/log lives — reference the path, do not paste large logs), and **HEAD** (`git rev-parse HEAD`).

## 3. GATE — independent, one-shot, native task

Spawn the gate with the **native task tool** and `outputSchema` (not `schema`). The gate has no `bash` — it reads the plan, the diff artifact, and the build record by reference, never pasted:

```text
task({
  agent: "gate",
  task: "Review the LeanFlow run whose plan is local://<slug>-plan.md, diff is local://<slug>-diff.md, and build record is local://<slug>-build.md. Read all three and return your verdict object.",
  outputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["PASS", "FAIL"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["correctness","validation_failure","plan_deviation","missing_change","regression_risk","style","naming"] },
            severity: { type: "string", enum: ["blocking","nonblocking"] },
            file: { type: "string" },
            location: { type: "string" },
            issue: { type: "string" },
            required_fix: { type: "string" }
          },
          required: ["category", "severity", "issue"]
        }
      }
    },
    required: ["verdict"]
  },
  schemaMode: "strict"
})
```

A `FAIL` verdict MUST have at least one finding with `severity: "blocking"` and a `category` in `correctness | validation_failure | plan_deviation | missing_change | regression_risk`. `style`/`naming` findings are non-blocking and MUST NOT drive a FAIL.

## 4. LOOP — max 2 gate calls

Count gate **calls**, not repairs:

- `verdict: PASS` → report done. Do not commit unless the user asks.
- `verdict: FAIL` → read the blocking findings, fix them **in this same session**, re-run the plan's validation commands, **re-write `local://<slug>-diff.md`** with the fresh `git diff` output, update `local://<slug>-build.md`, and call the gate again. The gate has no `bash` and reads the diff artifact by reference — if you do not re-write it, the second gate call reviews the pre-fix diff and cannot see your repairs.
- **Maximum 2 gate calls per run.** On the 2nd FAIL, report the last blocking findings to the user and stop — do NOT commit and do NOT spawn a new builder.

## Rules

- **Single writer**: only this session edits repo files. Scouts and Gate are read-only (enforced by their tool set — they have no `edit`/`write`).
- **No fixed preflight**: you decide scout count from complexity. Zero is fine. Max 3 total per run, spawned in one batch.
- **No separate Planner/Implementer agent**: you plan and you build.
- **Reference, don't paste**: the gate reads `local://` artifacts (plan, diff, build) by reference; never paste the diff or the plan into a prompt. The gate does not run `git` — you write `local://<slug>-diff.md` and it reads that.
- **Compaction-safe**: the approved plan lives in `local://<slug>-plan.md`, the canonical OMP plan artifact, so it survives any session compaction during BUILD. After compaction, re-read the plan file rather than trusting inline context.
- **Large changes**: if the plan touches more than ~8 files or the diff exceeds a few thousand lines, split into phases and gate each phase independently rather than one monolithic gate.

Begin with step 1: enter plan mode, investigate the task, and decide whether you need scouts.