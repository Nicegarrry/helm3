/** Code-only worker watch rules. Jev attention is deliberately out of scope. */
import { consumer } from './daemon.js';
import type { Settings } from './settings.js';
import type { EventRow, Store, WorkerRow } from './types.js';

export type WatchOptions = Readonly<{
  store: Store;
  settings: Pick<Settings, 'watch'>;
  now?: () => Date;
}>;

function eventTime(event: EventRow): number {
  const time = Date.parse(event.at);
  return Number.isFinite(time) ? time : 0;
}

function refusalReason(event: EventRow): string {
  const reason = event.data.reason;
  return typeof reason === 'string' ? reason : JSON.stringify(reason ?? 'unknown');
}

/** Create the daemon-tick function for A6a's event-driven and silence rules. */
export function createWatcher({ store, settings, now = () => new Date() }: WatchOptions): () => Promise<void> {
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

  return async function tick(): Promise<void> {
    await consume();
    for (const worker of store.listWorkers()) silence(worker);
  };
}
