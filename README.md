# LeanFlow

Low-handoff AI coding workflow for OMP (oh-my-pi).

LeanFlow keeps PLAN and BUILD in the same main session, adds on-demand Scout
investigators, and uses an independent read-only Gate reviewer. The normal path
uses one Gate call; after one repair, a second is the limit. Same-session BUILD
avoids cross-agent investigation re-send, while Gate inputs travel by bounded
`local://` evidence artifacts rather than pasted prompts. After compact, the
Builder re-reads the decision-complete canonical plan; raw investigation context
is not guaranteed.

## Install

```bash
python3 scripts/install_leanflow.py --scope user --dry-run
python3 scripts/install_leanflow.py --scope user --apply
```

See docs/leanflow.md for the workflow lifecycle and configuration.

