# LeanFlow

Low-handoff AI coding workflow for [OMP](https://github.com/can1357/oh-my-pi) (oh-my-pi).

LeanFlow keeps the **Planner** and the **Builder** as the **same main session**, adds cheap on-demand **Scout** investigators, and one independent read-only **Gate** reviewer. It minimizes inter-agent context duplication by never re-reading the investigation context and by passing the gate's inputs by reference (`local://` artifacts), never pasted.

## Lifecycle

```text
/flow <task>
  ↓
PLAN  (main session = Planner; OMP native plan mode; model @plan when configured)
  - bounded read-only investigation (read/grep/glob, same session)
  - simple task → 0 scouts; complex task → 1–3 scouts in one native task batch (@smol)
  - write canonical plan to local://<slug>-plan.md
  - request approval via write xd://propose  (OMP native plan-review overlay)
  ↓
APPROVE  (user picks execution model; defaults to @default; optional compact)
  ↓
BUILD  (same main session = sole writer; model @default)
  - implement directly (inherits investigation+plan context, zero re-read)
  - run the plan's validation commands
  - write local://<slug>-diff.md (git diff) + local://<slug>-build.md (files, results, HEAD)
  ↓
GATE  (independent one-shot gate agent; model @slow; tools read/grep/glob only)
  - task({agent:"gate", outputSchema, schemaMode:"strict"})
  - reads local://<slug>-plan.md + local://<slug>-diff.md + local://<slug>-build.md
  - returns {verdict: PASS|FAIL, findings?}
  ↓
PASS → done      FAIL → main session fixes, re-validates, re-gates (max 2 gate calls)
```

## Why this reduces handoff token

Compare with a traditional multi-agent pipeline (`Architect → Dispatcher → Implementer → Reviewer`):

| Handoff | Traditional | LeanFlow |
| --- | --- | --- |
| Investigation context | Planner builds it, Main re-sends it into Implementer prompt | Main session is the investigator AND the builder — zero re-send |
| Plan | Pasted into prompts | Written once to `local://`, read by gate by reference |
| Diff | Pasted into reviewer prompt | Builder writes `local://<slug>-diff.md`; gate reads it by reference |
| Gate verdict | Long review narrative | One small JSON object; FAIL findings are short structured rows |
| Preflight | Fixed, always runs | None — planner decides scout count from complexity (0 for simple) |

The only *mandatory* spawn is the gate (one-shot, read-only, tiny structured output). Scouts are optional (0–3, max 3 per run) and return only a short file/symbol/test/unknown list. The main session never re-reads its own investigation — it is both the investigator and the builder.

## Why the Planner is the main session, not a pipeline node

A separate Planner agent forces a handoff: the planner's investigation context must be summarized and re-sent to whoever builds. For the common case — a bounded bug fix or feature — the planner and the builder are the same mind. Keeping them in one session means the implementation inherits the full investigation for free. The planner can still delegate *location* (not design) to cheap scouts when the task is complex.

## Why there is no fixed preflight

A fixed preflight (always-spawn investigator) taxes simple tasks with the cost of complex ones. The planner, having read the task, is the best judge of investigation depth: a one-file comment change needs zero scouts; a cross-module refactor needs focused parallel scouts. Dynamic depth keeps the average handoff low without capping the ceiling. Max 3 scouts total per run, spawned in one native task batch.

## Why the Main Builder is not an independent agent

An independent Implementer agent must re-read the code the planner already read, and re-receive the plan the planner already wrote. That is the single largest handoff in a traditional pipeline. LeanFlow's main session implements directly after approval — it already holds the plan and the investigation. The single-writer principle is preserved (only the main session edits; scouts and gate have no `edit`/`write`/`bash`); independence is provided by the Gate, not by splitting the builder.

## Why the Gate must be independent

The one handoff worth paying for is a fresh pair of eyes that did not write the code. The gate reads the approved plan, the diff artifact, and the validation results — by reference — and returns PASS or structured FAIL. Its tool set is `read`/`grep`/`glob` only (enforced by frontmatter, not just prompt), so it cannot run git, tests, or any command, and cannot regress the tree. Its fresh context means it is not anchored to the planner's assumptions. This is the irreducible minimum for real review independence.

## How to swap models (no vendor lock-in)

LeanFlow uses OMP native model-role aliases. Bind concrete models in **one place** — `~/.omp/agent/config.yml` (user) or `.omp/config.yml` (project):

```yaml
modelRoles:
  default: <coding/implementation model>      # main session BUILD
  plan:    <high-quality architecture model>   # PLAN phase (optional)
  smol:    <cheap investigation model>        # scouts
  slow:    <independent reviewer model>        # gate
```

`@plan` / `@smol` / `@slow` / `@default` are OMP native model-role aliases (from the `ModelRole` enum). Agents reference them in frontmatter (`model: "@smol"`). Swap concrete models in `config.yml` only — no agent or command edits needed.

- `@plan` is optional. If `modelRoles.plan` is unset, OMP native plan mode stays on the current model.
- `@smol` / `@slow` unset → OMP falls back to the `default` model. `/flow` checks role bindings at startup and warns once if any role collapses to `default` (scouts stop being cheap, gate loses model diversity).
- **No manual `/model` switch needed**: OMP native plan-mode approval lets the user pick the execution model (defaults to `@default`) at approval time, and plan mode auto-switches to `@plan` on entry and restores the pre-plan model on exit.

## The gate loop (max 2 gate calls)

After BUILD, the main session spawns the gate. On `FAIL`, the main session reads the blocking findings, fixes them in the same session, re-runs validation, updates the diff/build artifacts, and calls the gate again. Maximum **2 gate calls** per run (count calls, not repairs). On the 2nd `FAIL`, the main session reports the last blocking findings and stops — it does not commit and does not spawn a new builder. Blocking categories: `correctness`, `validation_failure`, `plan_deviation`, `missing_change`, `regression_risk`. Non-blocking: `style`, `naming` (never drive a FAIL).

## Large changes

If the plan touches more than ~8 files or the diff exceeds a few thousand lines, split into phases and gate each phase independently rather than one monolithic gate.

## Install

```bash
# dry-run (user scope, symlink mode)
python3 scripts/install_leanflow.py --scope user --dry-run

# apply
python3 scripts/install_leanflow.py --scope user --apply

# copy mode (does not require the source package to persist)
python3 scripts/install_leanflow.py --scope user --mode copy --apply

# install into a specific project
python3 scripts/install_leanflow.py --scope project --project-root /path/to/repo --apply

# uninstall
python3 scripts/install_leanflow.py --scope user --uninstall --dry-run
python3 scripts/install_leanflow.py --scope user --uninstall --apply
```

Installed files (user scope → `~/.omp/agent/`; project scope → `<repo>/.omp/`):

- `commands/flow.md` — the `/flow` slash command
- `agents/scout.md` — the read-only investigator (`@smol`, blocking, tools: read/grep/glob)
- `agents/gate.md` — the independent reviewer (`@slow`, blocking, tools: read/grep/glob)
- `skills/leanflow/SKILL.md` — the workflow rationale + config

## Usage

In a target repo, start `omp` and run:

```text
/flow <task>
```

For example:

```text
/flow Fix the off-by-one in the pagination cursor decoder
```

The main session enters plan mode, investigates, writes the plan, requests approval via `xd://propose`. After you approve (and pick the execution model), the same session implements, validates, writes the diff/build artifacts, spawns the gate, and reports PASS or the final FAIL findings.

## Compatibility

OMP major 17 (verified on 17.1.3). Uses: `.omp/commands/*.md` markdown slash commands, custom agents (`agents/*.md` frontmatter `name`/`tools`/`model`/`blocking`), native `task({agent,outputSchema,schemaMode})` tool, `local://` artifacts, `xd://propose` plan approval, native `ModelRole` enum + `@` aliases, native plan mode (auto model switch + approval overlay).