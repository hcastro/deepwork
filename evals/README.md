# Evals

The offline checks run today with no model calls. The model evals need fixture repositories for each case; building them is the first eval task.

## Offline checks (no model calls)

```
node scripts/deepwork-host.mjs selftest          # strict schemas, worst case per level, fixtures.json, a pair-by-hand pass
node scripts/deepwork-host.mjs selftest --dry    # also the three stub dry runs below
sed 's/^export const meta/const meta/' workflows/deepwork.js > "$TMPDIR/dw.js" && node --check "$TMPDIR/dw.js"
grep -nP '\x{2014}' SKILL.md references/*.md assets/*.md evals/README.md    # em dashes: expect no output
grep -niE "\b(not|isn't|aren't) (just|only|merely)\b|rather than|instead of" SKILL.md references/*.md   # contrast constructions: review each hit
```

The selftest code lives in `selftest.mjs` and loads the orchestrator the same way the host does. `fixtures.json` names each case after the review issue it tests (`V1-16` is issue 16, counted from zero, of verifier 1 in the first review; `v2` cases come from the review of this version) or after a core rule. Add a fixture whenever a rule changes. Pass `--script <run>/deepwork.js` to check an edited copy.

At the end the selftest removes its temp repos, and it fails when a worktree stays registered or a new `deepwork-*` or `dw-dry-*` folder stays in TMPDIR. The pair-by-hand pass writes a worker attempt, a runner result and a passing check into a temp run, calls `record`, and expects `state.json`, `ledger.md` and a writer prompt that names the passed candidate.

The dry runs go through `stub-codex.mjs`, a fake `codex exec` that rejects unexpected flags, sandbox modes and config keys. Its checkers fail `C1.1` and any counterexample and pass everything else; `STUB_REJECT_ALL=1` fails every candidate. Each run uses a fresh git repository with one commit and a problem with a quick must criterion, a slow must criterion and a quick should criterion. `args.json` comes from `deepwork-host.mjs args`, so it carries the real problem hash.

| Run | Expected |
|---|---|
| team implementation, approaches A1 and A2 | status `confirmed`, stop `accepted`: C1.1 fails, C1.2 passes, the break attempt C2.1 is rejected, 11 calls of 41 |
| full investigation, `STUB_REJECT_ALL=1`, 3 framing calls | status `partial`, stop `exhausted`: both approaches set aside after three failed attempts, 35 calls of 100 |
| pair research | status `passed`, stop `accepted`: C1.1 fails with no must criterion met, so round 2 tries the untried approach A2 as C2.1, which passes; no comparison and no break round, 8 calls of 12 |

## Model evals (six cases)

Run each first as a framing eval: give the prompt to a session with the skill loaded and stop at the confirmation. It passes when `problem.md`, the level and its reason, and `confirm.md` meet the framing checks. With fixture repositories, run each case twice, once with a single agent and a test, once with deepwork at the level it picks. Grade both reports blind against the pass list, and record calls, tokens and wall-clock time.

**1. Pooled-connection race (investigation).** About 1 in 50,000 responses at 2,000 rps carry another request's body, plus some proxy 502s; nothing fails below 800 rps.
- Level: team. Reason: five or more live hypotheses from the sweep, each needing 10 to 30 minutes of load, which exceeds pair.
- Framing: the rate sanity check catches that 1 in 50,000 at 2,000 rps is one failure every 25 seconds, against a stated 10 to 30 minutes; window counts are recorded; a must criterion asks for a fast repro; the fix criterion carries the rare-failure math.
- Pass: the mechanism with anchors (a connection returned to the pool after a cancelled read); one mechanism explains both symptoms and the threshold; a fast repro that fails on base and passes on the fix; excluded alternatives with control runs; the pool-size increase named as a side factor; race-detector silence recorded as cant_tell.
- Single-agent trap: raise the pool size, see five clean minutes, declare it fixed. At one failure per 20 minutes that happens about 78% of the time with the bug present.

**2. Performance regression from a transitive dependency (investigation).** A minor framework upgrade moved 64 packages; p99 rose from 45 to 65 ms with p50 flat; one build plus benchmark takes 20 minutes.
- Level: team. Reason: several live candidates and a 20-minute cost per bisect step.
- Framing: repeated runs per state with an interval on p99; the share of the 20 ms explained is a must criterion; unbuildable states count as untested; profiles target the tail.
- Pass: the package and version pair with a bisect log; the mechanism with profile evidence; excluded candidates, the framework included; effect size and share explained; recovery options with their risks.
- Single-agent trap: read the changelog, run one benchmark per build, blame the framework.

**3. ORM major-version migration (implementation).** About 120k lines; the new version removes implicit autocommit and changes lazy loading; the suite wraps each test in a transaction.
- Level: pair once framing has built the missing checks, team on a scoped part if a checker raises a wrong-approach objection.
- Framing: the fail-first check shows the suite stays green with one commit call removed, so the query-count and transaction criteria start as `cannot_fail`; a query counter and a write-path commit audit are built and merged first as pair tasks.
- Pass: per-criterion table at the final commit; query counts before and after; identical transaction boundaries; every test edit with its class; no silenced warnings; a ten-minute check that reverts one commit call and shows the audit catching it.
- Single-agent trap: run the codemod, fix errors until green, declare done.

**4. Cross-service field addition (implementation).** Three services exchange schema-registered events; add a currency field end to end with independent deploys and safe rollback.
- Level: team. Reason: several approaches to the absent-field meaning, and an eight-state compatibility matrix too costly to try serially.
- Framing: the eight-state matrix and a replay comparison are slow checks; the fail-first check uses an old middle service that drops unknown fields; a must criterion states what an absent currency means.
- Pass: the schema change and absent-field meaning; per-service changes; the matrix results; whether the middle service keeps unknown fields and how that was confirmed; a rollout order with rollback per step.
- Single-agent trap: change all three together, test only the all-new state.

**5. Storage engine choice (research).** LSM tree or B+tree for 40,000 writes per second of small time-keyed records, 30-day expiry, 2 TB live, p99 reads under 10 ms during compaction.
- Level: team. Reason: two candidate answers plus disproof hunts for the deciding properties (key order, expiry deletes, dataset to memory ratio).
- Framing: a fallback target allows a conditional answer; benchmarks require steady state and a dataset larger than memory; the endurance arithmetic is a must criterion.
- Pass: a conditional recommendation naming the deciding properties; an evidence table with locators; amplification estimates with the endurance math; the configuration that makes it work; the reversal experiment and threshold.
- Single-agent trap: repeat the write-heavy heuristic, or run a 60-second in-memory benchmark.

**6. Does a published technique apply (research).** A learned-index paper reports big gains over B-trees; the target has 30% inserts, mixed sequential and hashed keys, continuous growth.
- Level: pair when one checkable answer is likely, team when the original and its updatable follow-ups disagree.
- Framing: one verdict per assumption of the technique against measured properties of the target; the search covers follow-up work; a fallback target allows "applies in a named variant".
- Pass: assumptions with sections and verdicts; follow-up work and its conditions; an overall verdict with a realistic gain range; the cheapest experiment on real keys.
- Single-agent trap: accept the abstract's speedup, or reject the idea for the read-only setup, without measuring the target's keys.

## Ship gate

deepwork passes at least four of six cases where the single agent fails, and it never exceeds its ceiling. Record calls, tokens and wall-clock time for each case before shipping; they are the first real figures for the ceilings.

## Earlier blockers

IDs count from zero within each earlier verifier's report. "Fixture" names the case in `fixtures.json` that pins the fix.

| ID | v2 status |
|---|---|
| V1-0 | Fixed. Resume clears the stop and restarts calls under the new ceiling. Fixtures: team resumed at full; resume after a question. |
| V1-1, V2-1, V3-6 | Fixed. Every checker, runner and the auditor gets its own scratch worktree; an exclusion needs the checker's own control run. Fixture: exclusion control run. |
| V1-2 | Fixed by sizing each level so its worst case stays at least one call under its ceiling; the selftest fails when one does not. The drop guard for lowered ceilings is cut along with the `ceilings` override. Fixture: team round 2 keeps three. |
| V1-3, V2-3, V3-2, V2-4 | Cut the automatic checker sanity check (a planted-bug candidate sent to the checkers), which cost 2 to 3 calls and about 120 lines for one data point a run. By hand: run the checker prompt against the known-bad commit from the fail-first step and confirm it fails. |
| V1-4, V3-1 | Fixed. Acceptance needs a pass row from a comparison checker that ran. Fixtures: dead comparison checker; missing row. |
| V1-5 | Fixed through the break round and open gaps. Fixtures: team break round; investigation disproof hunts. |
| V1-6, V3-4 | Fixed. A repair builds on the best attempt at its commit. Fixture: repair base. |
| V1-7, V1-11 | Fixed. A runner serves every assignment kind and pair includes it. |
| V1-8 | Fixed. Slow-check time limit; the runner reports not_run with the arithmetic. |
| V1-9, V3-5 | Cut: in-run check building stranded checks on side branches. Checks are built as pair tasks and merged into the base first. |
| V1-10 | Fixed. A must criterion marked cannot_fail refuses to start. Fixture. |
| V1-12 | Fixed. The sweep runs before any level in investigation; a rate-based must criterion forces pair at least. |
| V1-13 | Stays cut. run.md Frame tells the session to run one deepwork run per part, then a final check on the merged branch. |
| V1-14 | Fixed. `DEEPWORK_NETWORK=1`, or quotes are checked against `sources/`. |
| V1-15, V2-10, V3-3 | Cut with cross-vendor checking (unprobed, a call per candidate). By hand: run the checker prompt for the selected commit through the other vendor's CLI. |
| V1-16 | Fixed. `head_sha` and `dirty` void a result; the host reads both from git. Fixture. |
| V2-0, V3-0 | Fixed. The smoke launch is cut; the workflow launches once, after approval. |
| V2-2 | Fixed. Only must criteria gate. Fixture. |
| V2-5, V3-10 | Fixed. File-writer sizes are checked with one spare-funded retry; state comes back when unconfirmed. |
| V2-6, V2-8 | Fixed with named refs and host-made worktrees; probe rows remain in `runtimes.md`. |
| V2-7 | Fixed. Claude Code launches by `scriptPath`, so the file that passed selftest is the file that runs. |
| V2-9 | Codex pair runs through `host run` with a pair `args.json`. Claude Code pair runs by hand through `prompt` and `record`, which use the script's planner and merge. |
| V2-11, V3-11 | The first pipeline stage takes only its item, which works under either stage signature. `meta.whenToUse` and `scriptPath` are in the documented Workflow API. The rest are probe rows. |
| V3-7 | The writer reports the strongest fallback target met and the auditor checks it. Aiming the planner at fallback targets is cut. |
| V3-8 | Fixed: full fits four rounds and the reviewer runs from round 1. |
| V3-9 | Fixed. `call()` enforces the ceiling with framing calls counted; the uncounted schema retry and tiebreak call are cut. A resume does not charge the sweep again. Fixtures: worst case per level; resume at full. |
| V3-12 | Fixed. The comparison checker takes the checker stance. |
| V3-13 | Cut with the effort citation. |
| V3-14 | Prose rewritten; the grep lines above check it. |

## Review of this version

Majors from the four verifiers of v2, and what changed. The fixture names start with `v2`.

| Issue | Change |
|---|---|
| Pair by hand in Claude Code wrote no ledger and its writer prompt said nothing passed | `prompt` and `record` plan and merge with the script's own rules, write `state.json` and `ledger.md`, and build the writer prompt from state. Selftest: pair by hand. |
| Inline script launch ran untested code | Launch by `scriptPath`. |
| Checkers wrote result files into the run folder mid-round, where a parallel checker could read them | No agent writes its own result. Both runtimes save every result after the round. |
| `problem_hash` missing let a changed problem run; criteria were pasted by hand | The host and pair by hand refuse a missing or stale hash. `args` builds args.json from problem.md. |
| Repairs pushed untried hypotheses out | Untried approaches go before repairs that met no must criterion. Fixtures: v2 order. |
| Solo let edited tests and silenced warnings through | Editing tests, test config or warning filters behind a must criterion, or a change too big to review, moves solo to pair. |
| A break worker that found nothing confirmed its target unchecked | Checkers review the search, and an empty `looked` list never confirms. Fixtures: v2 break. |
| Repairs never saw the base's runner output, so a bisect could not advance | The repair prompt names the base's run file. Fixture: v2 repair context. |
| Attempt counts carried across a resume | Set-aside counts start at the resume. Fixture: v2 resume set-aside. |
| Resume after a problem change kept passed candidates and accepted at once | Passed candidates go back through the checkers as repairs. Fixture: v2 resume changed problem. |
| Resume kept the unclear-problem count | Resume clears it and Needs you. Fixture: v2 resume unclear. |
| Orchestrator and host over their size targets | Selftest moved to `selftest.mjs`. Cut: background brief agent, `ceilings` override and drop guard, worker-proposal queue (proposals go to Needs you), checked facts, `notes.md` (warnings live in the ledger), typical-call and token estimates. |
| Every agent inherits the session model | Kept on purpose. The Workflow API recommends inheriting the session model, and a pinned model name ties the skill to one account's model list. runtimes.md tells the session to run on its strongest model, and setting `MODEL` in a copy pins every agent. |
| Pair docs said the second round is a repair | The planner runs an untried approach before a repair that met no must criterion, as fixture v2 order tests. The docs and the pair dry-run name now say so. |
| Team and pair investigation had zero margin (40 of 40, 11 of 11) | Ceilings raised by one, to 41 and 12, and the selftest needs one spare call. Fixture: V3-9 checks worst case against ceiling. |
| Dry runs and host runs left temp folders and worker worktrees | The host removes its worktrees and temp folder at the end; the selftest removes its repos and checks nothing stays. |
