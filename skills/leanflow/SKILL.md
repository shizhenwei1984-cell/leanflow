---
name: leanflow
description: Low-handoff AI coding workflow for OMP — plan and build in the same main session, with on-demand Scout investigators and one independent read-only Gate reviewer.
---

# LeanFlow

Use when running a LeanFlow workflow (started by `/flow <task>`). LeanFlow minimizes inter-agent context duplication by keeping the planner and the builder as the **same main session**, and by passing the independent gate's inputs by reference rather than pasting them.

## Lifecycle

```text
/flow <task>
  ↓
PLAN  (main session = Planner; model @plan when configured)
  - bounded read-only investigation (read/grep/glob/lsp, same session)
  - simple task → 0 scouts; complex task → 1–3 parallel scout(@smol)
  - write plan to local://leanflow/<run-id>/plan.md
  - OMP native plan-mode approval
  ↓
APPROVE
  ↓
BUILD  (same main session = sole writer; model @default)
  - implement directly (inherits investigation+plan context, zero re-read)
  - run the plan's validation commands
  - write local://leanflow/<run-id>/build.md (changed files, git diff --stat, results)
  ↓
GATE  (independent one-shot gate agent; model @slow, read-only)
  - task({agent:"gate", handle, schema, schemaMode:"strict"})
  - reads local://leanflow/<run-id>/plan.md + git diff + local://leanflow/<run-id>/build.md
  - returns {verdict: PASS|FAIL, findings?}
  ↓
PASS → done      FAIL → main session fixes, re-validates, re-gates (max 2 rounds)
```

## Why this reduces handoff token

- **No Planner→Builder handoff**: the main session is both. The investigation context is never re-sent.
- **No fixed preflight**: simple tasks spawn zero scouts. The planner decides depth from complexity.
- **Cheap scouts**: when used, they return only a short Files/Symbols/Tests/Unknowns list — no design, no re-narration.
- **No Implementer agent**: the main session writes; it already has the plan context.
- **Reference, don't paste**: the gate reads `local://` artifacts and runs `git diff` itself. Nothing is pasted into a prompt.
- **One mandatory spawn**: the gate. Optional cheap scouts (0–3). That is the entire handoff budget.

## Single-writer rule

Only the main session edits files. Scouts and Gate are read-only. No agent spawns a builder.

## Gate contract

- Reads plan + diff + build results by reference.
- Returns `{verdict:"PASS"|"FAIL", findings:[{severity,file,location,issue,required_fix}]}`.
- Blocking categories: `correctness`, `validation_failure`, `plan_deviation`, `missing_change`, `regression_risk`.
- Non-blocking: `style`, `naming` (never drive a FAIL).
- Max 2 gate rounds; on the second FAIL, stop and report — do not commit.

## Model roles (configured in one place, no vendor lock-in)

```yaml
# ~/.omp/agent/config.yml  (user) or .omp/config.yml (project)
modelRoles:
  default: <coding/implementation model>      # main session BUILD
  plan:    <high-quality architecture model>   # PLAN phase (optional)
  smol:    <cheap investigation model>        # scouts
  slow:    <independent reviewer model>        # gate
```

`@plan` / `@smol` / `@slow` / `@default` are OMP native model-role aliases. Agents reference them in frontmatter (`model: "@smol"`). Swap concrete models in `config.yml` only.