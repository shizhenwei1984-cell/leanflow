# LeanFlow

Low-handoff AI coding workflow for OMP (oh-my-pi).

LeanFlow keeps PLAN and BUILD in the same main session, adds cheap on-demand
Scout investigators, and one independent read-only Gate reviewer. It minimizes
inter-agent context duplication by never re-reading the investigation context
and by passing gate inputs by reference (`local://`, `git diff`), never pasted.

## Install

```bash
python3 scripts/install_leanflow.py --scope user --dry-run
python3 scripts/install_leanflow.py --scope user --apply
```

See docs/leanflow.md for the workflow lifecycle and configuration.

