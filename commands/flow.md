---
description: Start LeanFlow: native plan mode, same-session build, and one independent final Gate.
---

You are running **LeanFlow** for:

{{ARGUMENTS}}

## LEANFLOW ROLE POLICY

Only three roles exist:

1. Planner
2. Scout
3. Gate

Planner and Builder are the same Main Session. There are no intermediate reviewers or audit agents.

Acceptance criteria are a checklist, not a reason to spawn agents.

Runtime questions are handled by:
- Planner reasoning
- Scout factual investigation

Do not spawn:
- reviewers
- auditors
- validators
- planners
- implementers

If additional confidence is needed:
improve the plan or verification section.
Do not create another agent.

The canonical Scout agent name is `scout` (`@smol`). Gate is the only independent reviewer (`@slow`).

## PLAN

1. Enter native plan mode now. You are the Planner (`@plan`).
2. Understand the request and inspect repository files directly when sufficient.
3. Scout is optional: use zero calls for simple work and at most three focused calls for complex work. Every Scout assignment asks one concrete factual question. Use repository investigation for code, callers, and tests; use external investigation only for a load-bearing current fact.

```text
task({
  context: "LeanFlow factual investigation for: {{ARGUMENTS}}",
  tasks: [
    { agent: "scout", name: "scout-code", task: "Find the exact entry point, callers, and existing tests for <focused behavior>.", schemaMode: "strict" }
  ]
})
```

4. Planner owns completeness, runtime feasibility, acceptance coverage, and implementation feasibility. Convert Scout facts into decisions; do not call a reviewer or audit role.
5. Write the decision-complete canonical plan to `local://<slug>-plan.md`. Include exact paths/symbols, ordered implementation steps, edge cases, and executable verification.
6. Request approval only by writing `<slug>` to `xd://propose`.

## BUILD

After approval, native plan mode exits and the same Main Session becomes Builder (`@default`). Main is the only writer.

1. Re-read the approved canonical plan.
2. Record Baseline HEAD and baseline status in `local://<slug>-build.md` before edits. Preserve existing user work.
3. Implement the approved plan; do not create an implementer, developer, coder, or builder subagent.
4. Run every planned validation command. Record command, exit code, complete output reference, and result in `build.md`.
5. Write the complete final diff to `local://<slug>-diff.md`; record final status, changed paths, and final HEAD in `build.md`.
6. Collect runtime evidence for Gate. Run every command the plan's Verification section requires (git diff, docker inspect, compose ps, psql queries, image version checks, etc.) and write the complete output of each into `local://<slug>-evidence.md` with a heading per command. Gate has no shell access; this file is its only runtime evidence source.

## GATE

Spawn one independent Gate after evidence is complete. Gate reads references; do not paste artifacts.

```text
task({
  agent: "gate",
  task: "Review the LeanFlow run whose plan is local://<slug>-plan.md, diff is local://<slug>-diff.md, build record is local://<slug>-build.md, and runtime evidence is local://<slug>-evidence.md. Read all four artifacts and return the verdict object.",
  outputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["PASS", "FAIL"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["correctness", "validation_failure", "plan_deviation", "missing_change", "regression_risk", "style", "naming"] },
            severity: { type: "string", enum: ["blocking", "nonblocking"] },
            file: { type: "string" },
            location: { type: "string" },
            issue: { type: "string" },
            required_fix: { type: "string" }
          },
          required: ["category", "severity", "file", "location", "issue", "required_fix"],
          additionalProperties: false
        }
      }
    },
    required: ["verdict", "findings"],
    additionalProperties: false
  },
  schemaMode: "strict"
})
```

- `PASS`: finish. Do not create another reviewer or audit.
- First `FAIL`: Main repairs, re-runs required validation, refreshes diff/build/evidence artifacts, then calls Gate once more.
- Second `FAIL`: report Gate's blocking findings. Do not create any further agents.

## Limits

- Normal complex run: at most **3 Scout + 1 Gate**.
- Worst case after repair: at most **3 Scout + 2 Gate**.
- Gate may request one Scout fact only when an approved-plan correctness or compatibility fact cannot be established from repository, diff, or validation evidence. That Scout never reviews or returns a verdict.
- No task name or agent role may contain `Audit`, `Review`, `Reviewer`, `FinalAudit`, `Reaudit`, `Coverage`, `RuntimeAudit`, or `ApprovalAudit`.
