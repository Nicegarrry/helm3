#!/usr/bin/env python3
"""Render documentation snapshots from ticket/issue identities; never mutate GitHub."""
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
tickets = json.loads((root/'docs/ticket-drafts.json').read_text())
ids = json.loads((root/'docs/github-map.json').read_text())
assert set(ids) == {t['key'] for t in tickets}, 'Sync issue identities before rendering'

def link(key):
    return f'[{key} #{ids[key]["number"]}]({ids[key]["url"]})'

lines = ['# Helm 3 Map — addendum revision', '',
         'Snapshot: 2026-09-15. GitHub issues and native dependencies remain authoritative. This is a proposed, changeable approach to the original 39 sections plus the 29-section addendum.', '',
         f'Parent: {link("MAP")}. CONTEXT CLEAN precedes first-wave approval at {link("APPROVAL")}. Predecessor handoff: {link("HANDOFF")}.', '',
         'The previous PREP record is completed historical work. Addendum documentation does not authorise implementation. No issue or schedule is a spending/merge lease.', '',
         '| Issue | Outcome | Blocked by |', '| --- | --- | --- |']
for t in tickets:
    lines.append(f'| {link(t["key"])} | {t["title"]} | {", ".join(link(k) for k in t["blocked_by"]) or "None; scope still applies"} |')
lines += ['', '## Proposed dependency overview', '', '```mermaid',
          'flowchart TD',
          '  A[Context clean and human approval] --> B[Bounded SDK access and contract freeze]',
          '  B --> C[Commands, raw evidence, authority and epochs]',
          '  C --> D[Native Pi sessions, scopes and envelopes]',
          '  B --> E[Small orchestrator driver contract]',
          '  D --> F[First frontier driver]',
          '  E --> F',
          '  F --> G[Second driver early and comparable feature]',
          '  G --> H[Selective peer consultation]',
          '  G --> I[Controlled cross-provider failover]',
          '  C --> J[Map, economy, semantic API and cockpit]',
          '  D --> K[Gates, same-session repair and integration]',
          '  H --> L[Full original plus addendum acceptance]',
          '  I --> L', '  J --> L', '  K --> L',
          '  M[Opus M1 immutable handoff] --> N[History and behaviour reuse]',
          '  N --> O[Full outcome closure]', '  L --> O', '```', '',
          'The native issue graph is authoritative; this overview omits edges for readability. A first and second driver describe proving order, not a mandatory Fable-first implementation dependency. See [build-plan.md](build-plan.md), [coverage.md](coverage.md), and [approval-packet.md](approval-packet.md).', '']
(root/'docs/map.md').write_text('\n'.join(lines))

out = ['# Full design and addendum coverage', '',
       'All 39 original sections and all 29 addendum sections remain in scope. The addendum overrides conflicting Fable-only architecture. This maps requirements to proposed evidence owners; it does not claim implementation or successful provider access.', '']
for label, source, mapping, count in [('Original', 'design-original.md', 'original-coverage.json', 39),
                                       ('Addendum', 'design-addendum.md', 'addendum-coverage.json', 29)]:
    coverage = json.loads((root/'docs'/mapping).read_text())
    assert set(coverage) == set(map(str, range(1, count+1)))
    titles = {}
    for n,title in re.findall(r'^(\d+)\. (.+)$',(root/'docs'/source).read_text(),re.M):
        titles.setdefault(n,title)
    out += [f'## {label}', '', '| Source section | Proposed evidence owners | Status |', '| --- | --- | --- |']
    for n in range(1,count+1):
        keys = coverage[str(n)]
        out.append(f'| {label[0]}{n}. {titles[str(n)]} | {", ".join(link(k) for k in keys)} | Proposed / unbuilt |')
    out += ['']
out += ['## Interpretation and authority', '',
        '- Fable and Astra are alternative first-class orchestrators over the same Helm domain API; Pi remains the native worker runtime. There is one mutating owner per run, with epoch fencing distinct from Autonomy Leases.',
        '- The human authorised a separate private preparation repository while Opus finishes Milestone 1. IMPORT must preserve predecessor history/provenance through an explicitly selected transition; no handoff or migration completion is presumed.',
        '- Raw execution artifacts support forensic inspection and index reconstruction. Durable orchestration decisions remain authoritative Log records; Pi-only events cannot reconstruct missing decisions.',
        '- Original section 35 and addendum section 27 are required acceptance, supplemented by all 23 invariants. Claims, mock/injected faults, local SDK observations and live-provider evidence remain distinct.',
        '', 'See the [combined Brief](design-source.md), [protocol](protocol.md) and [acceptance requirements](acceptance.md).', '']
(root/'docs/coverage.md').write_text('\n'.join(out))
print(f'Rendered {len(tickets)} Map issues and 68 source-section mappings')
