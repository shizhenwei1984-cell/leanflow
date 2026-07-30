# LeanFlow

LeanFlow minimizes handoffs by keeping planning and implementation in the same Main Session, with an extension-driven control layer providing state management, tool guards, and context optimization.

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

## Extension Control Layer

The LeanFlow extension (`extensions/leanflow/`) provides:

- **State machine** — tracks `idle → planning → awaiting_approval → building → gating` phases, persists them via session entries, and measures Main Session provider usage, response count, and elapsed time for each observable phase
- **Tool guard** — blocks forbidden agent spawns (reviewer, audit, implementer, etc.) per phase
- **Handoff advisor** — assesses plan completeness after write; READY/READY_WITH_WARNINGS proceed, NEEDS_UPDATE advises revision (never hard-blocks except critical gaps)
- **Gate readiness** — Gate is blocked until build/diff/evidence artifacts are written, preventing premature gate calls without consuming an attempt
- **Context filter** — during building phase, removes planning history from LLM context, injects a compact builder preamble referencing the approved plan artifact, and records latest message-count and deterministic serialized UTF-8 byte observations separately
- **Budget enforcement** — max 3 Scout calls and max 2 Gate calls, checked before incrementing at the tool_call level
- **Runtime stats** — `/flowstats` reports Main Session phase metrics, Gate outcome counters, and context-filter reductions. Provider reduction plus Scout/Gate subagent tokens are `not measured`, never estimated

## Lifecycle

### PLAN

1. `/flow` initializes the state machine and enters native plan mode with a minimal planning prompt.
2. Planner understands the task and reads repository evidence.
3. Use zero Scouts for simple work; use at most three focused Scouts for complex factual gaps.
4. Planner owns completeness, runtime feasibility, acceptance coverage, and implementation feasibility.
5. Write `local://<slug>-plan.md`; after handoff assessment the state becomes `awaiting_approval`, then request approval with `xd://propose`.
6. Only the first repository-mutating post-approval action transitions the extension to `building`.

### BUILD

After approval, the same Main Session becomes Builder. The extension filters planning history from context and injects a compact builder preamble. Builder records baseline state, implements the approved plan, runs the planned checks, collects runtime evidence, and writes `local://<slug>-build.md`, `local://<slug>-diff.md`, plus `local://<slug>-evidence.md`. No code-writing subagent exists.

### GATE

One independent Gate reads the canonical plan, final diff, build record, and runtime evidence by reference. Gate has no shell access; all runtime facts come from the evidence artifact written by Main.
- PASS finishes the run.
- First FAIL is repaired by Main, with refreshed validation and evidence, then one Gate retry is allowed.
- Second FAIL is reported; no reviewer or audit chain is created.

## Statistics semantics

`/flowstats` keeps three distinct context-filter measures: latest message counts, latest deterministic serialized UTF-8 bytes (a payload-size proxy), and provider token reduction. Message and byte reductions are never labeled as token reductions. Serialization failures retain the message observation and mark bytes unavailable. The token reduction is always `not measured`.

Each `planning`, `awaiting_approval`, `building`, and `gating` bucket contains Main Session provider input/output/cache-read usage, response count, and observed elapsed time. Missing historical phase-start timestamps are not estimated. Workflow outcomes separately count Gate passes, parsed FAIL verdicts, execution/unparseable errors, readiness blocks, repair rounds, repair successes, and terminal failures.

## LSP verification fallback

Before Baseline HEAD or any other build action, Builder runs LSP diagnostics for the first planned source path (or `*` when none is planned) and waits for its result. This runtime probe is the authoritative LSP configuration detector: it resolves active project, user/profile, plugin, marketplace, and auto-detected configuration. Record the target, responding server or `no server`, result, and fallback. A completed probe with `no server` or an error is a recorded fallback, not a flow blocker.

For every changed source path served by the probe or a later LSP call, Builder attempts diagnostics before and after edits. A new file has no pre-edit baseline and is checked after creation. Builder attempts references before changing an exported symbol. Record every probe/request/result in `build.md` and `evidence.md`. LSP diagnostics are supplementary rather than executable validation; all introduced errors and warnings must be repaired, while unrelated pre-existing diagnostics are recorded exactly. Builder continues with `read`/`grep`, compiler checks, executable tests, and runtime smoke tests. LSP facts never enter `/flowstats` or Builder context statistics. The repository `.lsp.json` declares Python and TypeScript/JavaScript capabilities but does not install language-server binaries.

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
extensions/leanflow/          (directory: index.ts, state.ts, guard.ts, handoff.ts, context.ts)
```

Use `python3 scripts/install_leanflow.py --scope user --apply` to install them under the user OMP agent directory. The default is symlink mode on POSIX and copy mode on Windows.

### Upgrading from v1

If you previously installed LeanFlow v1 (single `leanflow-bootstrap.ts`), uninstall first:

```bash
python3 scripts/install_leanflow.py --scope user --uninstall --apply
python3 scripts/install_leanflow.py --scope user --apply
```
