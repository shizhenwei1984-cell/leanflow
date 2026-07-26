---
name: leanflow
description: Low-handoff AI coding workflow for OMP — plan in native plan mode, build in the same session, review with an independent read-only Gate. On-demand Scout investigators. Used by /flow.
---

# LeanFlow

LeanFlow is the workflow started by `/flow <task>`. This skill holds the **rationale and configuration**; the step-by-step lifecycle lives in the `/flow` command body, which is the authoritative instruction set during a run.

## Why LeanFlow exists

Traditional multi-agent pipelines (`Architect → Dispatcher → Implementer → Reviewer`) pay a large handoff token cost: each spawn re-reads code and re-receives summaries. LeanFlow keeps the **Planner and Builder as the same main session**, so the implementation inherits the investigation context for free. The only mandatory spawn is an independent **Gate** reviewer; optional cheap **Scouts** handle location-only investigation when the task is complex.

## Why the Planner is the main session, not a pipeline node

A separate Planner agent forces a handoff: the planner's investigation must be summarized and re-sent to the builder. For the common case — a bounded bug fix or feature — the planner and the builder are the same mind. Keeping them in one session means the implementation inherits the full investigation for free. The planner can still delegate *location* (not design) to cheap scouts when the task is complex.

## Why there is no fixed preflight

A fixed preflight (always-spawn investigator) taxes simple tasks with the cost of complex ones. The planner, having read the task, is the best judge of investigation depth: a one-file change needs zero scouts; a cross-module refactor needs focused parallel scouts. Dynamic depth keeps the average handoff low without capping the ceiling.

## Why the Main Builder is not an independent agent

An independent Implementer agent must re-read the code the planner already read, and re-receive the plan the planner already wrote. That is the single largest handoff in a traditional pipeline. LeanFlow's main session implements directly after approval — it already holds the plan and the investigation. The single-writer principle is preserved (only the main session edits); independence is provided by the Gate, not by splitting the builder.

## Why the Gate must be independent

The one handoff worth paying for is a fresh pair of eyes that did not write the code. The gate reads the approved plan, the diff artifact, and the validation results — by reference — and returns PASS or structured FAIL. It never writes (its tool set is `read`/`grep`/`glob` only, enforced by frontmatter), so it cannot regress the tree, and its fresh context means it is not anchored to the planner's assumptions. This is the irreducible minimum for real review independence.

## Handoff accounting

```text
Traditional (Architect→Dispatcher→Implementer→Reviewer):
  3+ spawns, each reads code fresh, each handoff = summary artifact + prompt re-send.

LeanFlow:
  Main[Planner, @plan] → (0–3 scout @smol, one batch, short output) → Main[Builder, @default] → gate(@slow) → Main
  Mandatory spawns: 1 (gate). Optional cheap scouts: 0–3. Max 3 scouts per run. Max 2 gate calls per run.
  Main never re-reads its own investigation. Gate reads references, returns one small JSON.
```

## Model roles (configured in one place, no vendor lock-in)

```yaml
# ~/.omp/agent/config.yml  (user) or .omp/config.yml (project)
modelRoles:
  default: <coding/implementation model>      # main session BUILD
  plan:    <high-quality architecture model>   # PLAN phase (optional)
  smol:    <cheap investigation model>        # scouts
  slow:    <independent reviewer model>        # gate
```

`@plan` / `@smol` / `@slow` / `@default` are OMP native model-role aliases (from the `ModelRole` enum). Agents reference them in frontmatter (`model: "@smol"`). Swap concrete models in `config.yml` only — no agent or command edits needed.

- `@plan` is optional. If `modelRoles.plan` is unset, OMP native plan mode stays on the current model.
- `@smol` / `@slow` unset → OMP falls back to the `default` model; `/flow` warns once when a role collapses to `default` (scouts stop being cheap, gate loses model diversity).
- OMP native plan-mode approval lets the user pick the execution model (defaults to `@default`) at approval time — no manual `/model` switch needed.

## Gate loop

Max **2 gate calls** per run (count calls, not repairs). On the 2nd FAIL, the main session reports the last blocking findings and stops — it does not commit and does not spawn a new builder. Blocking categories: `correctness`, `validation_failure`, `plan_deviation`, `missing_change`, `regression_risk`. Non-blocking: `style`, `naming` (never drive a FAIL).

## Large changes

If the plan touches more than ~8 files or the diff exceeds a few thousand lines, split into phases and gate each phase independently rather than one monolithic gate.