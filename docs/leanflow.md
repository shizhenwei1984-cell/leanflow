# LeanFlow

LeanFlow minimizes handoffs by keeping planning and implementation in the same Main Session.

## Roles

```text
Main Session
  @plan Planner
    └─ optional @smol Scout
  canonical plan → approval
  @default Builder (same Main Session)
    └─ @slow Gate
```

| Role | Responsibility | May spawn |
| --- | --- | --- |
| Planner | Understand request, investigate, decide feasibility and acceptance coverage, write canonical plan | Scout only, when a focused fact is needed |
| Scout | Repository, call-chain, test, official-documentation, and external fact finding | None |
| Builder | Same Main Session implementation; sole writer | None |
| Gate | Independent final plan/diff/validation verification; PASS/FAIL | One Scout only for an unavailable approved-plan correctness or compatibility fact |

There are no reviewer, audit, validator, planner, implementer, developer, coder, or builder subagents.

## Lifecycle

### PLAN

1. Enter OMP native plan mode.
2. Planner understands the task and reads repository evidence.
3. Use zero Scouts for simple work; use at most three focused Scouts for complex factual gaps.
4. Planner owns completeness, runtime feasibility, acceptance coverage, and implementation feasibility.
5. Write `local://<slug>-plan.md` and request approval with `xd://propose`.

### BUILD

After approval, the same Main Session becomes Builder. It records baseline state, implements the approved plan, runs the planned checks, collects runtime evidence (git diff, docker/compose state, database queries, image versions, test output), and writes `local://<slug>-build.md`, `local://<slug>-diff.md`, plus `local://<slug>-evidence.md`. No code-writing subagent exists.

### GATE

One independent Gate reads the canonical plan, final diff, build record, and runtime evidence by reference. Gate has no shell access; all runtime facts come from the evidence artifact written by Main.
- PASS finishes the run.
- First FAIL is repaired by Main, with refreshed validation and evidence, then one Gate retry is allowed.
- Second FAIL is reported; no reviewer or audit chain is created.

## Extension boundary

`/flow` is intentionally a native-plan bootstrap. The available extension API can prefill `/plan` and display the planning status, but it does not expose plan-approval, build, Gate, or task-dispatch lifecycle hooks. LeanFlow therefore enforces the phase allow-list through the rendered workflow policy and agent declarations rather than inventing unenforceable extension state.

## Budgets

| Path | Maximum independent calls |
| --- | --- |
| Ordinary task | 0 Scout + 1 Gate |
| Complex task | 3 Scout + 1 Gate |
| Repair path | 3 Scout + 2 Gate |

Gate's optional factual Scout is evidence collection, not an additional review role. Scout never returns a verdict.

## Installation

The package installs these workflow artifacts:

```text
commands/flow.md
agents/scout.md
agents/gate.md
skills/leanflow/SKILL.md
extensions/leanflow-bootstrap.ts
```

Use `python3 scripts/install_leanflow.py --scope user --apply` to install them under the user OMP agent directory. The default is symlink mode on POSIX and copy mode on Windows, where ordinary user accounts usually lack the privilege to create symlinks. Pass `--mode symlink` explicitly on Windows only when that privilege is enabled.
