/** Restart-safe event consumers and the daemon ticker. */
import type { EventRow, Store } from './types.js';

export function consumer(store: Store, name: string, fn: (events: EventRow[]) => unknown | Promise<unknown>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    if (running) return running;
    running = (async () => {
      const events = store.listAllEvents({ afterSeq: store.getCursor(name) });
      if (!events.length) return;
      await fn(events);
      store.setCursor(name, events[events.length - 1]!.seq);
    })().finally(() => { running = undefined; });
    return running;
  };
}

export type TickerStop = (() => void) & { tick: () => Promise<void> };

export function startTicker(ms: number, fns: readonly (() => unknown | Promise<unknown>)[]): TickerStop {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return running;
    running = Promise.all(fns.map((fn) => fn())).then(() => undefined).finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void tick().catch((err) => console.error(err)); }, ms);
  const stop = (() => clearInterval(timer)) as TickerStop;
  stop.tick = tick;
  return stop;
}
