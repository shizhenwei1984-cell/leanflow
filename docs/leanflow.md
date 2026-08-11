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
| Gate | Independent final plan/diff/validation verification; PASS/FAIL/structured BLOCKED | One Scout only for an unavailable approved-plan correctness or compatibility fact |

There are no reviewer, audit, validator, planner, implementer, developer, coder, or builder subagents.

## Extension Control Layer

The LeanFlow extension (`extensions/leanflow/`) provides:

- **State machine** — tracks `idle → planning → awaiting_approval → building → gating → finalizing → idle`, persists it via session entries, and measures Main Session provider usage, response count, and elapsed time. Active entries are state v9; a Gate-ready or successful finalizing entry requires a v2 finalized snapshot whose nonce, run, plan, contract, and round all match state.
- **Durable approval identity** — binds the approved plan's opaque run ID and SHA-256 content digest to extension-owned `local://.leanflow/runs/<runId>.json` state plus the fixed-length `local://.leanflow/active/<sha256(slug)>.json` pointer; recovery checks that hash key first and falls back read-only to legacy percent-encoded pointer names, while terminal, cancelled, invalidated, expired, malformed, or ambiguously orphaned markers cannot recover
- **Tool guard** — fails closed before approval, while the initial LSP probe is pending, and until `leanflow_capture_baseline` freezes HEAD/status; normalized Hashline, `local:/`, `local://`, and absolute sandbox targets resolve to filesystem identity; Main remains the sole source writer
- **Mechanical evidence** — BUILD record v3 is keyed by immutable `(runId, planSlug, planDigest, approvedValidationDigest, round)` identity. Each current observation also carries a nonempty operation ID and the same run/round/plan/contract tuple; v1/v2 records migrate while preserving observations as history, but missing, partial, or foreign provenance never authorizes a required validation. Approved commands run only through `leanflow_run_validation({ validationId })` and capture repository fingerprints before/after.
- **Atomic Gate provenance** — `leanflow_finalize_artifacts({})` requires current passing observations for every required validation, writes and rereads the three artifacts plus manifest, then persists a nonce-bound candidate state before setting it live. The manifest binds run/plan/contract identity, explicit BUILD round, BUILD-record digest, three artifact digests, repository fingerprint, and semantic validation-state digest.
- **Gate readiness and typed recovery** — treats `writtenArtifacts` as advisory only; dispatch and settlement reread the durable manifest plus every bound input, classify plan, contract, repository, artifact, record, lease, and transport failures separately, and route them to re-approval, ordinary BUILD, evidence-only re-finalization, human checkpoint recovery, or unchanged operational redispatch as appropriate. Direct artifact or internal-record writes are blocked.
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

After approval, the same Main Session becomes Builder. For source plans it first runs the required LSP diagnostics probe, then calls `leanflow_capture_baseline({})`; documentation/resource-only plans skip only the probe. Baseline output lists each immutable approved validation ID. Main implements the plan, calls `leanflow_run_validation({ validationId })` for every required ID, then calls `leanflow_finalize_artifacts({})`. The extension generates and verifies `local://<slug>-build.md`, `local://<slug>-diff.md`, and `local://<slug>-evidence.md`, then atomically persists the finalized Gate manifest; Main cannot write these artifacts or internal records directly. A repair keeps the original baseline but advances `currentBuildRound`, clears prior observations, restores any required LSP probe for a fresh record, reruns validation, and finalizes a new manifest.

### GATE

One independent Gate reads the canonical plan, final diff, build record, and runtime evidence by reference. Gate has no shell access; all runtime facts come from the extension-generated evidence artifact. Its strict verdict schema is owned by `agents/gate.md`, and callers send one canonical batch item without `outputSchema`.
- PASS moves to `finalizing`; the compact context remains active through the terminal response, then the run becomes idle.
- First valid FAIL is repaired by Main in a new explicit BUILD round with fresh validation observations and a new finalized manifest, then one Gate retry is allowed.
- A Gate operational or transport error preserves the exact finalized manifest and returns to BUILD for unchanged-manifest redispatch only; source writes, validation reruns, and re-finalization are forbidden. After four consecutive operational errors, LeanFlow pauses in `awaiting_human`.
- `BLOCKED` carries a structured reason code and affected approved validation IDs without consuming a verdict attempt. LeanFlow returns to BUILD to run only those IDs and re-finalize without source changes. A Gate dispatch attempted without a newly passed affected ID whose normalized output digest or repository fingerprint differs from its BLOCKED boundary pauses in `awaiting_human`; a mechanically identical rerun and arbitrary Bash/LSP observations are not semantic progress.

## Recovery and persisted state

Active runs persist state v9 and complete compact operation identity: explicit `currentBuildRound`, Gate/LSP/repair leases, approved validation contract and digest, finalized manifest, operational retry snapshot, and structured BLOCKED recovery state. Restore normalizes from `defaultState` and immediately persists any migration/reconciliation fingerprint change. A legacy Gate-ready or successful-finalizing state is accepted only when its v2 finalized snapshot and transactional nonce match the run, plan, contract, and round. If that authority still binds a v1/v2 BUILD record, restore first verifies the old checkpoint read-only, persists a non-authoritative evidence-recovery state, and only then rewrites the record to v3; this ordering is restart-safe. Re-finalization preserves the legacy-pass recovery action across a crash until the stored second verdict can finalize without consuming a third Gate call.

Every asynchronous control callback holds one immutable `ControlOperationIdentity`: operation ID, session ID, run ID, activation epoch, captured phase, plan digest, optional artifact identity, and creation time. The pending registry maps a transport `toolCallId` only to that authority; result handling first proves that the authority still matches the active session, run, epoch, phase, and plan/artifact revision. Activation replacement invalidates the registry, aborts validation processes, and makes stale callbacks and staged writes inert. BUILD-record transactions remain FIFO by `session/run/round/epoch`; repair-lease replay has a separate FIFO keyed by `session/run/from-round/to-round/transaction-ID`, rechecks authority immediately after acquisition, and therefore makes duplicate replay idempotent without blocking independent runs.

The repository fingerprint combines HEAD, `git diff --binary HEAD`, and sorted NUL-delimited untracked entries. Regular files bind path, `file` type, executable mode, and byte-content SHA-256; symlinks bind path, `symlink` type, and link target. Paths that escape the repository and unsupported special file types fail closed.

Repair setup is a two-checkpoint transaction. The repair lease is persisted before the BUILD record advances. Restore handles both crash windows—lease written with the old record, or new record written with the lease still pending—then synchronizes `currentBuildRound`, `gateAttempt`, baseline state, and required LSP applicability. A freshly reconstructed record clears mutation state and re-arms a required durable LSP probe before Baseline or source mutation.

Gate settlement and session interruption both verify the durable manifest and every bound input before the typed recovery router acts: unchanged transport failure becomes operational redispatch; repository drift returns to normal BUILD; artifact drift returns to evidence-only re-finalization; plan/contract drift requires re-approval; and invalid record or lease identity pauses for explicit human recovery. Candidate state publication is nonce-bound and reread before becoming live authority. Artifact writes fsync the temporary file and atomically rename it; LeanFlow attempts parent-directory fsync where supported, but that is best effort (skipped on Windows and tolerated as unsupported) and does **not** claim full power-loss durability.

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
extensions/leanflow/          (directory: index.ts, state.ts, machine.ts, provenance.ts, validation.ts, evidence.ts, guard.ts, handoff.ts, context.ts, stats.ts)
```

Use `python3 scripts/install_leanflow.py --scope user --apply` to install them under the user OMP agent directory. The default is symlink mode on POSIX and copy mode on Windows.

### Upgrading from v1

If you previously installed LeanFlow v1 (single `leanflow-bootstrap.ts`), uninstall first:

```bash
python3 scripts/install_leanflow.py --scope user --uninstall --apply
python3 scripts/install_leanflow.py --scope user --apply
```
