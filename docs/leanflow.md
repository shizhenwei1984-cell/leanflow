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

- **State machine** — tracks `idle → planning → awaiting_approval → building → gating → finalizing → idle`, persists it via session entries, and measures Main Session provider usage, response count, and elapsed time
- **Durable approval identity** — binds the approved plan's opaque run ID and SHA-256 content digest to extension-owned `local://.leanflow/runs/<runId>.json` state plus `local://.leanflow/active/<slug>.json`; model tool calls cannot modify that namespace, while terminal, cancelled, invalidated, expired, or malformed markers cannot recover
- **Tool guard** — fails closed before approval and while the initial LSP probe is pending: only explicit read-only tools/LSP actions and exact workflow exceptions are allowed; Hashline, `local:/`, `local://`, and absolute sandbox targets resolve to filesystem identity; Main remains the sole writer
- **Handoff advisor** — assesses plan completeness after write; a missing or mismatched run identity blocks approval
- **Gate readiness** — Gate is blocked until build/diff/evidence artifacts are refreshed, preventing premature calls without consuming an attempt
- **Context filter** — through BUILD, GATE, and finalization, removes planning history, injects a compact builder preamble, and records message-count and serialized-byte observations separately
- **Budget enforcement** — max 3 Scout calls and max 2 Gate calls, checked before incrementing at the `tool_call` level
- **Runtime stats** — `/flowstats` reports Main Session phase metrics, distinct Gate verdict/error counters, and context-filter reductions. Provider reduction plus Scout/Gate tokens are `not measured`

## Lifecycle

### PLAN

1. `/flow` initializes the state machine and enters native plan mode with a minimal planning prompt.
2. Planner understands the task and reads repository evidence.
3. Use zero Scouts for simple work; use at most three focused Scouts for complex factual gaps.
4. Planner owns completeness, runtime feasibility, acceptance coverage, and implementation feasibility.
5. Write or edit `local://<slug>-plan.md` with exactly one extension-provided `LeanFlow run ID` and one `LSP applicability` declaration outside fenced code. Every successful canonical-plan mutation is reread and reassessed from disk; stale proposal identity and marker state are invalidated.
6. `xd://propose` is fail-closed outside `awaiting_approval` and rereads the marked plan before opening approval. Exact native approval rereads the final overlay content, refreshes its digest and LSP state, then moves to `building`. Invalid final content keeps repository mutations locked and queues a local `/plan` repair of the existing artifact; re-proposal is blocked until native plan mode has actually been re-entered.

### BUILD

After approval, the same Main Session becomes Builder. The extension filters planning history from context and injects a compact builder preamble. Builder records baseline state, implements the approved plan, runs the planned checks, collects runtime evidence, and writes `local://<slug>-build.md`, `local://<slug>-diff.md`, plus `local://<slug>-evidence.md`. No code-writing subagent exists.

### GATE

One independent Gate reads the canonical plan, final diff, build record, and runtime evidence by reference. Gate has no shell access; all runtime facts come from the evidence artifact written by Main.
- PASS moves to `finalizing`; the compact context remains active through the terminal response, then the run becomes idle.
- First valid FAIL is repaired by Main with refreshed validation/evidence, then one Gate retry is allowed.
- A Gate operational error preserves evidence and permits a bounded review retry without counting an implementation repair.
- Second FAIL or second operational failure is reported; no reviewer or audit chain is created.

## Statistics semantics

`/flowstats` keeps three distinct context-filter measures: latest message counts, latest deterministic serialized UTF-8 bytes (a payload-size proxy), and provider token reduction. Message and byte reductions are never labeled as token reductions. Serialization failures retain the message observation and mark bytes unavailable. The token reduction is always `not measured`.

Each `planning`, `awaiting_approval`, `building`, and `gating` bucket contains Main Session provider input/output/cache-read usage, response count, and observed wall time. `finalizing` usage and elapsed time remain attributed to `gating`. Fresh approval recovery settles the persisted approval-wait interval before BUILD. Workflow outcomes separately count Gate passes, parsed FAIL verdicts, execution/unparseable errors, readiness blocks, implementation repair rounds, repair successes, and terminal failures.

## LSP verification fallback

The plan declares exactly one `LSP applicability` value outside fenced code. `required` (and missing, invalid, or duplicated metadata) requires Builder to run diagnostics for an existing planned source path or `*` before Baseline HEAD or any other build action. Empty, unsafe, or nonexistent file targets do not unlock BUILD. A completed probe with `no server`, timeout, or initialization error is a recorded fallback rather than a flow blocker.

`not_required` is limited to documentation/static-resource work with no LSP-serviceable source changes. Builder records why the probe was skipped; Gate verifies that explanation against the final diff. For every changed source path served by LSP, Builder attempts diagnostics before and after edits; new files are checked after creation, and exported-symbol changes require a references attempt. LSP remains supplementary to compiler checks, executable tests, and runtime smoke validation.

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
