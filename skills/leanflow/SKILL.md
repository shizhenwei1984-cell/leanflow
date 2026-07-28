---
name: leanflow
description: Low-handoff AI coding workflow for OMP — Planner/Main, optional Scout investigation, same-session Builder, and one independent Gate. Used by /flow.
---

# LeanFlow

LeanFlow uses a minimum-agent architecture:

- **Planner (`@plan`)** — Main Session plan mode. Understands the request, investigates, decides feasibility and acceptance coverage, writes the canonical plan, and requests approval.
- **Scout (`@smol`)** — Optional cheap factual investigation. Finds repository facts, call paths, tests, official documentation, and external facts. It never plans, writes, reviews, returns PASS/FAIL, or spawns agents.
- **Builder (`@default`)** — The same Main Session after approval. It is the only writer.
- **Gate (`@slow`)** — The one independent final reviewer. It checks plan, diff, and validation evidence and returns PASS or FAIL.

```text
Main Session
  @plan Planner
    └─ optional @smol Scout (0–3 focused facts)
  canonical plan → approval
  @default Builder (same Main Session)
    └─ @slow Gate (1 call; 2 only after repair)
```

There are no repo reviewers, plan reviewers, auditors, validators, implementers, or reviewer chains. Planner owns plan completeness, runtime feasibility, acceptance coverage, and implementation feasibility. When confidence is insufficient, improve the plan or ask Scout one focused factual question.

## Limits

- Simple work: zero Scout calls and one Gate call.
- Complex work: at most three Scout calls and one Gate call.
- Repair path: the same three Scout-call budget and at most two Gate calls.
- Gate may ask Scout for one focused fact only when required correctness/compatibility evidence is unavailable from the approved plan, repository, diff, and validation artifacts. Gate retains the verdict.

## Evidence

Main writes `local://<slug>-plan.md`, `local://<slug>-build.md`, `local://<slug>-diff.md`, and `local://<slug>-evidence.md`. Gate reads all four by reference. Main records baseline/final state, each validation command, and complete runtime evidence output (git diff, docker/compose state, database queries, image versions, test results) before Gate. Gate has no shell access; `evidence.md` is its only runtime evidence source.

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
