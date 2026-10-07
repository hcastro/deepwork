# Spend confirmation

- **Problem:** <path>, sha256 <hash from args.json>, criteria <IDs>
- **Level and reason:** <level>, because <one piece of evidence: a wrong-approach objection, an attempt-log count, the number of live hypotheses, or a pre-run figure>
- **Approval launches:** <the workflow file <path> with <run>/args.json | `node <skill>/scripts/deepwork-host.mjs run --args <run>/args.json`>
- **Approaches:** <id, kind, claim; one per line>
- **Ceiling:** <N> calls, hard cap, including <k> framing calls already spent. The worst case from `estimate` is <worst_case_calls>.
- **Pre-run checks:** <fail-first results, measured base rate, probe results>
- **If the run hits the ceiling:** a partial report with the best attempt and its open objections, the excluded approaches, the open gaps and the strongest fallback target met

Approve? (yes / no / change)
