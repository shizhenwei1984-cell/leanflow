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
  state.ts                    Versioned lifecycle state + persistence
  machine.ts                  Pure lifecycle and recovery reducers
  validation.ts               Approved validation contract parser
  evidence.ts                 BUILD record and artifact rendering
  provenance.ts               Finalized manifest and retry identity
  guard.ts                    Tool and agent guard
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

Gate outcomes are distinct: PASS/FAIL are verdicts; structured BLOCKED names affected validation IDs without consuming a verdict; tool/transport errors enter unchanged-manifest operational retry; readiness blocks consume no attempt. Validation runs only through `leanflow_run_validation({ validationId })`, and Gate dispatch is authorized only by the atomic finalized manifest produced by `leanflow_finalize_artifacts({})`.

The finalized manifest binds the run ID, plan and approved-validation digests, explicit BUILD round, BUILD-record digest, all three artifact digests, repository fingerprint, and semantic validation states. `writtenArtifacts` is display-only and never grants Gate authority.

Repair setup is a persisted checkpoint transaction: LeanFlow records the repair lease before advancing the BUILD record, then reconciles either crash window on restore. Fresh replacement records re-arm required LSP diagnostics. A restored or interrupted Gate verifies the same manifest and routes repository drift to normal BUILD, artifact drift to evidence recovery, plan drift to re-approval, and invalid BUILD records to human recovery. Active persisted runs use the current state schema; legacy Gate-ready state without manifest authority is invalidated rather than trusted.
