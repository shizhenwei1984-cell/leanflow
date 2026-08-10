---
name: leanflow
description: Low-handoff AI coding workflow for OMP — Planner/Main, optional Scout investigation, same-session Builder, and one independent Gate. Used by /flow.
---

# LeanFlow

LeanFlow uses a minimum-agent architecture with an extension-driven control layer:

- **Planner (`@plan`)** — Main Session plan mode. Understands the request, investigates, decides feasibility and acceptance coverage, writes the canonical plan, and requests approval.
- **Scout (`@smol`)** — Optional cheap factual investigation. Finds repository facts, call paths, tests, official documentation, and external facts. It never plans, writes, reviews, returns PASS/FAIL, or spawns agents.
- **Builder (`@default`)** — The same Main Session after approval. It is the only writer.
- **Gate (`@slow`)** — The one independent final reviewer. It checks plan, diff, and validation evidence and returns PASS, FAIL, or structured BLOCKED.

```text
Main Session
  @plan Planner
    └─ optional @smol Scout (0–3 focused facts)
  canonical plan → approval
  @default Builder (same Main Session)
    └─ @slow Gate (1 call; 2 only after repair)
```

There are no repo reviewers, plan reviewers, auditors, validators, implementers, or reviewer chains. Planner owns plan completeness, runtime feasibility, acceptance coverage, and implementation feasibility. When confidence is insufficient, improve the plan or ask Scout one focused factual question.

## Extension control layer

The `/flow` command initializes an extension state machine (`idle → planning → handoff → building → gating`) that:

- Blocks forbidden agent spawns (reviewer, audit, implementer, etc.) via tool_call interception
- Assesses plan completeness after write (handoff advisor: READY / READY_WITH_WARNINGS / NEEDS_UPDATE)
- Filters planning history from builder context (token optimization)
- Enforces Scout (≤3) and Gate (≤2) budgets
- Persists state via session entries (survives compaction)

## Limits

- Simple work: zero Scout calls and one Gate call.
- Complex work: at most three Scout calls and one Gate call.
- Repair path: the same three Scout-call budget and at most two Gate calls.
- Gate may ask Scout for one focused fact only when required correctness/compatibility evidence is unavailable from the approved plan, repository, diff, and validation artifacts. Gate retains the verdict.

## Evidence

Main writes only `local://<slug>-plan.md`. After the required initial LSP probe, `leanflow_capture_baseline({})` freezes HEAD/status in an extension-owned record and lists the immutable approved validation IDs. Main calls `leanflow_run_validation({ validationId })` for each required entry; the extension executes the approved executable/argv directly, captures repository fingerprints before/after, and rejects mutating or stale evidence. `leanflow_finalize_artifacts({})` mechanically generates `build.md`, `diff.md`, and `evidence.md`, then atomically commits a digest-bound finalized manifest; direct writes are blocked. Gate reads the plan and generated artifacts by reference and has no shell access. Repair rounds keep the baseline but use a new explicit BUILD round and fresh observations. Evidence recovery permits only affected approved validation IDs plus re-finalization, while operational recovery permits only unchanged-manifest Gate redispatch.

## Model roles

Configure aliases once in OMP `config.yml`:

```yaml
modelRoles:
  plan: <high-quality planning model>
  smol: <cheap investigation model>
  slow: <independent gate model>
  default: <builder model>
```

`@plan`, `@smol`, `@slow`, and `@default` are native OMP aliases. No manual model switch is required after native plan approval.
