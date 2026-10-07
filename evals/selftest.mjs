// Offline checks for deepwork, run through `node scripts/deepwork-host.mjs selftest [--script S] [--dry]`.
// Strict schemas, every level's worst case under its ceiling, evals/fixtures.json, a pair-by-hand pass and, with --dry,
// three host runs against the fake codex in stub-codex.mjs. No model calls. Temp repos are removed at the end.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { SKILL, HOST_FILE, git, lib, validate, makeArgs, printPrompt, record } from '../scripts/deepwork-host.mjs'

const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
function strictProblems(s, path = '$') {
  const types = Array.isArray(s.type) ? s.type : [s.type], out = []
  if (types.includes('object')) {
    if (s.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`)
    if (Object.keys(s.properties).sort().join() !== (s.required || []).slice().sort().join()) out.push(`${path}: required must list every property`)
    for (const [k, x] of Object.entries(s.properties)) out.push(...strictProblems(x, `${path}.${k}`))
  }
  if (types.includes('array')) out.push(...strictProblems(s.items, `${path}[]`))
  return out
}

const CRITERIA = [{ id: 'M1', tier: 'must', kind: 'check', slow: false, command: 'true', cannot_fail: false, statement: 's' }]
const APPROACHES = [{ id: 'A1', kind: 'establish', claim: 'one' }, { id: 'A2', kind: 'establish', claim: 'two' }]
const mkAttemptRec = x => Object.assign({ round: 1, approach: 'A1', kind: 'new', base: null, against: null, status: 'failed', sha: `s-${x.cid}`,
  ref: null, claim: 'c', met: [], keys: [], reasons: [], looked: [] }, x)
const mkAttempt = (o, cid) => Object.assign({ claim: 'c', method: 'm', sha: `s-${cid}`, ref: null, quick_checks_pass: true, checks_run: [],
  slow_requests: [], criteria_claimed: [], edited_tests: [], counterexample: null, control_run: null, looked: [], proposed_approaches: [],
  question_for_human: null, question_blocking: false, finished_at: null }, o)
// "pass:M1,S1|head=x|dirty|control|obj=key/class"
function mkCheck(spec, cid, sha) {
  if (spec === null) return null
  const [head, ...mods] = spec.split('|'), [verdict, ids] = head.split(':')
  const c = { candidate_id: cid, head_sha: sha, dirty: false, verdict, criteria: (ids ? ids.split(',') : []).map(id => ({ id, status: 'met', evidence: 'e' })),
    objections: [], control_run_caught: null, finished_at: null }
  for (const m of mods) {
    const [k, v] = m.split('=')
    if (k === 'head') c.head_sha = v
    if (k === 'dirty') c.dirty = true
    if (k === 'control') c.control_run_caught = true
    if (k === 'obj') { const [key, cls] = v.split('/'); c.objections.push({ key, class: cls, criterion_id: null, where: 'w', why: 'y' }) }
  }
  return c
}
const mkRun = (spec, sha) => (spec === null || spec === undefined ? null : { head_sha: spec === 'void' ? 'elsewhere' : sha, dirty: false,
  runs: spec === 'void' ? [] : spec.split(',').map(id => ({ command: 'c', criterion_id: id, status: 'ran', exit_code: 0, output_path: null, observed: 'o', reason_not_run: null })),
  finished_at: null })
const fmt = a => `${a.approach}:${a.kind}${a.base ? '@' + a.base : ''}${a.against ? '>' + a.against : ''}`
const diff = (got, want) => Object.keys(want).filter(k => JSON.stringify(got[k]) !== JSON.stringify(want[k]))
  .map(k => `${k}: want ${JSON.stringify(want[k])} got ${JSON.stringify(got[k])}`)

function runCase(L, c) {
  const A = { mode: c.mode || 'implementation', level: c.level || 'team', run: '/r/run1', problem: '/r/problem.md', context: '/r/run1/context.md', skill: SKILL, problem_hash: 'h',
    framing_calls: c.framing_calls || 0, criteria: c.criteria || CRITERIA, approaches: c.approaches || APPROACHES, ...(c.args || {}) }
  if (c.do === 'args') return { error: L.checkArgs(A, !!c.host) }
  if (c.do === 'estimate') return { rows: c.rows.map(r => { const e = L.estimate(r); return `${e.worst_case_calls}/${e.ceiling}` }) }
  let cfg = L.config(A, !!c.host), st = Object.assign(L.init(A), JSON.parse(JSON.stringify(c.state || {})))
  st.attempts = st.attempts.map(mkAttemptRec)
  for (const [id, s] of Object.entries(c.status || {})) st.approaches.find(d => d.id === id).status = s
  if (c.resume) { const A2 = Object.assign({}, A, c.resume); st = L.resume(st, A2); cfg = L.config(A2, !!c.host) }
  if (c.do === 'context') return { base: L.contextFor(st, cfg, c.assignment).base }
  if (c.do === 'plan') {
    const p = L.plan(st, cfg)
    return { stop: p.stop, kind: p.kind, assignments: p.assignments.map(fmt), base_sha: p.assignments.map(a => a.base_sha), reviewer: p.reviewer,
      gaps: p.gaps, setAside: p.setAside, calls: st.calls }
  }
  const p = { round: st.round + 1, kind: c.kind || 'work' }, problems = []
  const items = c.results.map(r => {
    const a = Object.assign({ base: null, against: null }, r.a, { cid: r.cid })
    const att = r.attempt === null ? null : mkAttempt(r.attempt || {}, r.cid), sha = att ? att.sha : null
    const out = { a, attempt: att, run: mkRun(r.run, sha), checks: (r.checks || []).map(s => mkCheck(s, r.cid, sha)) }
    for (const [n, v] of [['attempt', out.attempt], ['run', out.run], ...out.checks.map(x => ['check', x])]) if (v) problems.push(...validate(L.SCHEMA[n], v).map(e => `fixture ${n}: ${e}`))
    return out
  })
  const compare = c.compare === null ? null : { shared_blind_spots: [], rows: Object.entries(c.compare || {}).map(([candidate_id, verdict]) => ({ candidate_id, verdict, why: 'w' })) }
  L.merge(st, p, { items, compare, review: c.review || null }, cfg)
  return { problems, statuses: Object.fromEntries(st.attempts.map(x => [x.cid, x.status])), approaches: Object.fromEntries(st.approaches.map(d => [d.id, d.status])),
    excluded: st.excluded.length, stop: st.stop ? st.stop.reason : null, needs_you: st.needsYou.length, notes: st.notes.length, clock: st.clock }
}

const DRY_BLOCK = { criteria: [{ id: 'M1', tier: 'must', kind: 'check', slow: false, command: 'true', cannot_fail: false, statement: 'quick' },
  { id: 'M2', tier: 'must', kind: 'check', slow: true, command: 'true', cannot_fail: false, statement: 'slow' },
  { id: 'S1', tier: 'should', kind: 'check', slow: false, command: 'true', cannot_fail: false, statement: 'nice' }], approaches: APPROACHES }
const made = [], extra = [], temps = () => readdirSync(tmpdir()).filter(n => /^(deepwork-|dw-dry-)/.test(n))
function tempRun() {
  const dir = mkdtempSync(join(tmpdir(), 'dw-dry-')); made.push(dir)
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '--allow-empty', '-m', 'base')
  const run = `${dir}-run`; extra.push(run, `${dir}.worktrees`)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'problem.md'), `# Problem\n\n\`\`\`json\n${JSON.stringify(DRY_BLOCK, null, 1)}\n\`\`\`\n`)
  writeFileSync(join(run, 'context.md'), '# Context pack\n\n## Repo instructions\n\nnone found: a temp repo with one empty commit.\n')
  return { dir, run }
}

const DRY = [
  { name: 'team implementation, confirmed after a break round', args: { mode: 'implementation', level: 'team' }, want: { status: 'confirmed', stop: 'accepted', calls: 11 } },
  { name: 'full investigation, reject-all, exhausted', args: { mode: 'investigation', level: 'full', 'framing-calls': 3 }, env: { STUB_REJECT_ALL: '1' },
    want: { status: 'partial', stop: 'exhausted', calls: 35 } },
  { name: 'pair research, C1.1 fails and the untried A2 passes as C2.1', args: { mode: 'research', level: 'pair' }, want: { status: 'passed', stop: 'accepted', calls: 8 } },
  { name: 'team implementation with a time budget, same result, and the host stamps the clock', args: { mode: 'implementation', level: 'team', 'time-budget-min': 30 },
    want: { status: 'confirmed', stop: 'accepted', calls: 11 }, clocked: true },
]
function dryRun(L, script, d) {
  const { dir, run } = tempRun()
  makeArgs(L, Object.assign({ run }, d.args))
  const env = Object.assign({}, process.env, { DEEPWORK_CODEX_BIN: join(SKILL, 'evals', 'stub-codex.mjs'), DEEPWORK_REPO: dir }, d.env || {})
  const r = spawnSync(process.execPath, [HOST_FILE, 'run', '--args', join(run, 'args.json'), '--script', script], { env, encoding: 'utf8' })
  if (r.status !== 0) return [`host exited ${r.status}: ${String(r.stderr).slice(-400)}`]
  const res = JSON.parse(r.stdout)
  const st = d.clocked ? readJson(join(run, 'state.json')) : null
  return diff({ status: res.status, stop: res.stop && res.stop.reason, calls: res.calls }, d.want)
    .concat(res.calls > res.ceiling ? ['calls above ceiling'] : [], res.report ? [] : ['no report'],
      st && !(st.clock > 0 && st.usage.every(u => u.ended_at)) ? ['clock or round end times not recorded'] : [])
}

// The file writer's shell script reproduces every file byte for byte, whatever the content holds.
function writeScriptExact(L) {
  const d = mkdtempSync(join(tmpdir(), 'dw-dry-')); extra.push(d)
  const files = [{ path: join(d, 'a b', "it's.md"), content: 'cost $HOME `ls` \\ end\nDEEPWORK_EOF\nno newline at the end' },
    { path: join(d, 'state.json'), content: JSON.stringify({ a: [1, 'x'] }) }].map(L.withNewline)
  const r = spawnSync('bash', ['-c', L.writeScript(files)], { encoding: 'utf8' })
  if (r.status !== 0) return [`script exited ${r.status}: ${r.stderr}`]
  return files.filter(f => readFileSync(f.path, 'utf8') !== f.content).map(f => `${f.path} differs from its content`)
}

// Only timing-sensitive runner work takes the shared lock: slow criteria unless marked exclusive: false, and slow
// requests the worker marked exclusive.
function lockSplit(L) {
  const att = x => ({ slow_requests: x })
  const cases = [
    ['slow criterion, default', [{ id: 'M2', slow: true }], att([]), true],
    ['slow criterion marked exclusive: false', [{ id: 'M2', slow: true, exclusive: false }], att([]), false],
    ['only a non-exclusive request', [], att([{ command: 'pnpm test', why: 'w', exclusive: false }]), false],
    ['an exclusive request', [], att([{ command: 'node bench.mjs', why: 'w', exclusive: true }]), true],
  ]
  return cases.filter(([, c, a, want]) => L.exclusiveRun(c, a) !== want).map(([n, , , want]) => `${n}: want ${want}`)
}

// args refuses to start without a context pack, and with one that holds only the template.
function contextRequired(L) {
  const { run } = tempRun(), out = [], tries = []
  const attempt = () => { try { makeArgs(L, { run, mode: 'implementation', level: 'pair' }); return null } catch (e) { return e.message } }
  rmSync(join(run, 'context.md'))
  tries.push(['missing', attempt(), /is missing/])
  writeFileSync(join(run, 'context.md'), readFileSync(join(SKILL, 'assets', 'context.md'), 'utf8'))
  tries.push(['template only', attempt(), /only the template/])
  for (const [what, err, want] of tries) if (!err || !want.test(err)) out.push(`${what}: want a refusal matching ${want}, got ${err}`)
  writeFileSync(join(run, 'context.md'), '# Context pack\n\n## Gaps\n\nnone found: nothing to look up.\n')
  const ok = attempt(); if (ok) out.push(`filled pack refused: ${ok}`)
  return out
}

// Pair by hand: prompt, save the reply, record, and the writer must name the passed candidate.
function pairByHand(L, script) {
  const { run } = tempRun(), f = { args: join(run, 'args.json'), script }, out = []
  makeArgs(L, { run, mode: 'implementation', level: 'pair' })
  const say = role => printPrompt(L, Object.assign({ _: [role] }, f)).text
  if (!/Return one JSON object/.test(say('worker'))) out.push('worker prompt has no schema line')
  const at = w => L.fileOf(L.config(readJson(f.args), true), 1, 'C1.1', w)
  writeFileSync(at('attempt'), JSON.stringify(mkAttempt({ slow_requests: [] }, 'C1.1')))
  if (!/Slow acceptance checks/.test(say('runner'))) out.push('runner prompt lacks the slow check')
  writeFileSync(at('run'), JSON.stringify(mkRun('M2', 's-C1.1')))
  writeFileSync(at('check1'), JSON.stringify(mkCheck('pass:M1,M2', 'C1.1', 's-C1.1')))
  const rec = record(L, f)
  if (rec.results[0].status !== 'passed') out.push(`record: want passed, got ${JSON.stringify(rec.results[0])}`)
  if (!existsSync(join(run, 'ledger.md')) || !existsSync(join(run, 'state.json'))) out.push('no ledger.md or state.json')
  if (!/Selected candidate: C1\.1 at s-C1\.1/.test(say('writer'))) out.push('writer prompt does not name C1.1')
  return out
}

export async function selftest(script, dry) {
  const L = await lib(script), before = temps()
  let failed = 0
  const report = (name, problems) => { if (problems.length) { failed++; console.log(`FAIL ${name}\n  ${problems.join('\n  ')}`) } else console.log(`ok   ${name}`) }
  report('strict schemas', Object.entries(L.SCHEMA).flatMap(([n, s]) => strictProblems(s).map(p => `${n} ${p}`)))
  const worst = []
  for (const level of Object.keys(L.LEVELS)) for (const mode of ['research', 'investigation', 'implementation']) for (const host of [false, true]) {
    const e = L.estimate({ level, mode, host })
    if (!e.fits) worst.push(`${level} ${mode} host=${host}: ${e.worst_case_calls} of ${e.ceiling}`)
  }
  report('every level\'s worst case stays at least one call under its ceiling', worst)
  for (const c of readJson(join(SKILL, 'evals', 'fixtures.json'))) { const got = runCase(L, c); report(c.name, (got.problems || []).concat(diff(got, c.expect))) }
  report('pair by hand writes a ledger and names the passed candidate', pairByHand(L, script))
  report('args refuses a missing or template-only context pack', contextRequired(L))
  report('only timing-sensitive runner work takes the shared lock', lockSplit(L))
  report('the file writer\'s script writes every file byte for byte', writeScriptExact(L))
  if (dry) for (const d of DRY) report(`dry run: ${d.name}`, dryRun(L, script, d))
  // Each temp repo may keep only its main worktree. Then the repos go, and nothing new may stay in TMPDIR.
  const left = made.flatMap(d => git(d, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).slice(1))
  // Run folders and the sibling <repo>.worktrees folders sit outside each repo; an emptied worktrees folder may stay until cleanup.
  const wtLeft = extra.filter(d => d.endsWith('.worktrees') && existsSync(d) && readdirSync(d).length > 0)
  for (const d of made.concat(extra)) rmSync(d, { recursive: true, force: true })
  report('no worktree left registered and nothing new left in TMPDIR', left.map(l => `still registered: ${l.slice(9)}`)
    .concat(wtLeft.map(d => `worktree folder not emptied: ${d}`))
    .concat(temps().filter(n => !before.includes(n)).map(n => `left in TMPDIR: ${n}`)))
  console.log(failed ? `${failed} failures` : 'all passed')
  process.exit(failed ? 1 : 0)
}
