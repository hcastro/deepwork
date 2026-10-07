# Running deepwork

The runbook for every run above solo. `workflows/deepwork.js` is the one implementation of the loop, and this file says what it does and what the session does around it. Where the two disagree, the script decides; `evals/fixtures.json` tests each rule.

## Run folder

Put the run folder outside every git repository, for example `~/deepwork-runs/<topic>/<id>/`. Worktrees go beside the main checkout at `<parent>/<repo>.worktrees/<name>`, never inside a repository. Use absolute paths everywhere.

The sweep output is the saved notes of the investigation's read-only hypothesis passes, described under Frame. Probes are one-time tests, listed in `runtimes.md`, that show this machine's runtime handles worktrees, named refs and output folders the way the script expects.

```
problem.md     the problem statement, frozen by its sha256
args.json      written by `deepwork-host.mjs args`, with that hash
confirm.md     the spend confirmation
pre-run.md     results of the pre-run checks and probes
brief.md       optional background workers read; in investigation, the sweep output
sources/       research only: saved copies of cited sources
deepwork.js    only when the run edited the prompts: the copy it launched
state.json     the official state, written only from the script's results
ledger.md      readable view of state.json, with the process warnings
rounds/rN/     plan.json, <cid>.attempt.json, <cid>.run.json, <cid>.check<k>.json, compare.json, review.json, out/<cid>/
report.md      the deliverable
```

`<cid>` is the candidate ID, such as `C2.1` (round 2, assignment 1). `out/<cid>/` holds the runner's saved command output. Every agent reads state from disk when it starts, so a switch between runtimes at a round boundary loses nothing.

## Frame

Fill `assets/problem.md` with the human. Leave technique hints out, so workers choose the method.

Starting approaches are claims a test could prove wrong, each with a stable ID. An approach is one candidate answer, root-cause hypothesis or implementation plan. Use `kind: "disprove"` for a disproof hunt, an approach that tries to rule another one out, and name its target in `disproves`.

Fallback targets are weaker goals in `problem.md`, strongest first. The report names the strongest one the result met.

Split a change too large for one worker into parts. Run each part as its own deepwork run, then run a final check on the merged branch.

Investigation runs the hypothesis sweep before a level is chosen. Tell the human in one line, then run up to three read-only passes, each over one source: code, logs or metrics, upstream issues or docs. Print each prompt with `deepwork-host.mjs prompt sweep --run <run> --mode investigation --source code|logs|upstream`. Your own first guess does not count as a pass. Save the outputs together as `brief.md`, count the distinct live hypotheses, and pass the number of passes as `--framing-calls`. They count against the run's ceiling.

Research saves a copy of every cited source under `sources/` with its locator, so checkers without network can reopen quotes.

Freeze `problem.md`. `deepwork-host.mjs args` records its sha256 in `args.json`, and `confirm.md` quotes it. Only the human edits the file, and any edit needs a new `args` and a new confirmation. The host and pair by hand refuse to run when the file no longer matches.

## Pre-run checks

Record each result in `pre-run.md`.

- The setup command and every listed command start.
- Fail-first check. Every must criterion with a command fails on a known-bad version: the pre-change code, or a copy with one planted bug. When a check cannot fail, the run does not start. Build a check that can fail as its own pair task, merge it into the base branch, update `problem.md`, and confirm again. The script refuses a must criterion marked `cannot_fail`.
- Rate sanity check, when the symptom is a rate. Compare the stated numbers with each other, for example a per-request fraction times the request rate against a stated time between failures. Then measure the base rate on the test machine and use the measured value.
- The probes in `runtimes.md` that this machine has not passed yet.

## Levels

Solo fits when all of these hold: one plausible approach; a command decides every must criterion; no must criterion is judged by a measured failure rate or a noisy measurement; the change leaves tests, test config and warning filters alone; a reviewer can read the whole change in one sitting; and in investigation the sweep found one live hypothesis. Do the work yourself with the fail-first check in place.

Move up only on evidence, named in one sentence:

- solo to pair: any solo condition fails, or a solo result later proved wrong.
- pair to team: a checker objection of class wrong-approach; two or more live approaches that no quick check tells apart; testing the hypotheses one at a time would take more than 12 calls, or more minutes than the slow-check time limit; pair hit its ceiling without a pass.
- team to full: the team run ended without a confirmed candidate, and either one objection key appears in two or more attempts or more than two rounds are needed. Resume the team state at full after a new confirmation.

An objection key is a short stable name a checker gives an obstacle, such as `M2-pool-drain`. Its class is one of wrong-approach, missed-case, weak-evidence or unclear-problem.

Skipping straight to team needs two numbers at framing time: the sweep count and the cost of one test. Go back to framing for an unclear request. Decline full when the reviewer line names nobody who can judge the output.

## Spend confirmation

Team and full only. Run `deepwork-host.mjs estimate --mode M --level L [--host] [--framing-calls N]`, fill `assets/confirm.md`, show it and wait. Quote the call ceiling first, framing calls included. Nothing launches before the yes, probe launches included. Resuming at a higher level needs a new confirmation.

## One round

1. **Work.** One worker per assignment, each in its own worktree. An assignment is one worker on one approach in one round. The worker commits locally, points the named ref `refs/deepwork/<run>/<cid>` at its commit so the commit outlives the worktree, runs only quick checks, and lists up to three slow commands it needs.
2. **Run.** One runner per candidate runs those slow commands and the slow acceptance checks in a scratch worktree, one runner at a time across the round. A scratch worktree is a fresh git worktree at the candidate commit, used by one agent and then removed. There is no runner when nothing slow is asked for, or when a solution worker's own quick checks failed.
3. **Check.** Each checker works in its own scratch worktree, reruns the quick checks, and judges slow criteria from the runner output. Break attempts and disproof hunts get checkers too.
4. **Compare**, at team and full. The comparison checker reads every candidate of the round side by side, or a lone candidate against the best earlier ones, and returns one pass or block row per candidate.
5. **Process check.** The script lists objection keys that appear in two or more attempts and puts them in the next prompts. At full, the process reviewer writes warnings into the ledger, and a warning that cites fewer than two known objection keys is dropped. Workers and checkers apply every warning.
6. **Save.** `state.json`, `ledger.md`, the plan and every agent result, written after the round so no checker reads another's verdict while it works. In Claude Code a file writer agent saves and reports byte sizes. A mismatch gets one retry from the spare calls, 2 calls held back for that.

## Planner

1. A recorded stop ends the run.
2. When a candidate passes at team or full, one break round runs before the stop: one break attempt per passed candidate, the selected one first, and in investigation a disproof hunt for each other open hypothesis, at most 3 assignments. Hypotheses left out become open gaps in the report. The break round runs even past the round limit. It uses up a round, so no repair round follows it once the limit is reached.
3. After the break round, or at pair, a passed or confirmed candidate stops the run as accepted.
4. Past the round limit, stop.
5. Set an approach aside after 3 attempts without a pass, or after 2 crashes, counted since the last launch.
6. Each open approach gets one assignment: disproof for a disproof hunt, repair when it has a usable attempt, new otherwise. A repair starts from the approach's best attempt (most must criteria met, then most criteria, then latest) at its commit. Its worker reads that attempt's file, check files and runner output, plus the counterexample if a break attempt broke it.
7. Order: disproof hunts, then repairs that met a must criterion, then untried approaches, then repairs that met none. The level's assignment count cuts the list.
8. Nothing left to assign: stop as exhausted.

Approaches that workers propose are never scheduled by the loop. They go to Needs you, and the human adds the ones worth trying.

## Acceptance

Void: a checker or runner result whose `head_sha` differs from the candidate commit or whose `dirty` is true. Under the host, git reports those two fields after the call. In Claude Code the agent reports them.

A candidate passes when all of these hold:

- every checker the level requires returned a result that is not void, and every one says pass;
- every must criterion is met by every checker, and every slow must criterion also has a `ran` row from a runner result that is not void;
- at team and full, the comparison checker returned a pass row for this candidate;
- its approach was not excluded by a disproof hunt.

Should and stretch criteria are recorded and never block. A crashed, skipped, refused or schema-invalid agent, a void result and a missing row all count as failures.

Break round outcome. A counterexample every checker accepts breaks the candidate, and its approach reopens. A counterexample every checker rejects confirms it. An attempt that found no counterexample confirms it only when its `looked` list is not empty and every checker accepts that search. Anything else leaves it passed but not confirmed.

Exclusion: a disproof counts only when every checker reran its control run in a scratch worktree and saw the check catch the effect caused on purpose. A rejected or stalled attempt never excludes anything.

## Ledger, stops and resume

The ledger holds the approaches with their status, the attempt log (status, criteria met, objection keys, commit, where break attempts looked), the excluded approaches with their control runs, recurring objections, process warnings and call usage.

Stops: accepted, rounds, exhausted, a worker's `question_for_human`, and unclear-problem once two different attempts raise an objection of that class. A single unclear-problem objection goes to Needs you.

Resume with `deepwork-host.mjs args ... --resume`, which puts `state.json` into `args.json` as `prior`, and confirm again when the level rises. The old stop, the unclear-problem count and Needs you clear. The call count starts at 0 under the new ceiling, and the sweep is not charged again. Earlier calls stay on record, round numbers continue, and the round limit and set-aside counts start from the resume. When `problem.md` changed, the new criteria apply, approaches with new IDs join, and every passed candidate goes back through the checkers as a repair. To reopen an approach or force a disproof hunt, add it to `problem.md` under a new ID. Within one Claude Code session you can also relaunch with `resumeFromRunId`, the same `scriptPath` and identical args.

## Report

About 800 words, in this order:

1. **Result**, at most three sentences: the answer, cause or change; confirmed or only passed; the strongest fallback target met.
2. **Needs you**: questions, unclear-problem objections, untried proposals, decisions only the human can make.
3. **Ten-minute check**: at most five commands with expected output.
4. **Criteria**: one row per criterion with met, unmet or not run, each marked RAN (a command ran) or READ (judged by reading).
5. **Excluded alternatives** with their control runs.
6. **Open gaps**: every hypothesis neither excluded nor accepted, with where the run looked.
7. **What this page lacks**: what nobody checked, and that every checker shares one model family.
8. **Audit**, appended by the report auditor after it reruns the ten-minute check.

Style: short paragraphs, plain words, identifiers in backticks, numbers with units, and paths to output files.

## By hand

Features cut on purpose, and what replaces each one when you need it:

- Checker sanity check (a planted-bug candidate sent to the checkers): run the checker prompt once against the known-bad commit from the fail-first step and confirm it fails.
- Second model family: send the checker prompt for the selected commit through the other vendor's CLI.
- A lower call ceiling than the level's: pick the lower level.
- A background brief agent: write `brief.md` during framing when workers need shared background.

## Where this comes from and its limits

The loop adapts the multi-agent method of the Cogentic paper, written for hard research problems. Four of its parts were cut or thinned:

- A summary written for each worker: replaced by one shared ledger, since a summary per worker costs a call each and nothing measured its value.
- Sending a literature reviewer back in when attempts stall: cut; the human adds sources to `problem.md` and resumes.
- Rechecking facts in isolation: cut with the checked-facts list, which acceptance never used.
- A comparator agent that ranks finalists: replaced by a fixed ranking in the script, so no model picks the winner.

The paper reports no measured checker error rates, so final human review stays required. Every checker shares the worker's model family and can share its blind spots. The call ceilings are deepwork's choices and are not calibrated. Nothing here has run against a real model yet; see the probes in `runtimes.md`.
