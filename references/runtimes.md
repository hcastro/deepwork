# Runtimes

Read your runtime's section, plus the probe table before the first team or full run on a machine. `<skill>` is the skill folder and `<run>` the run folder, both absolute.

## Claude Code

Install: copy or symlink the skill folder to `~/.claude/skills/deepwork` or `<repo>/.claude/skills/deepwork`. It loads when a request matches its description, or through `/deepwork`.

The session frames, runs the pre-run checks, shows the confirmation, launches, and talks to the human. It never reads candidates to judge them.

**Sweep.** Run up to three read-only subagents in parallel, each given the output of `node <skill>/scripts/deepwork-host.mjs prompt sweep --run <run> --mode investigation --source code|logs|upstream`.

**Pair by hand.** Pair needs no workflow. Run `node <skill>/scripts/deepwork-host.mjs args --run <run> --mode M --level pair`, then repeat these steps with `--args <run>/args.json` on each command. The host plans each round with the script's own rules.

1. `prompt worker`: give the output to a subagent in its own worktree. Save its JSON reply unchanged to the path the command prints on stderr.
2. `prompt runner`: same, in a fresh worktree. The command says when to skip the runner.
3. `prompt checker`: same, in a fresh worktree. Give the checker no hint of who wrote the attempt.
4. `record`: applies the acceptance rule and writes `state.json` and `ledger.md`. Copy its verdict and do not judge the candidate yourself. Its `next` line says whether a second round follows or the run stops.
5. After the stop, `prompt writer`: write the reply's `report_md` to `<run>/report.md`. Then `prompt auditor` for a subagent in a fresh worktree, and append its `audit_md` to the report.

A missing or malformed reply counts as a missing result. Pair stays within 8 calls plus framing.

**Team and full.**

1. Run `deepwork-host.mjs args --run <run> --mode M --level team|full [--framing-calls N]`.
2. Use the shipped `<skill>/workflows/deepwork.js`. When the task needs different prompts, copy it to `<run>/deepwork.js`, edit only `P`, and run `node <skill>/scripts/deepwork-host.mjs selftest --script <run>/deepwork.js`.
3. Fill and show the confirmation. Wait for the yes.
4. Launch with `Workflow({ scriptPath: <that file>, args: <the JSON that args printed, unchanged> })`. Launching by path makes the tested file the one that runs. Resume a stopped launch with the same `scriptPath`, the same args and `resumeFromRunId`.

Agents run on the session model, so run the session on the strongest model you have, or set `MODEL` in a copy. Workers, runners, checkers and the auditor use `isolation: 'worktree'`. Claude Code puts those worktrees under `<repo>/.claude/worktrees/` unless a `WorktreeCreate` hook places them elsewhere; install a hook that puts them at `<parent>/<repo>.worktrees/<name>` before the first run. The worktree tool removes a worktree it sees as unchanged, so workers set the named ref before returning.

**After the run.** Claude Code keeps an isolated agent's worktree once its HEAD has moved, so every worker worktree outlives the run. List the run's worktrees with `git worktree list` (their names start with the Workflow run id, `wf_<id>-`) and remove each with `git worktree remove`, without `--force`. A refusal means uncommitted work: report it and leave that worktree. Keep `refs/deepwork/<run>/` until the report is reviewed. When `state_written` is false, write the returned `state` to `<run>/state.json` and `report_md` to `<run>/report.md` yourself, since a resume reads that file. Show Needs you first. To debug an odd result, read `journal.jsonl` in the run's transcript folder.

## Codex

Install: copy or symlink the skill folder to `~/.agents/skills/deepwork` or `<repo>/.agents/skills/deepwork`, then invoke it as `$deepwork`.

The host evaluates the same orchestrator file under Node 18 or newer and turns each agent call into a fresh `codex exec`. Run it from the user's terminal after approval:

```
node <skill>/scripts/deepwork-host.mjs args --run <run> --mode investigation --level team --framing-calls 3
node <skill>/scripts/deepwork-host.mjs estimate --mode investigation --level team --host --framing-calls 3
node <skill>/scripts/deepwork-host.mjs run --args <run>/args.json [--script <run>/deepwork.js]
```

Pair runs the same way with `--level pair` in `args`. The host refuses to start when `problem.md` no longer matches the hash in `args.json`.

Sweep: `node <skill>/scripts/deepwork-host.mjs prompt sweep --run <run> --mode investigation --source logs | codex exec -s read-only -C <repo> -`.

| Role | What the host passes |
|---|---|
| worker | `git worktree add --detach <root>/w<n> <base>`, then `-s workspace-write -C <that tree> --add-dir <git common dir>`; afterwards the host records the real HEAD and sets the named ref |
| runner, checker, auditor | the same at the candidate commit, and for a runner also `--add-dir <run>/rounds/rN/out/<cid>`; afterwards the host reads HEAD and `git status --porcelain` itself, writes them into `head_sha` and `dirty`, and removes the tree |
| comparison checker, reviewer, writer | `-s read-only -C <repo>` |

Every call adds `--ephemeral --output-schema <file> -o <file> -` with the prompt on stdin. Prompts and raw outputs stay in a temp folder outside the run folder. When the run ends, the host removes every worktree it made and that folder, unless you set it with `DEEPWORK_HOST_TMP`. The refs under `refs/deepwork/<run>/` stay so the commits survive; after review, delete them with `git for-each-ref --format='%(refname)' refs/deepwork/<run> | xargs -n1 git update-ref -d`. Output that fails its schema is a missing result, with no retry, so every `codex exec` is a counted call. Never pass sandbox-bypass flags. The host does not measure tokens.

Environment: `DEEPWORK_CODEX_BIN` (default `codex`), `DEEPWORK_CODEX_MODEL` (passed as `-m`), `DEEPWORK_EFFORT_KEY` (default `model_reasoning_effort`), `DEEPWORK_CONCURRENCY` (default 4), `DEEPWORK_REPO` (default the current folder), `DEEPWORK_WORKTREE_ROOT` (default `<parent>/<repo>.worktrees`, with names `deepwork-<run>-w<n>`), `DEEPWORK_NETWORK=1` (network for workspace-write calls, and research roles run in an empty temp folder with network), `DEEPWORK_HOST_TMP`. Without network, research checks quotes against `<run>/sources/`.

## Probes

None of these has been verified. Run each once per machine and record the result in `pre-run.md`. Do not launch until the named-ref, checkout and output-folder probes pass for your runtime.

| Mechanic | Probe |
|---|---|
| Launch by `scriptPath` from the skill folder (Claude Code) | With the user's approval, launch a one-agent workflow file by path and check it runs |
| Named ref keeps a worker's commit after its worktree is removed | A worktree agent commits, runs `git update-ref refs/deepwork/probe/C1.1 HEAD`; after it returns, `git cat-file -t <sha>` prints `commit` |
| Isolated worktree can check out another worktree's commit | A second worktree agent runs `git checkout --detach <that sha>` and reports `git rev-parse HEAD` |
| Worktree agent can write the runner output folder | A worktree agent writes `<run>/rounds/probe/out/x.txt`; the file is there after it returns |
| Nullable schema fields | An agent returns `sha: null` against the attempt schema |
| Top-level `return` in the workflow body | The probe workflow ends with `return 1` and the result is 1 |
| Nested `codex exec` | From inside a Codex session, `codex exec --ephemeral -s read-only` with any schema returns output |
| Commit inside a host worktree with `--add-dir` | A child with `-s workspace-write -C <wt> --add-dir <git common dir>` runs `git commit --allow-empty -m probe` |
| Effort config key | `codex exec -c model_reasoning_effort="high"` and check the session header |
| Network config key | A child with `-c sandbox_workspace_write.network_access=true` fetches a known URL |
