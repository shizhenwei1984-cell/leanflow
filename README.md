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

The current persisted formats are state v7 and BUILD evidence v3. A BUILD operation is immutable at `(sessionId, branchId?, runId, planSlug, planDigest, approvedValidationDigest, round, activationEpoch, operationId)`. BUILD-record mutations use a FIFO keyed by session/run/round/activation epoch. Changing activation aborts in-flight validation processes and causes stale async results or staged publications to be discarded rather than made live.

The finalized manifest binds the run ID, plan and approved-validation digests, explicit BUILD round, BUILD-record digest, all three artifact digests, repository fingerprint, semantic validation states, and a transactional nonce. Finalization publishes a complete candidate state first and exposes it as live authority only after the nonce-bound candidate is durable and reread. `writtenArtifacts` is display-only and never grants Gate authority. Evidence v1/v2 records migrate to v3 while retaining observations as history; only an observation with an exact nonempty operation ID plus matching run, round, plan digest, and approved-validation digest can authorize a current validation.

Repository fingerprints cover HEAD, the binary tracked diff, and sorted untracked entries. Each untracked regular file contributes path, type, executable mode, and content digest; each symlink contributes path, type, and link target. Unsupported special files or paths resolving outside the repository fail closed.

Repair setup is a persisted checkpoint transaction: LeanFlow records the repair lease before advancing the BUILD record, then reconciles either crash window on restore. Fresh replacement records re-arm required LSP diagnostics. The typed recovery router returns repository drift to ordinary BUILD, artifact drift to evidence recovery, plan or contract drift to re-approval, invalid records or leases to explicit human recovery, and unchanged transport failure to operational redispatch. Legacy Gate-ready/finalizing state without matching v2 nonce authority is never dispatched or completed. When matching legacy authority still binds a v1/v2 BUILD record, restore verifies it read-only, durably revokes the old authority, then rewrites the record as v3 for re-finalization; an interrupted Gate is redispatched, while an already-settled PASS resumes finalization without consuming another verdict.

Artifact files are written to a synced temporary file and atomically renamed; LeanFlow then attempts a parent-directory fsync where the platform supports it. This provides process/session crash recovery and best-effort filesystem ordering, **not a claim of full power-loss durability**: parent-directory fsync is skipped on Windows and tolerated when the platform reports it unsupported.
