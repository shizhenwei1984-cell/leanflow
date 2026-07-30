# LeanFlow

Low-handoff AI coding workflow for OMP. Extension-driven plan → build → gate with tool guards, context optimization, and minimal agent architecture.

## Quick start

```bash
python3 scripts/install_leanflow.py --scope user --apply
```

Then in OMP: `/flow <task description>`

## Architecture

```text
LeanFlow Extension (state machine + guard + handoff + context filter)
        │
   Main Session
     @plan Planner ──→ optional @smol Scout (0–3)
        │
   canonical plan → xd://propose approval
        │
     @default Builder (same session, filtered context)
        │
     @slow Gate (1 call; 2 after repair)
```

No reviewer, audit, validator, or implementer agents. Ever.

## Package contents

```text
commands/flow.md              Workflow reference (kept for compatibility)
agents/scout.md               Scout agent definition
agents/gate.md                Gate agent definition
skills/leanflow/SKILL.md      Skill documentation
extensions/leanflow/          Extension control layer
  index.ts                    Entry point: /flow command, event wiring
  state.ts                    State machine types + persistence
  guard.ts                    Tool guard (forbidden agent blocking)
  handoff.ts                  Handoff advisor (plan assessment)
  context.ts                  Builder context filter (token optimization)
  stats.ts                    Runtime token/context statistics (/flowstats)
scripts/install_leanflow.py   Installer (symlink/copy, user/project scope)
docs/leanflow.md              Detailed documentation
tests/                        Test suite
```

## Observability and verification

`/flowstats` reports latest builder context-filter message and deterministic serialized UTF-8 byte reductions separately. Provider token reduction is always `not measured`; Scout and Gate subagent tokens are also `not measured`. It includes Main Session usage, responses, and elapsed time for `planning`, `awaiting_approval`, `building`, and `gating`, plus explicit Gate/repair outcome counters.

LeanFlow uses LSP symbol references and diagnostics only as best-effort auxiliary evidence. If unavailable or timed out, Builder continues with source inspection, compiler checks, executable tests, and runtime smoke tests. LSP availability/results belong in `build.md` and `evidence.md`, not `/flowstats`.

Gate outcomes are distinct: a parsed `FAIL` increments verdict failures; a tool or unparseable result increments execution/unparseable errors; a readiness block consumes no attempt. The first non-PASS Gate outcome enters one repair round, a later PASS is a repair success, and a non-PASS second attempt is terminal.
