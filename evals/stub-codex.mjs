#!/usr/bin/env node
// Fake `codex exec` for dry runs with no model calls:
//   DEEPWORK_CODEX_BIN=evals/stub-codex.mjs DEEPWORK_REPO=<repo> node scripts/deepwork-host.mjs run --args <args.json>
// It exits non-zero on any flag or sandbox mode the host should not pass, then writes a
// schema-valid result to the -o file. Checkers fail candidate C1.1 and any counterexample, and
// pass the rest. STUB_REJECT_ALL=1 fails every candidate, to exercise later rounds and the partial report.
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const WITH_VALUE = new Set(['-s', '-C', '--add-dir', '-m', '-c', '--output-schema', '-o'])
const BARE = new Set(['exec', '--ephemeral', '-'])
const SANDBOX = new Set(['read-only', 'workspace-write'])
const CONFIG = /^(model_reasoning_effort="(low|medium|high|xhigh)"|sandbox_workspace_write\.network_access=true)$/
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (WITH_VALUE.has(a)) {
    const v = argv[++i]
    if (a === '-s' && !SANDBOX.has(v)) { console.error(`stub: sandbox ${v} not allowed`); process.exit(2) }
    if (a === '-c' && !CONFIG.test(v)) { console.error(`stub: config ${v} not expected`); process.exit(2) }
  } else if (!BARE.has(a)) { console.error(`stub: unexpected flag ${a}`); process.exit(2) }
}
const at = f => argv[argv.indexOf(f) + 1]
const schema = JSON.parse(readFileSync(at('--output-schema'), 'utf8'))
const prompt = readFileSync(0, 'utf8')

function fill(s) {
  if (Array.isArray(s.type) && s.type.includes('null')) return null
  if (s.enum) return s.enum[0]
  if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, fill(v)]))
  return { array: [], string: 'stub', integer: 0, number: 0, boolean: false }[s.type] ?? null
}

const out = fill(schema)
const p = schema.properties || {}
if (p.quick_checks_pass) {
  out.quick_checks_pass = true
  if (/^Break attempt/m.test(prompt)) Object.assign(out, { claim: 'stub counterexample', counterexample: true })
} else if (p.runs) {
  out.runs = [...prompt.matchAll(/^- criterion (\S+):/gm)].map(m => ({ command: 'true', criterion_id: m[1], status: 'ran', exit_code: 0, output_path: null, observed: 'stub', reason_not_run: null }))
} else if (p.verdict) {
  const cid = (/Check candidate (C\d+\.\d+)\./.exec(prompt) || [])[1] || 'stub'
  const ids = ((/^Criteria to report: (.*?)\. /m.exec(prompt) || [])[1] || '').split(', ').filter(Boolean)
  const fail = process.env.STUB_REJECT_ALL === '1' || cid === 'C1.1' || /stub counterexample/.test(prompt)
  Object.assign(out, {
    candidate_id: cid, verdict: fail ? 'fail' : 'pass',
    criteria: ids.map(id => ({ id, status: fail ? 'unmet' : 'met', evidence: 'stub' })),
    objections: fail ? [{ key: 'M1-stub', class: 'missed-case', criterion_id: 'M1', where: 'stub', why: 'stub' }] : [],
  })
} else if (p.rows) {
  out.rows = [...prompt.split('Earlier candidates')[0].matchAll(/^- (C\d+\.\d+):/gm)].map(m => ({ candidate_id: m[1], verdict: 'pass', why: 'stub' }))
} else if (p.report_md) {
  out.report_md = '# Report\n\n## Result\n\nstub\n\n## Ten-minute check\n\n- `true` prints nothing'
} else if (p.audit_md) {
  Object.assign(out, { audit_md: '## Audit\n\nstub: no unsupported claims.', unsupported: 0 })
}
writeFileSync(at('-o'), JSON.stringify(out))
