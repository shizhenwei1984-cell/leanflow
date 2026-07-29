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
scripts/install_leanflow.py   Installer (symlink/copy, user/project scope)
docs/leanflow.md              Detailed documentation
tests/                        Test suite
```
