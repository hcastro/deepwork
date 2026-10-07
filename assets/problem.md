# Problem

<!-- Filled with the human before any spend. Frozen by its sha256, which args.json and confirm.md record. Leave technique hints out. -->

## Mode
<!-- research | investigation | implementation -->

## Goal, question or symptom

## Context to read first
<!-- Research: save each cited source under <run>/sources/ with its locator. -->

## Allowed assumptions

## Limits on the solution

## Out of scope

## Commands
<!-- setup (checkers and runners run it first in each fresh worktree), then each quick or slow command with its expected run time. -->

## Slow-check time limit
<!-- Minutes one slow command may take. A check that needs longer is reported as not run, with the arithmetic. -->

## Rates
<!-- Investigation with rare or noisy failures: stated rates, the base rate measured on the test machine, failure counts in six or more equal windows. -->

## Reviewer
<!-- Who reviews, how many minutes they have, what they can run locally. -->

## Stop-and-ask questions

## Fallback targets
<!-- Weaker targets, strongest first, each naming the criterion IDs it keeps. -->

## Criteria and approaches

<!--
criteria: one per acceptance criterion.
  id          stable ID such as M1, S1, X1
  tier        must | should | stretch (only must criteria block acceptance)
  kind        check (a command decides it) | judgment (a one-line judgment)
  slow        true when it runs through the runner
  command     the command, or null for a judgment
  cannot_fail true when the fail-first check showed it cannot fail; the run refuses to start
  statement   what it means in one line
approaches: starting approaches, each a claim a test could prove wrong.
  kind        establish | disprove (a disproof hunt)
  disproves   for disprove, the approach ID it would rule out, or null
  criteria    criterion IDs in scope, or [] for every must criterion
  source      where the idea came from (in investigation, the sweep pass)
`deepwork-host.mjs args` reads this block into args.json.
-->

```json
{
  "criteria": [
    { "id": "M1", "tier": "must", "kind": "check", "slow": false, "command": "", "cannot_fail": false, "statement": "" }
  ],
  "approaches": [
    { "id": "A1", "kind": "establish", "disproves": null, "claim": "", "criteria": [], "source": "" }
  ]
}
```
