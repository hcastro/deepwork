export const meta = {
  name: 'deepwork',
  description: 'deepwork: checked multi-agent rounds over a frozen problem.md; mode, level and call ceiling come from args',
  whenToUse: 'Launched by the deepwork skill only after the user approved confirm.md, which names this workflow and its call ceiling.',
  phases: [
    { title: 'Work', detail: 'one worker per assignment, each in its own worktree' },
    { title: 'Run', detail: 'slow commands, one candidate at a time, in a scratch worktree' },
    { title: 'Check', detail: 'blind checkers, each in its own scratch worktree' },
    { title: 'Compare', detail: 'the round\'s candidates side by side' },
    { title: 'Review', detail: 'process reviewer, full level only' },
    { title: 'Save', detail: 'state.json, ledger.md and every agent result written to the run folder' },
    { title: 'Report', detail: 'report writer, then an auditor who reruns the ten-minute checks' },
  ],
}

// Launch the shipped copy unchanged. When a task needs different instructions, edit only the prompt object P in
// <run>/deepwork.js and run `node scripts/deepwork-host.mjs selftest --script <run>/deepwork.js`. evals/fixtures.json
// tests plan, merge and assess; change those only together with the fixtures. Never edit the copy mid-run.
// args: the JSON that `deepwork-host.mjs args` prints. Every number here is a deepwork choice. None was measured.

// ---------- constants ----------
const MODEL = null // null: every agent runs on the session model. A model name here pins all of them.
const PAIR_MAX_CALLS = 12
const TEAM_MAX_CALLS = 41
const FULL_MAX_CALLS = 100
const LEVELS = {
  pair: { maxCalls: PAIR_MAX_CALLS, rounds: 2, assignments: 1, checkers: 1, compare: false, breakRound: false, reviewer: false, adopt: 0 },
  team: { maxCalls: TEAM_MAX_CALLS, rounds: 2, assignments: 3, checkers: 1, compare: true, breakRound: true, reviewer: false, adopt: 2 },
  full: { maxCalls: FULL_MAX_CALLS, rounds: 4, assignments: 4, checkers: 2, compare: true, breakRound: true, reviewer: true, adopt: 4 },
}
const FINAL_CALLS = 3 // writer, auditor, final file write (2 under the host, which writes files itself)
const SPARE_CALLS = 2 // file-writer retries for the whole run (0 under the host)
const SWEEP_MAX_CALLS = 3
const BREAK_ASSIGNMENTS = 3
const SET_ASIDE_AFTER_FAILS = 3
const SET_ASIDE_AFTER_CRASHES = 2
const MODES = ['research', 'investigation', 'implementation']
const SOLUTION = ['new', 'repair']
const EFFORT = { worker: 'medium', hardWorker: 'high', runner: 'medium', checker: 'high', compare: 'high', reviewer: 'medium',
  filewriter: 'low', writer: 'medium', auditor: 'high' }

// The Codex host defines deepworkHost with write(files). Under Claude Code it is undefined and a file writer agent saves.
const HOST = typeof deepworkHost === 'object' && deepworkHost ? deepworkHost : null

// ---------- schemas (strict: every property required, no extra properties) ----------
const str = { type: 'string' }, nstr = { type: ['string', 'null'] }, int = { type: 'integer' }
const nint = { type: ['integer', 'null'] }, bool = { type: 'boolean' }, nbool = { type: ['boolean', 'null'] }
const arr = items => ({ type: 'array', items })
const en = (...v) => ({ type: 'string', enum: v })
const obj = p => ({ type: 'object', additionalProperties: false, properties: p, required: Object.keys(p) })

const SCHEMA = {
  attempt: obj({ claim: str, method: str, sha: nstr, ref: nstr, quick_checks_pass: bool,
    checks_run: arr(obj({ command: str, exit_code: nint, output_path: nstr })), slow_requests: arr(obj({ command: str, why: str })),
    criteria_claimed: arr(str), edited_tests: arr(obj({ path: str, change: en('weakened', 'equivalent', 'strengthened'), reason: str })),
    counterexample: nbool, control_run: nstr, looked: arr(str), proposed_approaches: arr(str), question_for_human: nstr, question_blocking: bool }),
  run: obj({ head_sha: nstr, dirty: bool, runs: arr(obj({ command: str, criterion_id: nstr, status: en('ran', 'not_run'), exit_code: nint,
    output_path: nstr, observed: str, reason_not_run: nstr })) }),
  check: obj({ candidate_id: str, head_sha: nstr, dirty: bool, verdict: en('pass', 'fail', 'cant_tell'),
    criteria: arr(obj({ id: str, status: en('met', 'unmet', 'not_run'), evidence: str })),
    objections: arr(obj({ key: str, class: en('wrong-approach', 'missed-case', 'weak-evidence', 'unclear-problem'), criterion_id: nstr,
      where: str, why: str })), control_run_caught: nbool }),
  compare: obj({ shared_blind_spots: arr(str), rows: arr(obj({ candidate_id: str, verdict: en('pass', 'block'), why: str })) }),
  review: obj({ warnings: arr(obj({ text: str, cites: arr(str) })) }),
  report: obj({ report_md: str, needs_you: arr(str) }),
  audit: obj({ audit_md: str, unsupported: int, checks: arr(obj({ command: str, expected: str, actual: str, match: bool })) }),
  filewriter: obj({ written: arr(obj({ path: str, bytes: int })) }),
}

// ---------- helpers ----------
const uniq = xs => Array.from(new Set(xs))
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '...' : String(s))
const cmpId = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true })
const mustIds = criteria => criteria.filter(c => c.tier === 'must').map(c => c.id)
const roundOf = cid => Number(String(cid).slice(1).split('.')[0])
const rdir = (cfg, r) => `${cfg.run}/rounds/r${r}`
const fileOf = (cfg, r, cid, what) => `${rdir(cfg, r)}/${cid}.${what}.json`
const outDir = (cfg, cid) => `${rdir(cfg, roundOf(cid))}/out/${cid}`
const refName = (cfg, cid) => `refs/deepwork/${cfg.runId}/${cid}`
const finalCalls = cfg => (cfg.host ? FINAL_CALLS - 1 : FINAL_CALLS)
const spareLeft = (st, cfg) => (cfg.host ? 0 : SPARE_CALLS - st.spareUsed)
const knownKeys = st => uniq(st.attempts.flatMap(x => x.keys)).sort()
const recurring = st => knownKeys(st).filter(k => st.attempts.filter(x => x.keys.includes(k)).length >= 2)
const slowFor = (st, a) => (SOLUTION.includes(a.kind) ? st.criteria.filter(c => c.slow) : [])
// No runner when nothing slow is asked for, or when a solution worker's own quick checks failed. A break attempt keeps
// its runner, since a failing check may be its counterexample.
const needsRunner = (crits, a, att) => !!att && (crits.length > 0 || att.slow_requests.length > 0)
  && (!SOLUTION.includes(a.kind) || att.quick_checks_pass)
const utf8Len = s => Array.from(String(s)).reduce((n, ch) => n + [0x80, 0x800, 0x10000, Infinity].findIndex(m => ch.codePointAt(0) < m) + 1, 0)

function config(A, host) {
  const runId = String(A.run || 'run').split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9._-]+/g, '-')
  return { mode: A.mode, level: A.level, run: A.run, problem: A.problem, context: A.context, skill: A.skill, host: !!host, runId, L: LEVELS[A.level] }
}

function checkArgs(A, host) {
  if (!A || !MODES.includes(A.mode)) return 'args.mode must be research, investigation or implementation'
  if (!LEVELS[A.level]) return 'args.level must be pair, team or full'
  if (A.level === 'pair' && !host) return 'pair runs by hand in Claude Code (references/runtimes.md)'
  for (const k of ['run', 'problem', 'context', 'skill', 'problem_hash']) if (!A[k]) return `args.${k} is required`
  if (!Array.isArray(A.criteria) || !mustIds(A.criteria).length) return 'args.criteria needs at least one must criterion'
  const weak = A.criteria.filter(c => c.tier === 'must' && c.cannot_fail).map(c => c.id)
  if (weak.length) return `must criteria marked cannot_fail: ${weak.join(', ')}. Build a check that can fail as its own pair task,`
    + ' merge it into the base branch, update problem.md and confirm again.'
  if (!A.prior && !(A.approaches || []).length) return 'args.approaches is empty'
  const f = A.framing_calls || 0
  if (!Number.isInteger(f) || f < 0 || f > SWEEP_MAX_CALLS) return `args.framing_calls must be an integer from 0 to ${SWEEP_MAX_CALLS}`
  return null
}

// ---------- state ----------
function newApproach(a, source) {
  return { id: a.id, kind: a.kind === 'disprove' ? 'disprove' : 'establish', claim: a.claim, criteria: a.criteria && a.criteria.length
    ? a.criteria : null, disproves: a.disproves || null, source: source || a.source || 'problem.md', status: 'open' }
}

function init(A) {
  return {
    version: 2, level: A.level, mode: A.mode, problem_hash: A.problem_hash, criteria: A.criteria, approaches: A.approaches.map(a => newApproach(a)),
    round: 0, roundBase: 0, calls: A.framing_calls || 0, earlierCalls: 0, spareUsed: 0,
    attempts: [], excluded: [], proposed: [], questions: [], notes: [], droppedNotes: 0, unclear: [], needsYou: [],
    breakDone: false, usage: [], resumes: [], refused: [], stop: null,
  }
}

// A resume is a new launch under a newly approved ceiling. It clears the old stop, the unclear-problem count and Needs you.
// Earlier calls stay on record and the sweep is not charged again. Round numbers continue; the round limit and the set-aside
// count start from here. A changed problem.md brings in the new criteria and any approach with a new ID, and sends every
// passed candidate back through the checkers as a repair.
function resume(prior, A) {
  const st = JSON.parse(JSON.stringify(prior))
  const changed = A.problem_hash !== st.problem_hash
  st.resumes.push({ after_round: st.round, calls: st.calls, stop: st.stop ? st.stop.reason : null, from: st.level, to: A.level, problem_changed: changed })
  Object.assign(st, { earlierCalls: st.earlierCalls + st.calls, calls: 0, spareUsed: 0, roundBase: st.round, stop: null, breakDone: false,
    level: A.level, unclear: [], needsYou: [], questions: [] })
  if (!changed) return st
  Object.assign(st, { problem_hash: A.problem_hash, criteria: A.criteria })
  for (const x of st.attempts.filter(y => y.status === 'passed' || y.status === 'confirmed')) {
    Object.assign(x, { status: 'failed', reasons: x.reasons.concat('problem.md changed; to be checked again') })
    const d = st.approaches.find(y => y.id === x.approach)
    if (d && d.status === 'passed') d.status = 'open'
  }
  for (const a of A.approaches || []) if (!st.approaches.some(x => x.id === a.id)) st.approaches.push(newApproach(a))
  return st
}

// ---------- planner (fixed rules; the only place assignments are chosen) ----------
const attemptsOf = (st, d) => st.attempts.filter(x => x.approach === d.id && (d.kind === 'disprove' ? ['disproof'] : SOLUTION).includes(x.kind))
const mustMet = (st, x) => x.met.filter(id => mustIds(st.criteria).includes(id)).length
function bestOf(st, atts) {
  const s = x => [mustMet(st, x), x.met.length, x.round]
  return atts.filter(x => x.status !== 'crashed').sort((a, b) => { const p = s(a), q = s(b); return q[0] - p[0] || q[1] - p[1] || q[2] - p[2] })[0] || null
}
// Passed or confirmed solution attempts whose approach was not excluded in the meantime.
const passedOf = st => st.attempts.filter(x => SOLUTION.includes(x.kind) && (x.status === 'passed' || x.status === 'confirmed')
  && (st.approaches.find(d => d.id === x.approach) || {}).status !== 'excluded')
// Selection order: confirmed first, then most should and stretch criteria met, then lowest ID.
const rank = (st, list) => list.slice().sort((a, b) => (b.status === 'confirmed') - (a.status === 'confirmed')
  || (b.met.length - mustMet(st, b)) - (a.met.length - mustMet(st, a)) || cmpId(a.cid, b.cid))
function mk(st, o) {
  const d = st.approaches.find(x => x.id === o.approach)
  const base = o.base ? st.attempts.find(x => x.cid === o.base) : null
  return { cid: null, approach: o.approach, kind: o.kind, claim: o.claim || (d ? d.claim : ''), criteria: (d && d.criteria) || mustIds(st.criteria),
    base: o.base || null, base_sha: base ? base.sha : null, against: o.against || null }
}

// Worst-case calls for one round: worker + runner + checkers per assignment, plus the file save, comparison and reviewer.
// estimate() sums it over a level, and the selftest fails when any level's worst case leaves no call under its ceiling.
const roundCost = (cfg, n, brk) => n * (2 + cfg.L.checkers) + (cfg.host ? 0 : 1) + (brk ? 0 : (cfg.L.compare ? 1 : 0) + (cfg.L.reviewer ? 1 : 0))
const numbered = p => { p.assignments.forEach((a, k) => { a.cid = `C${p.round}.${k + 1}` }); return p }

function plan(st, cfg) {
  const p = { round: st.round + 1, kind: 'work', stop: null, assignments: [], setAside: [], gaps: [], reviewer: false, adopt: [] }
  if (st.stop) return Object.assign(p, { stop: st.stop.reason })
  const passed = passedOf(st)
  if (passed.length) {
    if (!cfg.L.breakRound || st.breakDone || passed.every(x => x.status === 'confirmed')) return Object.assign(p, { stop: 'accepted' })
    // Break round: one break attempt per passed candidate, selected first; in investigation, disproof hunts for the other open hypotheses.
    p.kind = 'break'
    const list = rank(st, passed.filter(x => x.status === 'passed')).map(x => mk(st, { approach: x.approach, kind: 'break', against: x.cid }))
    if (cfg.mode === 'investigation') {
      const taken = new Set(passed.map(x => x.approach))
      for (const d of st.approaches.filter(x => x.kind === 'establish' && x.status === 'open' && !taken.has(x.id)).sort((a, b) => cmpId(a.id, b.id))) {
        list.push(mk(st, { approach: d.id, kind: 'disproof', against: d.id, claim: `Hypothesis ${d.id} does not hold: ${d.claim}` }))
      }
    }
    Object.assign(p, { assignments: list.slice(0, BREAK_ASSIGNMENTS), gaps: list.slice(BREAK_ASSIGNMENTS).map(a => a.against) })
    return numbered(p)
  }
  if (p.round - st.roundBase > cfg.L.rounds) return Object.assign(p, { stop: 'rounds' })
  const live = []
  for (const d of st.approaches.filter(x => x.status === 'open').sort((a, b) => cmpId(a.id, b.id))) {
    const atts = attemptsOf(st, d), recent = atts.filter(x => x.round > st.roundBase)
    const crashes = recent.filter(x => x.status === 'crashed').length
    if (recent.length >= SET_ASIDE_AFTER_FAILS || crashes >= SET_ASIDE_AFTER_CRASHES) { p.setAside.push(d.id); continue }
    const best = bestOf(st, atts)
    const kind = d.kind === 'disprove' ? 'disproof' : best ? 'repair' : 'new'
    // Disproof hunts, then repairs that met a must criterion, then untried approaches, then repairs that met none.
    const prio = kind === 'disproof' ? 0 : kind === 'new' ? 2 : mustMet(st, best) ? 1 : 3
    live.push({ prio, score: best ? best.met.length : 0,
      a: mk(st, { approach: d.id, kind, base: best ? best.cid : null, against: d.kind === 'disprove' ? d.disproves : null }) })
  }
  live.sort((x, y) => x.prio - y.prio || y.score - x.score || cmpId(x.a.approach, y.a.approach))
  const assignments = live.map(x => x.a).slice(0, cfg.L.assignments)
  // Free slots go to approaches workers proposed, oldest first, after every approach from problem.md, up to the level's
  // adopt limit per launch. The rest stay in Needs you.
  const adoptedHere = st.proposed.filter(x => x.adopted && x.adoptedRound > st.roundBase).length
  const room = Math.min(cfg.L.assignments - assignments.length, cfg.L.adopt - adoptedHere)
  const taken = new Set(st.approaches.map(d => d.id))
  for (const x of st.proposed.filter(q => !q.adopted).slice(0, Math.max(0, room))) {
    let n = 1
    while (taken.has(`W${n}`)) n += 1
    taken.add(`W${n}`)
    p.adopt.push({ id: `W${n}`, claim: x.claim, from: x.from })
    assignments.push(mk(st, { approach: `W${n}`, kind: 'new', claim: x.claim }))
  }
  Object.assign(p, { assignments, reviewer: cfg.L.reviewer })
  return p.assignments.length ? numbered(p) : Object.assign(p, { stop: 'exhausted' })
}

function applyPlan(st, p) {
  for (const id of p.setAside) st.approaches.find(d => d.id === id).status = 'set_aside'
  if (p.stop) return
  for (const x of p.adopt || []) {
    st.approaches.push(newApproach({ id: x.id, kind: 'establish', claim: x.claim }, `proposed by ${x.from}`))
    const q = st.proposed.find(y => y.claim === x.claim && !y.adopted)
    if (q) Object.assign(q, { adopted: x.id, adoptedRound: p.round })
  }
  st.round = p.round
  if (p.kind === 'break') st.breakDone = true
}

// ---------- acceptance and merge (fixed rules; the only writer of state) ----------
// A checker or runner result is void when its tree moved off the candidate or was left dirty. Void counts as missing.
const isVoid = (r, sha) => !r || r.dirty !== false || (!!sha && r.head_sha !== sha)

// The acceptance rule for one candidate. compare is undefined when the level has no comparison checker.
function assess(criteria, need, sha, checks, run, compare, cid) {
  const reasons = [], valid = checks.filter(c => !isVoid(c, sha)), runOk = !isVoid(run, sha)
  if (valid.length < need) reasons.push(`${need - valid.length} check(s) missing or void`)
  if (valid.some(c => c.verdict !== 'pass')) reasons.push('a checker did not pass it')
  const met = criteria.filter(cr => valid.length > 0 && valid.every(c => c.criteria.some(x => x.id === cr.id && x.status === 'met'))
    && (!cr.slow || (runOk && run.runs.some(r => r.criterion_id === cr.id && r.status === 'ran')))).map(cr => cr.id)
  const unmet = mustIds(criteria).filter(id => !met.includes(id))
  if (unmet.length) reasons.push(`must criteria not met: ${unmet.join(', ')}`)
  if (compare !== undefined) {
    const row = compare && compare.rows.find(r => r.candidate_id === cid)
    if (!row || row.verdict !== 'pass') reasons.push(compare ? 'no pass row from the comparison checker' : 'comparison checker missing')
  }
  return { pass: !reasons.length, met, reasons }
}

function merge(st, p, res, cfg) {
  const need = cfg.L.checkers
  for (const r of res.items) {
    const a = r.a, att = r.attempt
    const e = { cid: a.cid, round: p.round, approach: a.approach, kind: a.kind, base: a.base, against: a.against, status: 'crashed',
      sha: null, ref: null, claim: null, met: [], keys: [], reasons: [], looked: [] }
    st.attempts.push(e)
    if (!att) continue
    Object.assign(e, { sha: att.sha, ref: att.ref, claim: clip(att.claim, 300), looked: att.looked })
    // Only a blocking question stops the run. Any other goes to Needs you and to later workers, and the run goes on.
    if (att.question_for_human && att.question_blocking && !st.stop) st.stop = { reason: 'question', detail: att.question_for_human, from: a.cid }
    else if (att.question_for_human && !st.questions.some(q => norm(q.text) === norm(att.question_for_human))) {
      st.questions.push({ text: att.question_for_human, from: a.cid })
      st.needsYou.push(`${a.cid} asked, without blocking the run: ${clip(att.question_for_human, 300)}`)
    }
    const valid = r.checks.filter(c => !isVoid(c, att.sha)), objs = valid.flatMap(c => c.objections)
    const all = v => valid.length >= need && valid.every(c => c.verdict === v)
    e.keys = uniq(objs.map(o => o.key))
    const unclear = objs.find(o => o.class === 'unclear-problem')
    if (unclear) st.unclear = uniq(st.unclear.concat(a.cid))
    if (unclear) st.needsYou.push(`${a.cid}: the problem statement may be unclear: ${clip(unclear.why, 300)}`)
    // Worker proposals wait here. The planner adopts some into free slots (see plan); the rest go to Needs you.
    for (const q of att.proposed_approaches) if (!st.proposed.some(x => norm(x.claim) === norm(q))) st.proposed.push({ claim: q, from: a.cid })
    const d = st.approaches.find(x => x.id === a.approach)
    if (SOLUTION.includes(a.kind)) {
      const v = assess(st.criteria, need, att.sha, r.checks, r.run, cfg.L.compare ? res.compare : undefined, a.cid)
      Object.assign(e, { met: v.met, reasons: v.reasons, status: v.pass ? 'passed' : 'failed' })
      if (v.pass && d) d.status = 'passed'
    } else if (a.kind === 'disproof') {
      // An exclusion counts only when every checker reran the control run and saw it catch the effect.
      const ok = !!att.control_run && all('pass') && valid.every(c => c.control_run_caught === true)
      e.status = ok ? 'held' : 'failed'
      if (ok) {
        const target = st.approaches.find(x => x.id === a.against)
        if (target) target.status = 'excluded'
        if (d && d !== target) d.status = 'done'
        st.excluded.push({ approach: a.against || a.approach, claim: target ? target.claim : e.claim, by: a.cid, control_run: att.control_run })
      }
    } else {
      // A break attempt that found nothing confirms only when it lists where it looked and the checkers accept that search.
      const t = st.attempts.find(x => x.cid === a.against)
      if (att.counterexample === true) e.status = all('pass') ? 'held' : all('fail') ? 'failed' : 'undecided'
      else e.status = att.looked.length && all('pass') ? 'none-found' : 'unchecked'
      if (t && t.status === 'passed' && (e.status === 'none-found' || e.status === 'failed')) t.status = 'confirmed'
      const td = t && e.status === 'held' && st.approaches.find(x => x.id === t.approach)
      if (t && e.status === 'held') t.status = 'broken'
      if (td) td.status = 'open'
    }
  }
  if (st.unclear.length >= 2 && !st.stop) st.stop = { reason: 'unclear-problem', detail: `raised by ${st.unclear.join(', ')}` }
  const known = new Set(knownKeys(st))
  for (const w of (res.review || { warnings: [] }).warnings) {
    if (uniq(w.cites).filter(k => known.has(k)).length >= 2) st.notes.push({ round: p.round, text: w.text, cites: w.cites })
    else st.droppedNotes += 1
  }
  st.usage.push({ round: p.round, kind: p.kind, calls: res.calls || 0 })
  return st
}

// ---------- ledger, estimate, report context ----------
function renderLedger(st) {
  const L = ['# Ledger', '', `Problem hash ${st.problem_hash}. Level ${st.level}. Round ${st.round}.`
    + ` Calls: ${st.calls} this launch, ${st.earlierCalls} earlier.`]
  L.push('', '## Approaches', '', ...st.approaches.map(d => `- ${d.id} [${d.status}, ${d.kind}${d.disproves ? ` of ${d.disproves}` : ''}] ${d.claim}`))
  L.push('', '## Attempt log', '')
  for (const x of st.attempts) {
    L.push(`- ${x.cid} r${x.round} ${x.approach} ${x.kind}${x.base ? ` on ${x.base}` : ''}${x.against ? ` against ${x.against}` : ''}: ${x.status};`
      + ` met ${x.met.join(', ') || 'none'}; objections ${x.keys.join(', ') || 'none'}${x.sha ? `; commit ${x.sha}` : ''}`
      + `${x.looked.length ? `; looked: ${x.looked.join('; ')}` : ''}`)
  }
  L.push('', '## Excluded approaches', '', ...st.excluded.map(e => `- ${e.approach}: ${e.claim} (by ${e.by}; control run: ${e.control_run})`))
  L.push('', '## Open questions for the human', '', ...(st.questions || []).map(q => `- ${q.from}: ${q.text}`))
  L.push('', '## Recurring objections', '', ...recurring(st).map(k => `- ${k}`))
  L.push('', '## Process warnings (apply every one)', '', ...st.notes.map(n => `- r${n.round}: ${n.text} (cites ${n.cites.join(', ')})`))
  L.push('', '## Calls', '', ...st.resumes.map(r => `- resumed after r${r.after_round} (${r.calls} calls, stop ${r.stop}, ${r.from} to ${r.to})`))
  L.push(...st.usage.map(u => `- r${u.round} ${u.kind}: ${u.calls} calls`), ...st.refused.map(x => `- refused at the ceiling: ${x}`))
  return L.join('\n') + '\n'
}

// Worst case per level from the planner's roundCost; confirm.md quotes it. fits needs one call of margin. Pair always costs as the host.
function estimate(o) {
  const cfg = config({ mode: o.mode, level: o.level, run: 'x' }, o.host || o.level === 'pair'), L = cfg.L
  const framing = o.mode !== 'investigation' ? 0 : typeof o.framing_calls === 'number' ? o.framing_calls : SWEEP_MAX_CALLS
  const worst = framing + L.rounds * roundCost(cfg, L.assignments, false) + (L.breakRound ? roundCost(cfg, BREAK_ASSIGNMENTS, true) : 0)
    + finalCalls(cfg) + spareLeft({ spareUsed: 0 }, cfg)
  return { level: o.level, mode: o.mode, host: !!o.host, ceiling: L.maxCalls, framing_calls: framing, worst_case_calls: worst, fits: worst < L.maxCalls }
}

// What the report writer and auditor are told. Pair by hand gets the same through the host.
function reportCtx(st, cfg) {
  const ranked = rank(st, passedOf(st)), selected = ranked[0] || null
  const best = selected ? null : st.attempts.filter(x => SOLUTION.includes(x.kind) && x.status !== 'crashed')
    .sort((x, y) => y.met.length - x.met.length || cmpId(x.cid, y.cid))[0] || null
  const gaps = cfg.mode !== 'investigation' ? [] : st.approaches
    .filter(d => d.kind === 'establish' && !['excluded', 'done'].includes(d.status) && (!selected || d.id !== selected.approach))
    .map(d => `- ${d.id} [${d.status}] ${d.claim}`)
  const needsYou = st.needsYou.concat(st.stop && st.stop.detail ? [`${st.stop.reason}: ${st.stop.detail}`] : [],
    st.proposed.filter(x => !x.adopted).map(x => `approach proposed by ${x.from}, not tried: ${clip(x.claim, 200)}`))
  return { selected, best: best && best.cid, sha: (selected || best || {}).sha || null, runnersUp: ranked.slice(1).map(x => x.cid),
    stop: st.stop ? st.stop.reason : 'none', gaps, needsYou }
}

// A shell script that writes each file byte for byte: a quoted heredoc per file, so $, backticks and backslashes stay
// literal, with a delimiter that appears in no line of the content. Contents end with a newline (see withNewline).
const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`
function writeScript(files) {
  const parts = files.map(f => {
    let tag = 'DEEPWORK_EOF', n = 0
    while (f.content.split('\n').includes(tag)) tag = `DEEPWORK_EOF_${++n}`
    const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '.'
    return `mkdir -p ${shq(dir)} && cat > ${shq(f.path)} <<'${tag}'\n${f.content}${tag}`
  })
  return parts.concat(`wc -c ${files.map(f => shq(f.path)).join(' ')}`).join('\n')
}
const withNewline = f => (f.content.endsWith('\n') ? f : Object.assign({}, f, { content: `${f.content}\n` }))

// ---------- prompts (one source for both runtimes) ----------
// Stable rule text lives in references/checks.md; prompts carry what is specific to one call.

const SOURCES = { code: 'the code and its history', logs: 'logs, metrics and traces', upstream: 'upstream issues, changelogs and docs' }
const head = (cfg, role) => [
  `You are the ${role} in a deepwork ${cfg.mode} run. You start with no context from earlier agents.`,
  `Context pack, gathered before the run: ${cfg.context}. Read it first, and look there and in the sources it names before you ask the human.`,
  `Problem statement, frozen; read it next: ${cfg.problem}. Run folder: ${cfg.run}.`,
  `Ledger, the run's record, with its process warnings: ${cfg.run}/ledger.md (it does not exist before round 2).`,
  `Rules for you: ${cfg.skill}/references/checks.md, sections "Shared rules", "Result fields" and "${cfg.mode[0].toUpperCase() + cfg.mode.slice(1)}".`,
  'If an instruction stops you, name the file and quote the line. Return only the structured result.',
].join('\n')
const scratch = sha => `You are in your own scratch worktree. ${sha ? `First run \`git checkout --detach ${sha}\`.`
  : 'The candidate has no commit; stay at your starting commit.'} Finish as "Scratch worktrees" in checks.md says.`
const view = (cid, att) => Object.assign({ candidate_id: cid }, att, { ref: null, question_for_human: null, question_blocking: false, proposed_approaches: [] })
const lines = xs => xs.filter(Boolean).join('\n')

const TASK = {
  new: a => `Establish this approach: ${a.claim}`,
  repair: a => `Establish this approach by repairing its best attempt so far: ${a.claim}`,
  disproof: a => `Establish this disproof: ${a.claim}\nIt counts only with a control run (see checks.md); put it in control_run.`,
  break: a => `Break attempt. Find a counterexample to candidate ${a.against}: an input, state or condition where it fails a must criterion`
    + ' or its claim is false. Fill counterexample and looked as checks.md says.',
}
const PASS_IF = () => 'verdict pass: every must criterion is met and you have no blocking objection.'
const VERDICT = {
  new: PASS_IF,
  repair: PASS_IF,
  disproof: () => 'This candidate claims an exclusion. Rerun its control run in your scratch worktree; control_run_caught is true only if'
    + ' you saw the check catch the effect you caused. verdict pass: the exclusion holds.',
  break: (cfg, a, att) => (att.counterexample === true
    ? 'This candidate claims a counterexample to another candidate. verdict pass: the counterexample holds as stated.'
    : `This candidate reports no counterexample to candidate ${a.against} (${fileOf(cfg, roundOf(a.against), a.against, 'attempt')}).`
      + ' verdict pass: its looked list covers the target\'s must criteria and claim, and your own search found no counterexample.'),
}

const P = {
  sweep: (cfg, source) => lines([
    head(cfg, 'hypothesis sweep'),
    `This is a read-only pass over one source: ${SOURCES[source] || source}. Do not create, edit or delete any file.`,
    'List every hypothesis this source supports for the symptom in problem.md, each as a claim a test could prove wrong, with its evidence'
      + ' (path, file:line, query or link) and an observation that would rule it out. Do not rank them. Answer in markdown.',
  ]),
  // ctx: { recurring: [keys], base: {cid, round, sha, run_file, counterexample_file} | null, target: {cid, round, sha} | null }
  worker: (cfg, a, ctx) => lines([
    head(cfg, 'worker'),
    TASK[a.kind](a),
    `Criteria in scope: ${a.criteria.join(', ')}. You choose the method. Read first: problem.md, the ledger and ${cfg.run}/brief.md if they exist.`,
    ctx.recurring.length ? `Objections that recur in this run; answer them where they apply: ${ctx.recurring.join(', ')}` : '',
    ctx.questions.length ? `Open questions earlier workers asked the human, still unanswered. Answer them from the context pack's sources if you can;`
      + ` otherwise work around them and say what your result assumes:\n${ctx.questions.map(q => `- ${q}`).join('\n')}` : '',
    'Ask the human only what the context pack and its sources cannot answer. Set question_blocking true only when no must criterion can'
      + ' move forward without the answer; any other question is recorded and the run continues.',
    ctx.base ? `Build on candidate ${ctx.base.cid}. Before any edit run \`git reset --hard ${ctx.base.sha}\`. Read its attempt file`
      + ` ${fileOf(cfg, ctx.base.round, ctx.base.cid, 'attempt')}, its check files ${rdir(cfg, ctx.base.round)}/${ctx.base.cid}.check*.json and its`
      + ` runner output ${ctx.base.run_file} if it exists; continue any bisect from its last step.`
      + (ctx.base.counterexample_file ? ` A break attempt broke it; read the counterexample in ${ctx.base.counterexample_file}.` : '') : '',
    ctx.target ? `Candidate ${ctx.target.cid} is at commit ${ctx.target.sha}; run \`git reset --hard ${ctx.target.sha}\` first. Its attempt file:`
      + ` ${fileOf(cfg, ctx.target.round, ctx.target.cid, 'attempt')}.` : '',
    'You are in your own git worktree; changes there need no approval. Commit locally and never push. Before returning, run'
      + ` \`git update-ref ${refName(cfg, a.cid)} HEAD\` so the commit outlives the worktree, and report sha and ref.`,
  ]),
  runner: (cfg, a, att, crits) => lines([
    head(cfg, 'runner'),
    `Run slow commands for candidate ${a.cid}, one at a time, after the setup command from problem.md, and report what each produced.`
      + ' You did not write it and you do not judge it.',
    scratch(att.sha),
    `Save each command's full output under ${outDir(cfg, a.cid)}/ and give that path as output_path. That folder is the one place outside`
      + ' your worktree you may write.',
    att.slow_requests.length ? `Requested by the worker:\n${att.slow_requests.map(r => `- \`${r.command}\` (${r.why})`).join('\n')}` : '',
    crits.length ? `Slow acceptance checks:\n${crits.map(c => `- criterion ${c.id}: \`${c.command || 'see problem.md'}\``).join('\n')}` : '',
  ]),
  checker: (cfg, criteria, a, att, run, keys) => lines([
    head(cfg, 'checker'),
    `Check candidate ${a.cid}. You did not write it and you are not told who did. Take the checker stance in checks.md, and apply every`
      + ' process warning in the ledger.',
    scratch(att.sha),
    `Criteria to report: ${criteria.map(c => c.id).join(', ')}. Run the setup command, rerun every quick check yourself, and judge slow`
      + ' criteria only from the runner output below.',
    run ? `Runner output, evidence to check; recompute any arithmetic built on it:\n${JSON.stringify(run.runs)}`
      : 'No runner output for this candidate, so every slow criterion is not_run.',
    `${VERDICT[a.kind](cfg, a, att)} cant_tell counts as not passed.${a.kind === 'disproof' ? '' : ' control_run_caught: null.'}`,
    keys.length ? `Reuse one of these objection keys when it names the same obstacle: ${keys.join(', ')}` : '',
    `Candidate:\n${JSON.stringify(view(a.cid, att))}`,
  ]),
  compare: (cfg, views, earlier) => lines([
    head(cfg, 'comparison checker'),
    'Read the candidates below side by side. Take the checker stance in checks.md toward every one of them, and apply every process warning'
      + ' in the ledger. Name assumptions or blind spots they share. Block any candidate that contradicts an excluded approach in the ledger.',
    'rows: exactly one row per candidate in the Candidates list, verdict pass or block, with a one-sentence why.',
    `Candidates:\n${views.map(v => `- ${v.candidate_id}: ${JSON.stringify(v)}`).join('\n')}`,
    earlier.length ? `Earlier candidates, for comparison only; give them no row:\n${earlier.join('\n')}` : '',
  ]),
  reviewer: (cfg, objections) => lines([
    head(cfg, 'process reviewer'),
    'Read the objections from this round below and the attempt log in the ledger. Look for mistakes several attempts repeat, and gaps one'
      + ' checker caught that another missed.',
    'warnings: short instructions for later workers and checkers in this run, each citing at least two objection keys from the ledger, or it'
      + ' is dropped. Do not propose answers, fixes or techniques, and do not judge which approach is promising.',
    `Objections this round:\n${objections.join('\n') || '(none)'}`,
  ]),
  // The Write tool can be refused outside the session's folder, and the run folder sits outside every repo, so the script
  // builds the shell commands and the agent runs them through Bash unchanged.
  filewriter: (cfg, files) => 'You are the file writer for a deepwork run. Run the shell script below with the Bash tool, exactly as given,'
    + ' in one call. Do not use the Write or Edit tools, and change nothing else. It ends with `wc -c`; report each file with the byte size'
    + ` that \`wc -c\` printed.\n\n${writeScript(files)}`,
  // ctx: reportCtx(st, cfg)
  writer: (cfg, ctx) => lines([
    head(cfg, 'report writer'),
    `Write report.md for a reviewer who never saw the run, about 800 words, with the sections and style in "Report" in ${cfg.skill}/references/run.md.`
      + ` Inputs: problem.md, the ledger, ${cfg.run}/state.json, and the files under ${cfg.run}/rounds/.`,
    ctx.selected ? `Selected candidate: ${ctx.selected.cid} at ${ctx.selected.sha}, `
      + `${ctx.selected.status === 'confirmed' ? 'confirmed (it survived a break attempt)' : 'passed but not confirmed by a break attempt'}.`
      : `No candidate passed (stop: ${ctx.stop}). Write the partial report around the best attempt, ${ctx.best || 'none'}, and its open objections.`,
    ctx.runnersUp.length ? `Runners-up, one line each: ${ctx.runnersUp.join(', ')}` : '',
    ctx.gaps.length ? `Open gaps: list each hypothesis below, neither excluded nor accepted, with where the run looked:\n${ctx.gaps.join('\n')}` : '',
    ctx.needsYou.length ? `Needs you must include:\n${ctx.needsYou.map(x => `- ${x}`).join('\n')}` : '',
    'needs_you: the Needs you items, one line each.',
  ]),
  auditor: (cfg, report, sha) => lines([
    head(cfg, 'report auditor'),
    scratch(sha),
    'Rerun every command in the Ten-minute check section in a fresh shell and record expected and actual output. Check every claim against'
      + ' the ledger and the files under rounds/; a claim with no backing is unsupported, the fallback-target claim included.',
    'audit_md: a "## Audit" section listing each unsupported claim and each mismatched check, or saying none were found. unsupported: how many.',
    `Report:\n${report}`,
  ]),
}

// ---------- runtime ----------
// Hard ceiling. Round calls stop at the ceiling minus the final-report calls and the unused spare calls (file-writer
// retries). Final calls stop at the ceiling. A refused call is a missing result.
async function call(st, cfg, kind, role, prompt, opts, hostOpts) {
  const spare = spareLeft(st, cfg)
  const limit = kind === 'round' ? cfg.L.maxCalls - finalCalls(cfg) - spare : cfg.L.maxCalls
  if (st.calls >= limit || (kind === 'spare' && spare <= 0)) { st.refused.push(opts.label); log(`deepwork: refused ${opts.label} at the ceiling`); return null }
  st.calls += 1
  if (kind === 'spare') st.spareUsed += 1
  const o = Object.assign({ effort: EFFORT[role] }, MODEL ? { model: MODEL } : {}, opts, cfg.host ? hostOpts : {})
  try { return await agent(prompt, o) } catch (e) { log(`deepwork: ${opts.label} failed: ${clip(e && e.message, 160)}`); return null }
}

function contextFor(st, cfg, a) {
  const ctx = { recurring: recurring(st), questions: (st.questions || []).map(q => q.text), base: null, target: null }
  const b = a.base && st.attempts.find(x => x.cid === a.base)
  const ce = b && st.attempts.filter(x => x.kind === 'break' && x.against === b.cid && x.status === 'held').pop()
  if (b) ctx.base = { cid: b.cid, round: b.round, sha: b.sha, run_file: fileOf(cfg, b.round, b.cid, 'run'),
    counterexample_file: ce ? fileOf(cfg, ce.round, ce.cid, 'attempt') : null }
  const t = a.kind === 'break' && st.attempts.find(x => x.cid === a.against)
  if (t) ctx.target = { cid: t.cid, round: t.round, sha: t.sha }
  return ctx
}

async function runRound(st, p, cfg) {
  const keys = knownKeys(st), net = cfg.mode === 'research'
  const tree = (sha, extra) => Object.assign({ base: sha, scratch: true, net }, extra)
  let lock = Promise.resolve()
  const serial = fn => { const r = lock.then(fn); lock = r.then(() => null, () => null); return r }
  const res = { items: [], compare: null, review: null }
  phase('Work')
  const out = await pipeline(p.assignments,
    async a => {
      const ctx = contextFor(st, cfg, a)
      const start = ctx.base ? ctx.base.sha : ctx.target ? ctx.target.sha : null
      const attempt = await call(st, cfg, 'round', a.kind === 'new' ? 'worker' : 'hardWorker', P.worker(cfg, a, ctx),
        { phase: 'Work', label: `${a.cid} ${a.kind} ${a.approach}`, schema: SCHEMA.attempt, isolation: 'worktree' },
        { base: start, ref: refName(cfg, a.cid), net })
      return { a, attempt, run: null, checks: [] }
    },
    async r => {
      // One runner per candidate, one at a time across the round, so slow runs do not compete for the machine.
      const crits = slowFor(st, r.a)
      if (!needsRunner(crits, r.a, r.attempt)) return r
      r.run = await serial(() => call(st, cfg, 'round', 'runner', P.runner(cfg, r.a, r.attempt, crits),
        { phase: 'Run', label: `${r.a.cid} run`, schema: SCHEMA.run, isolation: 'worktree' }, tree(r.attempt.sha, { out: outDir(cfg, r.a.cid) })))
      return r
    },
    async r => {
      if (!r.attempt) return r
      r.checks = await parallel(Array.from({ length: cfg.L.checkers }, (_, i) => () => call(st, cfg, 'round', 'checker',
        P.checker(cfg, st.criteria, r.a, r.attempt, r.run, keys),
        { phase: 'Check', label: `${r.a.cid} check ${i + 1}`, schema: SCHEMA.check, isolation: 'worktree' }, tree(r.attempt.sha))))
      return r
    })
  res.items = out.map((r, i) => r || { a: p.assignments[i], attempt: null, run: null, checks: [] })
  const cands = res.items.filter(r => r.attempt && SOLUTION.includes(r.a.kind))
  if (p.kind === 'work' && cfg.L.compare && cands.length) {
    phase('Compare')
    // A lone candidate is compared against the best earlier ones, so this check never disappears.
    const earlier = cands.length > 1 ? [] : st.attempts.filter(x => SOLUTION.includes(x.kind) && x.status !== 'crashed')
      .sort((x, y) => y.met.length - x.met.length || cmpId(x.cid, y.cid)).slice(0, 2).map(x => `- ${x.cid}: ${fileOf(cfg, x.round, x.cid, 'attempt')}`)
    res.compare = await call(st, cfg, 'round', 'compare', P.compare(cfg, cands.map(r => view(r.a.cid, r.attempt)), earlier),
      { phase: 'Compare', label: `r${p.round} compare`, schema: SCHEMA.compare }, { net })
  }
  if (p.reviewer) {
    phase('Review')
    const objs = res.items.flatMap(r => r.checks.filter(Boolean).flatMap(c => c.objections.map(o => `${r.a.cid} ${o.key} [${o.class}] ${clip(o.why, 300)}`)))
    res.review = await call(st, cfg, 'round', 'reviewer', P.reviewer(cfg, objs), { phase: 'Review', label: `r${p.round} review`, schema: SCHEMA.review }, {})
  }
  return res
}

// state.json and ledger.md, plus the round's plan and every agent result. Both runtimes save them only after the round,
// so no checker can read another checker's verdict while it works.
function roundFiles(st, cfg, p, res) {
  const f = [{ path: `${cfg.run}/state.json`, content: JSON.stringify(st, null, 1) }, { path: `${cfg.run}/ledger.md`, content: renderLedger(st) }]
  const j = (path, v) => { if (v) f.push({ path, content: JSON.stringify(v, null, 1) }) }
  if (!p) return f
  j(`${rdir(cfg, p.round)}/plan.json`, p)
  for (const r of res.items) {
    j(fileOf(cfg, p.round, r.a.cid, 'attempt'), r.attempt)
    j(fileOf(cfg, p.round, r.a.cid, 'run'), r.run)
    r.checks.forEach((c, i) => j(fileOf(cfg, p.round, r.a.cid, `check${i + 1}`), c))
  }
  j(`${rdir(cfg, p.round)}/compare.json`, res.compare)
  j(`${rdir(cfg, p.round)}/review.json`, res.review)
  return f
}

// Saves through the host, or through a file writer whose reported sizes must match; one retry from the spare calls.
async function save(st, cfg, files, kind) {
  files = files.map(withNewline)
  if (HOST) { HOST.write(files); return true }
  phase('Save')
  let todo = files
  for (const k of [kind, 'spare']) {
    const r = await call(st, cfg, k, 'filewriter', P.filewriter(cfg, todo),
      { phase: 'Save', label: `save r${st.round}${k === 'spare' ? ' retry' : ''}`, schema: SCHEMA.filewriter }, {})
    if (r) todo = todo.filter(f => !r.written.some(w => w.path === f.path && w.bytes === utf8Len(f.content)))
    if (!todo.length) return true
    log(`deepwork: file writer did not confirm ${todo.map(f => f.path).join(', ')}`)
  }
  return false
}

async function finish(st, cfg) {
  phase('Report')
  const ctx = reportCtx(st, cfg), sel = ctx.selected
  const report = await call(st, cfg, 'final', 'writer', P.writer(cfg, ctx), { phase: 'Report', label: 'write report', schema: SCHEMA.report }, {})
  const audit = report && await call(st, cfg, 'final', 'auditor', P.auditor(cfg, report.report_md, ctx.sha),
    { phase: 'Report', label: 'audit report', schema: SCHEMA.audit, isolation: 'worktree' }, { base: ctx.sha, scratch: true })
  const auditMd = audit ? audit.audit_md : '## Audit\n\nThe report auditor did not run. Treat every claim above as unchecked.'
  const reportMd = report && `${report.report_md}\n\n${auditMd}\n`
  const written = await save(st, cfg, roundFiles(st, cfg, null, null).concat(reportMd ? [{ path: `${cfg.run}/report.md`, content: reportMd }] : []), 'final')
  const result = {
    status: sel ? sel.status : 'partial', stop: st.stop, selected: sel && { cid: sel.cid, sha: sel.sha, ref: sel.ref, approach: sel.approach },
    best: ctx.best, needs_you: report ? report.needs_you : ctx.needsYou, report: reportMd ? `${cfg.run}/report.md` : null,
    unsupported: audit ? audit.unsupported : null, calls: st.calls, earlier_calls: st.earlierCalls, ceiling: cfg.L.maxCalls,
    refused: st.refused, usage: st.usage, state_file: `${cfg.run}/state.json`, state_written: written,
  }
  return written ? result : Object.assign(result, { state: st, report_md: reportMd })
}

async function main() {
  const A = args || {}
  const err = checkArgs(A, !!HOST)
  if (err) return { status: 'refused', reason: err, calls: 0 }
  const cfg = config(A, !!HOST)
  const st = A.prior ? resume(A.prior, A) : init(A)
  for (;;) {
    const p = plan(st, cfg)
    applyPlan(st, p)
    if (p.stop) { if (!st.stop) st.stop = { reason: p.stop }; break }
    log(`deepwork: round ${p.round} (${p.kind}): ${p.assignments.map(a => `${a.cid} ${a.approach} ${a.kind}`).join(', ')}`)
    const before = st.calls
    const res = await runRound(st, p, cfg)
    merge(st, p, Object.assign(res, { calls: st.calls - before }), cfg)
    await save(st, cfg, roundFiles(st, cfg, p, res), 'round')
    if (st.stop) break
  }
  return finish(st, cfg)
}

const LIB = { SCHEMA, LEVELS, FINAL_CALLS, SPARE_CALLS, SWEEP_MAX_CALLS, BREAK_ASSIGNMENTS, config, checkArgs, init, resume, plan, applyPlan,
  assess, merge, estimate, reportCtx, renderLedger, contextFor, knownKeys, slowFor, needsRunner, fileOf, rdir, writeScript, withNewline, P }

return args && args.lib === true ? LIB : main()
