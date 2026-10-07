#!/usr/bin/env node
// deepwork host. Runs workflows/deepwork.js (or a run's copy) outside Claude Code, turning each agent() call into a
// fresh `codex exec`, and drives pair by hand with the script's own planner and merge. Node 18 or newer, standard library only.
const HELP = `usage: node deepwork-host.mjs <command> [flags]   (references/runtimes.md explains each step)
  args --run R --mode M --level L [--problem P] [--framing-calls N] [--resume]   write and print <run>/args.json
  estimate --mode M --level L [--host] [--framing-calls N]     worst-case calls against the level's ceiling
  prompt sweep --run R --mode investigation --source code|logs|upstream
  prompt worker|runner|checker|writer|auditor --args A       pair by hand
  record --args A                                            pair by hand: merge the round, write state.json and ledger.md
  run --args A [--script S]                                  the loop through codex exec
  selftest [--script S] [--dry]                              offline checks in evals/selftest.mjs`

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const SKILL = resolve(here, '..'), HOST_FILE = fileURLToPath(import.meta.url)
const DEFAULT_SCRIPT = join(SKILL, 'workflows', 'deepwork.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 1)) }
export const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// ---------- evaluate the workflow body with the same hooks the Workflow tool gives it ----------
function body(script) {
  const text = readFileSync(script, 'utf8')
  if (/^export const meta = \{/m.test(text)) return text.replace(/^export const meta/m, 'const meta')
  throw new Error(`${script} must start with export const meta`)
}
// parallel is a barrier whose failed thunks resolve to null; a throwing pipeline stage drops its item to null.
const parallel = ts => Promise.all(ts.map(t => Promise.resolve().then(t).catch(e => { console.error(`[parallel] ${e.message}`); return null })))
const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
  let prev = item
  for (const s of stages) { try { prev = await s(prev, item, i) } catch (e) { console.error(`[pipeline] item ${i}: ${e.message}`); return null } }
  return prev
}))
function evaluate(script, hooks, args) {
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'deepworkHost', body(script))
  return fn(hooks.agent, parallel, pipeline, hooks.phase || (() => {}), hooks.log || (() => {}), args, { total: null, spent: () => 0 }, hooks.host)
}
export const lib = script => evaluate(script, { agent: () => { throw new Error('lib mode makes no agent calls') } }, { lib: true })

// The problem statement's fenced JSON block and the sha256 of the whole file.
export function problemBlock(path) {
  const text = readFileSync(path), m = /```json\s*\n([\s\S]*?)\n```/.exec(text.toString('utf8'))
  if (!m) throw new Error(`${path} has no fenced json block`)
  return Object.assign({ criteria: [], approaches: [] }, JSON.parse(m[1]), { hash: createHash('sha256').update(text).digest('hex') })
}

export function validate(schema, v, path = '$') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
  if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) return [`${path}: expected ${types.join('|')}, got ${t}`]
  if (schema.enum && !schema.enum.includes(v)) return [`${path}: ${JSON.stringify(v)} not in enum`]
  if (t === 'array') return v.flatMap((x, i) => validate(schema.items, x, `${path}[${i}]`))
  if (t !== 'object') return []
  const errs = (schema.required || []).filter(k => !(k in v)).map(k => `${path}.${k}: missing`)
  for (const k of Object.keys(v)) errs.push(...(k in schema.properties ? validate(schema.properties[k], v[k], `${path}.${k}`) : [`${path}.${k}: not allowed`]))
  return errs
}

// problem.md must still match the hash the human confirmed.
function frozen(a) {
  const pb = problemBlock(a.problem)
  if (a.problem_hash === pb.hash) return pb
  throw new Error(`problem.md does not match the confirmed hash (args ${a.problem_hash || 'missing'}, file ${pb.hash}). Run \`args\` and confirm again.`)
}

// args.json, built from problem.md so the criteria, approaches and hash are the confirmed ones.
export function makeArgs(L, f) {
  const run = resolve(f.run), problem = resolve(f.problem || join(run, 'problem.md')), pb = problemBlock(problem)
  const a = { mode: f.mode, level: f.level, run, problem, skill: SKILL, problem_hash: pb.hash,
    framing_calls: Number(f['framing-calls'] || 0), criteria: pb.criteria, approaches: pb.approaches }
  if (f.resume) a.prior = readJson(join(run, 'state.json'))
  const err = L.checkArgs(a, true); if (err) throw new Error(err)
  writeJson(join(run, 'args.json'), a)
  return a
}

// ---------- codex exec as agent() ----------
// At most n codex processes at once; the rest queue.
function limiter(n) {
  let active = 0
  const q = [], next = () => { if (active < n && q.length) { active++; const t = q.shift(); t.fn().then(t.ok, t.bad).finally(() => { active--; next() }) } }
  return fn => new Promise((ok, bad) => { q.push({ fn, ok, bad }); next() })
}

function makeCodexHooks(runDir) {
  const env = process.env, bin = env.DEEPWORK_CODEX_BIN || 'codex', network = env.DEEPWORK_NETWORK === '1'
  const repo = resolve(env.DEEPWORK_REPO || process.cwd())
  const limit = limiter(Number(env.DEEPWORK_CONCURRENCY || 4))
  // Prompts, schemas and raw outputs stay outside the run folder, so no agent reads another's unsaved output.
  const ownTmp = !env.DEEPWORK_HOST_TMP, tmp = env.DEEPWORK_HOST_TMP || mkdtempSync(join(tmpdir(), 'deepwork-')), made = []
  mkdirSync(tmp, { recursive: true })
  const commonDir = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  // Worktrees sit beside the main checkout, at <parent>/<repo>.worktrees/, never inside a repository.
  const mainRoot = dirname(commonDir), wtRoot = resolve(env.DEEPWORK_WORKTREE_ROOT || join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`))
  const wtPrefix = `deepwork-${basename(runDir)}-`
  let counter = 0
  const exec = (argv, input) => new Promise(done => {
    const p = spawn(bin, argv, { stdio: ['pipe', 'ignore', 'pipe'] }), err = []
    p.stderr.on('data', d => err.push(d))
    p.on('error', e => done({ code: -1, err: String(e) })).on('close', code => done({ code, err: Buffer.concat(err).toString() }))
    p.stdin.end(input)
  })
  const agent = (prompt, o = {}) => limit(async () => {
    const id = String(++counter).padStart(4, '0'), label = o.label || 'agent'
    const schemaFile = join(tmp, `${id}.schema.json`), outFile = join(tmp, `${id}.out.json`)
    writeFileSync(schemaFile, JSON.stringify(o.schema || { type: 'object', additionalProperties: false, properties: {}, required: [] }))
    writeFileSync(join(tmp, `${id}.prompt.txt`), prompt)
    const argv = ['exec', '--ephemeral']
    let wt = null
    if (o.isolation === 'worktree') {
      // Opaque counter names, so a path says nothing about which assignment or candidate it holds.
      wt = join(wtRoot, `${wtPrefix}w${id}`)
      try { mkdirSync(wtRoot, { recursive: true }); git(repo, 'worktree', 'add', '--detach', wt, o.base || 'HEAD'); made.push(wt) } catch (e) {
        console.error(`[${label}] worktree add failed: ${String(e.stderr || e.message).slice(-300)}`)
        return null
      }
      argv.push('-s', 'workspace-write', '-C', wt, '--add-dir', commonDir)
      if (o.out) { mkdirSync(o.out, { recursive: true }); argv.push('--add-dir', o.out) }
    } else if (o.net && network) {
      const d = join(tmp, `${id}.net`); mkdirSync(d); argv.push('-s', 'workspace-write', '-C', d)
    } else argv.push('-s', 'read-only', '-C', repo)
    if (network && argv.includes('workspace-write')) argv.push('-c', 'sandbox_workspace_write.network_access=true')
    if (env.DEEPWORK_CODEX_MODEL) argv.push('-m', env.DEEPWORK_CODEX_MODEL)
    if (o.effort) argv.push('-c', `${env.DEEPWORK_EFFORT_KEY || 'model_reasoning_effort'}="${o.effort}"`)
    argv.push('--output-schema', schemaFile, '-o', outFile, '-')
    let out = null
    try {
      const r = await exec(argv, prompt)
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err.slice(-300)}`)
      out = JSON.parse(readFileSync(outFile, 'utf8'))
      const errs = o.schema ? validate(o.schema, out) : []
      if (errs.length) throw new Error(`schema: ${errs.slice(0, 3).join('; ')}`)
    } catch (e) { console.error(`[${label}] ${e.message}; no retry, counts as a missing result`); out = null }
    if (wt) {
      // Record what git says, not what the agent reported.
      let head = null, dirty = true
      try { head = git(wt, 'rev-parse', 'HEAD'); dirty = git(wt, 'status', '--porcelain').length > 0 } catch (e) { /* worktree gone */ }
      if (o.scratch) {
        if (out && 'head_sha' in out) Object.assign(out, { head_sha: head, dirty })
        try { git(repo, 'worktree', 'remove', '--force', wt) } catch (e) { console.error(`[${label}] could not remove ${wt}`) }
      } else if (out && 'sha' in out && head) {
        if (dirty) console.error(`[${label}] worker left uncommitted changes in ${wt}; checkers see only the commit`)
        out.sha = head
        if (o.ref) { try { git(repo, 'update-ref', o.ref, head); out.ref = o.ref } catch (e) { console.error(`[${label}] update-ref failed`) } }
      }
    }
    return out
  })
  const host = { write: files => { for (const f of files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.content) } } }
  // Worker commits outlive their worktrees through refs/deepwork, so the run's end removes every worktree and temp folder made here.
  const cleanup = () => {
    for (const w of made) try { git(repo, 'worktree', 'remove', '--force', w) } catch { /* scratch trees are already gone */ }
    try { git(repo, 'worktree', 'prune') } catch { console.error(`git worktree prune failed in ${repo}`) }
    if (ownTmp) rmSync(tmp, { recursive: true, force: true })
  }
  return { agent, host, cleanup, phase: t => console.error(`== ${t}`), log: m => console.error(m) }
}

// ---------- pair by hand (Claude Code): the same planner, merge and prompts, one command per step ----------
function pairState(L, f) {
  const a = readJson(f.args), cfg = L.config(a, true), sf = join(a.run, 'state.json')
  if (a.level !== 'pair') throw new Error('prompt and record drive pair only; team and full run as a workflow or through `run`')
  frozen(a)
  const st = existsSync(sf) ? readJson(sf) : L.init(a)
  // The plan for the round in progress is saved once, so every prompt and the record step agree on it.
  const pf = join(L.rdir(cfg, st.round + 1), 'plan.json')
  const p = existsSync(pf) ? readJson(pf) : L.plan(st, cfg)
  if (!existsSync(pf) && !p.stop) writeJson(pf, p)
  return { a, cfg, st, p }
}
// A missing, unreadable or schema-invalid result file counts as a missing result.
function loadResult(path, schema, note) {
  let errs = []
  try { if (!existsSync(path)) return null; const v = readJson(path); errs = validate(schema, v); if (!errs.length) return v } catch (e) { errs = [e.message] }
  note.push(`${path}: ${errs.slice(0, 3).join('; ')}`)
  return null
}

export function printPrompt(L, f) {
  const role = f._[0]
  if (role === 'sweep') {
    const run = resolve(f.run || '.'), a = f.args ? readJson(f.args) : { mode: f.mode, run, problem: resolve(f.problem || join(run, 'problem.md')) }
    return { text: L.P.sweep(L.config(Object.assign({ level: 'pair', skill: SKILL }, a), true), f.source || 'code') }
  }
  const { a, cfg, st, p } = pairState(L, f)
  if (!st.stop && p.stop) st.stop = { reason: p.stop }
  const ctx = L.reportCtx(st, cfg)
  if (role === 'writer') return { text: L.P.writer(cfg, ctx) }
  if (role === 'auditor') return { text: L.P.auditor(cfg, readFileSync(join(a.run, 'report.md'), 'utf8'), ctx.sha) }
  if (p.stop) throw new Error(`the plan stops here (${p.stop}). Print the writer prompt next.`)
  const x = p.assignments[0], file = w => L.fileOf(cfg, p.round, x.cid, w), note = []
  const att = loadResult(file('attempt'), L.SCHEMA.attempt, note), run = loadResult(file('run'), L.SCHEMA.run, note)
  if (role !== 'worker' && !att) throw new Error(`no valid attempt at ${file('attempt')}. ${note.join(' ')}`)
  let out
  if (role === 'worker') out = [L.P.worker(cfg, x, L.contextFor(st, cfg, x)), 'attempt']
  else if (role === 'runner') {
    if (!L.needsRunner(L.slowFor(st, x), x, att)) throw new Error('skip the runner: nothing slow to run, or the worker\'s quick checks failed')
    out = [L.P.runner(cfg, x, att, L.slowFor(st, x)), 'run']
  } else if (role === 'checker') out = [L.P.checker(cfg, st.criteria, x, att, run, L.knownKeys(st)), 'check1']
  else throw new Error('prompt sweep|worker|runner|checker|writer|auditor')
  return { text: `${out[0]}\nReturn one JSON object that matches this schema:\n${JSON.stringify(L.SCHEMA[out[1].replace(/1$/, '')])}`, save: file(out[1]) }
}

export function record(L, f) {
  const { a, cfg, st, p } = pairState(L, f)
  if (p.stop) throw new Error(`nothing to record: the plan stops here (${p.stop})`)
  L.applyPlan(st, p)
  const note = [], load = (x, w, s) => loadResult(L.fileOf(cfg, p.round, x.cid, w), s, note)
  const items = p.assignments.map(x => ({ a: x, attempt: load(x, 'attempt', L.SCHEMA.attempt), run: load(x, 'run', L.SCHEMA.run),
    checks: [load(x, 'check1', L.SCHEMA.check)] }))
  const calls = items.reduce((n, r) => n + [r.attempt, r.run, r.checks[0]].filter(Boolean).length, 0)
  st.calls += calls
  L.merge(st, p, { items, compare: null, review: null, calls }, cfg)
  writeJson(join(a.run, 'state.json'), st)
  writeFileSync(join(a.run, 'ledger.md'), L.renderLedger(st))
  const next = L.plan(st, cfg)
  return { round: p.round, invalid_files: note, results: st.attempts.filter(x => x.round === p.round).map(x => ({ cid: x.cid, status: x.status,
    met: x.met, reasons: x.reasons })), next: next.stop ? `stop (${next.stop}): print the writer prompt` : `round ${next.round}: print the worker prompt` }
}

// ---------- commands ----------
// --key value, a bare --flag is true, anything else is positional.
function flags(argv, f = { _: [] }) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], nxt = argv[i + 1]
    if (!a.startsWith('--')) f._.push(a)
    else if (nxt === undefined || nxt.startsWith('--')) f[a.slice(2)] = true
    else f[a.slice(2)] = argv[++i]
  }
  return f
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const f = flags(rest), script = f.script ? resolve(f.script) : DEFAULT_SCRIPT
  if (cmd === 'selftest') return (await import('../evals/selftest.mjs')).selftest(script, !!f.dry)
  if (!['args', 'estimate', 'prompt', 'record', 'run'].includes(cmd)) return console.log(HELP)
  const L = await lib(script), print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
  if (cmd === 'args') return print(makeArgs(L, f))
  const fc = f['framing-calls'] === undefined ? undefined : Number(f['framing-calls'])
  if (cmd === 'estimate') return print(L.estimate({ mode: f.mode || 'implementation', level: f.level || 'team', host: !!f.host, framing_calls: fc }))
  if (cmd === 'prompt') { const o = printPrompt(L, f); if (o.save) console.error(`Save the agent's JSON reply unchanged to ${o.save}`); return print(o.text) }
  if (cmd === 'record') return print(record(L, f))
  const a = readJson(f.args), pb = frozen(a)
  Object.assign(a, { skill: a.skill || SKILL, criteria: pb.criteria, approaches: pb.approaches })
  if (typeof a.prior === 'string') a.prior = readJson(a.prior)
  const hooks = makeCodexHooks(a.run)
  const result = await Promise.resolve().then(() => evaluate(script, hooks, a)).finally(hooks.cleanup)
  writeJson(join(a.run, 'result.json'), result)
  print(result)
}

if (realpathSync(process.argv[1] || '.') === realpathSync(HOST_FILE)) main().catch(e => { console.error(`deepwork-host: ${e.message}`); process.exit(1) })
