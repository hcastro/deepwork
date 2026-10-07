---
name: deepwork
description: Multi-agent loop for hard software problems. Modes are research (answer a question with sources), investigation (find a root cause and rule out the others) and implementation (build a change against criteria fixed up front). Use it when a first attempt failed, several hypotheses compete, a failure is rare or hard to pin down, the tests are weak where the risk sits, or the user wants independent checking before accepting. It starts with one agent, asks once before spending on more, and runs in Claude Code or Codex.
---

# deepwork

Use it when one agent with a failing test is not enough. It runs several agents on separate approaches and has fresh agents check each result. Each round's state is saved to the run folder, so a crash or a context reset loses nothing.

Done means a `report.md` that a reviewer who never saw the run can check in ten minutes. Every claim in it points to an entry in the ledger, the run's record on disk.

## Rules

1. Gather context before framing. The session writes `<run>/context.md` from the repo's instruction files and runbooks, the team knowledge base, the tickets and pages, prior work and the data sources. Every agent reads it first, and the run does not start without it.
2. Fix the acceptance criteria with the human before any work starts. They live in `problem.md`, and only the human changes them. A must criterion blocks acceptance; should and stretch criteria are only recorded.
3. Fail-first check: every must criterion with a command has to fail on a known-bad version (the old code, or a copy with one planted bug). A check that cannot fail blocks the run.
4. Checkers are blind. A checker is a fresh agent that sees a candidate ID such as `C2.1`, never who wrote it, and never grades its own output.
5. A crashed, skipped or void check counts as a failure. Void means the checker's worktree moved off the candidate commit or was left with changes.
6. Before team or full, show one spend confirmation and wait for the yes. Pair and the investigation sweep (up to 3 read-only calls) need a one-line notice.
7. The orchestrator script decides what runs next and whether a candidate passed, by fixed rules. No model makes those calls, and the session never reads a candidate to judge it.

## Words

- Candidate: one worker's result, named `C<round>.<n>`.
- Runner: an agent that runs the slow commands for a candidate, such as load runs, benchmarks or the full suite.
- Repair: a new attempt that starts from an approach's best earlier attempt. A round tries an untried approach before a repair that met no must criterion.
- Comparison checker: one agent that reads all of a round's candidates side by side.
- Break round: after a pass, an agent looks for a case where the passed candidate fails. A candidate that survives it is confirmed.
- Process reviewer: an agent that reads the round's objections and warns about mistakes that repeat.
- Sweep: in investigation, up to 3 read-only passes over code, logs and upstream issues that list the live hypotheses before a level is picked.
- Objection of class wrong-approach: a checker's finding that the approach itself cannot meet the criteria, so repairing it will not help.
- Needs you: the report section that lists the questions, worker-proposed approaches and decisions only the human can settle.

## Levels

| Level | Shape | Max calls | Asks first | Move up when |
|---|---|---|---|---|
| solo | you and a test that can fail | none | no | a must criterion has no command or is judged by a measured failure rate; the change edits tests, test config or warning filters behind a must criterion; the change is too big to review in one sitting; a solo result turned out wrong |
| pair | 1 worker, 1 runner, 1 checker, 2 rounds | 12 | one-line notice | a checker says the approach is wrong, two or more live approaches no quick check tells apart, or pair hit its limit |
| team | up to 3 approaches, 2 rounds, comparison checker, break round | 41 | yes | team ended without a confirmed candidate and an objection repeats, or more rounds are needed |
| full | up to 4 approaches, 4 rounds, 2 checkers each, process reviewer | 100 | yes | top level |

A call is one agent run. Each move up names one piece of evidence: a checker objection of class wrong-approach, a count from the attempt log, the number of live hypotheses, or a figure from the pre-run checks. Send an unclear request back to framing. Decline full when nobody named in `problem.md` can judge the output.

## Steps

1. **Gather context.** Fill `assets/context.md` as `<run>/context.md`, following "Gather context" in `references/run.md`.
2. **Frame.** Fill `assets/problem.md` with the human, from the context pack. In investigation, run the hypothesis sweep first.
3. **Pre-run checks.** Commands start, the fail-first check holds, and stated failure rates agree with each other and with a rate measured on the test machine.
4. **Pick a level** and give its reason in one sentence.
5. **Write args and confirm.** `node scripts/deepwork-host.mjs args` writes `args.json` from `problem.md`. For team or full, fill `assets/confirm.md` from `estimate` and wait.
6. **Run.** Claude Code launches the workflow file, or drives pair by hand. Codex runs the host script. Keep going between rounds without asking.
7. **Hand over.** Show the report's Needs you section first. A human review is always required.

## Files

- `references/run.md`: the runbook. Read it for every run above solo.
- `references/runtimes.md`: read the section for your runtime only.
- `references/checks.md`: the standard workers aim for and checkers apply. Agents read it when their prompt names it.
- `assets/context.md`, `assets/problem.md`, `assets/confirm.md`: templates for the context pack, the problem statement and the spend confirmation.
- `workflows/deepwork.js`: the orchestrator for both runtimes. Launch the shipped file unchanged. When a task needs different instructions, copy it to `<run>/deepwork.js`, edit only its prompt object `P`, and run `selftest --script` on the copy.
- `scripts/deepwork-host.mjs`: `args`, `estimate`, pair by hand (`prompt`, `record`), `run` through `codex exec`, and `selftest`.
- `evals/`: offline checks, a fake `codex` for dry runs, and the eval cases.
