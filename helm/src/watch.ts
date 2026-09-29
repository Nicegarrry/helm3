/** Event-driven worker watch rules, including Jev attention checks. */
import { consumer } from './daemon.js';
import type { Jev } from './jev.js';
import type { Settings } from './settings.js';
import type { EventRow, Store, WorkerRow } from './types.js';

export type WatchOptions = Readonly<{
  store: Store;
  settings: Pick<Settings, 'watch'> & Partial<Pick<Settings, 'jev'>>;
  jev?: Jev;
  now?: () => Date;
}>;

export type AttentionFacts = Readonly<{
  runAgeMinutes: number;
  minutesSinceLastEditCommitOrTest: number | null;
  refusals: number;
  highestRefusalReasonCount: number;
  edits: number;
}>;

function eventTime(event: EventRow): number {
  const time = Date.parse(event.at);
  return Number.isFinite(time) ? time : 0;
}

function refusalReason(event: EventRow): string {
  const reason = event.data.reason;
  return typeof reason === 'string' ? reason : JSON.stringify(reason ?? 'unknown');
}

function clean(value: unknown, worktree: string): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.replaceAll(worktree, '<worktree>').replaceAll(/\s+/g, ' ').trim();
}

/** Compact the watcher window into stable, one-line, worktree-free event summaries. */
export function compactEvents(events: readonly EventRow[], worktree: string): string[] {
  return events.map((event) => {
    if (event.kind === 'tool.call') return `call ${clean(event.data.tool ?? 'unknown', worktree)}: ${clean(event.data.summary ?? '', worktree)}`;
    if (event.kind === 'tool.refused') return `REFUSED ${clean(event.data.tool ?? 'unknown', worktree)}: ${clean(event.data.reason ?? 'unknown', worktree)}`;
    if (event.kind === 'state') return `state ${clean(event.data.from ?? '?', worktree)}->${clean(event.data.to ?? '?', worktree)}`;
    if (event.kind === 'notice') return `notice: ${clean(event.data.message ?? '', worktree)}`;
    const detail = event.data.message ?? event.data.summary ?? event.data.reason ?? event.data;
    return `${event.kind}: ${clean(detail, worktree)}`;
  });
}

function isEdit(event: EventRow): boolean {
  if (event.kind !== 'tool.call') return false;
  const tool = String(event.data.tool ?? '').toLowerCase();
  return tool === 'edit' || tool === 'write' || tool === 'patch' || tool.includes('edit');
}

function isCommitOrTest(event: EventRow): boolean {
  if (event.kind !== 'tool.call') return false;
  const text = `${String(event.data.tool ?? '')} ${String(event.data.summary ?? '')}`.toLowerCase();
  return /\b(git commit|npm test|pnpm test|yarn test|bun test|pytest|typecheck|test suite)\b/.test(text);
}

function attentionFacts(events: readonly EventRow[], nowMs: number, start: EventRow): AttentionFacts {
  const window = events.slice(-30);
  const refusals = window.filter((event) => event.kind === 'tool.refused');
  const byReason = new Map<string, number>();
  for (const refusal of refusals) byReason.set(refusalReason(refusal), (byReason.get(refusalReason(refusal)) ?? 0) + 1);
  const edits = window.filter(isEdit);
  const meaningful = window.filter((event) => isEdit(event) || isCommitOrTest(event));
  const last = meaningful.at(-1);
  return {
    runAgeMinutes: Math.max(0, Math.floor((nowMs - eventTime(start)) / 60_000)),
    minutesSinceLastEditCommitOrTest: last ? Math.max(0, Math.floor((nowMs - eventTime(last)) / 60_000)) : null,
    refusals: refusals.length,
    highestRefusalReasonCount: Math.max(0, ...byReason.values()),
    edits: edits.length,
  };
}

function factsLine(facts: AttentionFacts): string {
  return `run age: ${facts.runAgeMinutes}m; minutes since last edit, commit or test: ${facts.minutesSinceLastEditCommitOrTest ?? 'never'}; refusals in window: ${facts.refusals}; highest refusal reason count: ${facts.highestRefusalReasonCount}; edits in window: ${facts.edits}`;
}

/** Create the daemon-tick function for A6a's event-driven and silence rules. */
export function createWatcher({ store, settings, jev, now = () => new Date() }: WatchOptions): () => Promise<void> {
  const lastAttentionAt = new Map<string, number>();
  const lastAttentionSeq = new Map<string, number>();
  const consume = consumer(store, 'watch', (events) => {
    for (const event of events) processEvent(event);
  });
  function alert(event: EventRow, rule: string, detail: Record<string, unknown>): void {
    const current = now();
    const at = current.getTime();
    const cooldownMs = settings.watch.cooldownMin * 60_000;
    const previous = store.listEvents(event.workerId).reverse().find((candidate) =>
      candidate.kind === 'watch.alert' && candidate.data.rule === rule);
    if (previous && at - eventTime(previous) < cooldownMs) return;
    store.appendEvent(event.workerId, 'watch.alert', { rule, detail }, current.toISOString());
  }

  function processEvent(event: EventRow): void {
    if (event.kind === 'spend.warning' || event.kind === 'error' || event.kind === 'result.invalid') {
      alert(event, event.kind, event.data);
      return;
    }
    if (event.kind !== 'tool.refused') return;

    const events = store.listEvents(event.workerId);
    const start = [...events].reverse().find((candidate) => candidate.kind === 'turn.start' && candidate.seq <= event.seq)?.seq ?? 0;
    const reason = refusalReason(event);
    const count = events.filter((candidate) => candidate.seq > start && candidate.seq <= event.seq && candidate.kind === 'tool.refused' && refusalReason(candidate) === reason).length;
    if (count >= settings.watch.sameRefusal) alert(event, 'refusal.loop', { reason, count });
  }

  function silence(worker: WorkerRow): void {
    // A future A5a state is intentionally compared as a string until that contract lands.
    if (String(worker.state) !== 'running' || String(worker.state) === 'waiting') return;
    const events = store.listEvents(worker.workerId);
    const latestStart = [...events].reverse().find((event) => event.kind === 'turn.start');
    const startSeq = latestStart?.seq ?? 0;
    const silenceAlert = [...events].reverse().find((event) =>
      event.kind === 'watch.alert' && event.data.rule === 'silence' && event.seq > startSeq);
    if (silenceAlert) return;
    const last = events.at(-1);
    const elapsed = now().getTime() - (last ? eventTime(last) : Date.parse(worker.updatedAt));
    if (elapsed < settings.watch.silenceMin * 60_000) return;
    const synthetic = last ?? { seq: startSeq, workerId: worker.workerId, at: worker.updatedAt, kind: 'state', data: {} };
    alert(synthetic, 'silence', { silenceMin: settings.watch.silenceMin, elapsedMs: elapsed });
  }

  async function checkAttention(): Promise<void> {
    if (!jev) return;
    const current = now();
    const currentMs = current.getTime();
    for (const worker of store.listWorkers({ state: 'running' })) {
      const events = store.listEvents(worker.workerId);
      const start = [...events].reverse().find((event) => event.kind === 'turn.start');
      if (!start) continue;
      const sinceStart = events.filter((event) => event.seq > start.seq);
      if (sinceStart.filter((event) => event.kind === 'tool.call').length < 8) continue;
      const newestSeq = events.at(-1)?.seq ?? 0;
      if (newestSeq <= (lastAttentionSeq.get(worker.workerId) ?? 0)) continue;
      const previous = lastAttentionAt.get(worker.workerId);
      if (previous !== undefined && currentMs - previous < settings.watch.attentionEverySec * 1000) continue;

      const window = events.slice(-30);
      const facts = attentionFacts(events, currentMs, start);
      const result = await jev.ask('attention', {
        workerId: worker.workerId,
        project: worker.repoSlug,
        state: {
          events: compactEvents(window, worker.worktree),
          facts: factsLine(facts),
          policy: 'Helm blocks gh, git worktree/checkout and paths outside the worktree; reviewers are read-only; occasional single refusals are normal.',
        },
        questions: {
          attention: {
            type: 'noul',
            instructions: 'Does this worker need its supervisor to intervene now?',
            criteria: {
              true: 'stuck, looping, blocked by policy, off-task, destructive, or heading toward failure',
              false: 'routine progress: reading, editing, testing, committing',
            },
          },
        },
      });
      lastAttentionAt.set(worker.workerId, currentMs);
      lastAttentionSeq.set(worker.workerId, newestSeq);
      if (!result.ok) continue;
      const answer = result.answers.attention;
      if (answer?.noul !== true || typeof answer.confidence !== 'number' || answer.confidence < (settings.jev?.attentionAt ?? 0.4)) continue;
      const detail = { rule: 'jev.attention', attention: answer.confidence };
      store.appendEvent(worker.workerId, jev.shadow ? 'watch.shadow' : 'watch.alert', detail, current.toISOString());
    }
  }

  return async function tick(): Promise<void> {
    await consume();
    for (const worker of store.listWorkers()) silence(worker);
    await checkAttention();
  };
}
