import type { GitHub, PrRow, Store } from './types.js';

const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_PER_TICK = 10;
const MAX_ERROR_BACKOFF_MS = 60 * 60_000;

/** Polls a bounded oldest-first slice of Helm-owned PR rows for external state changes. */
export function createPrTicker(options: { store: Store; github: GitHub; now?: () => Date }): () => Promise<void> {
  const now = options.now ?? (() => new Date());
  const errors = new Map<string, { retryAt: number; attempt: number }>();

  return async () => {
    const current = now().getTime();
    const candidates = options.store.listPrs()
      .filter((pr) => pr.state === null || pr.state === 'open')
      .filter((pr) => pr.checkedAt === null || current - Date.parse(pr.checkedAt) >= POLL_INTERVAL_MS)
      .filter((pr) => current >= (errors.get(`${pr.repoSlug}:${pr.number}`)?.retryAt ?? 0))
      .sort((a, b) => (a.checkedAt ? Date.parse(a.checkedAt) : 0) - (b.checkedAt ? Date.parse(b.checkedAt) : 0))
      .slice(0, MAX_PER_TICK);

    for (const pr of candidates) {
      const key = `${pr.repoSlug}:${pr.number}`;
      let status;
      try {
        status = await options.github.prStatus(pr.repoSlug, pr.number);
      } catch {
        const attempt = (errors.get(key)?.attempt ?? 0) + 1;
        errors.set(key, { retryAt: current + Math.min(MAX_ERROR_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** Math.min(attempt - 1, 7)), attempt });
        options.store.updatePr({ ...pr, checkedAt: now().toISOString() });
        continue;
      }
      errors.delete(key);
      const checkedAt = now().toISOString();
      const nextState = status.state === 'merged' || status.state === 'closed' ? status.state : 'open';
      const updated: PrRow = { ...pr, state: nextState, checkedAt, head: status.head || pr.head, url: status.url || pr.url };
      options.store.updatePr(updated);
      // Rows with no state are legacy rows: establish a baseline silently on first observation.
      if (pr.state !== 'open' || nextState === 'open') continue;
      options.store.appendEvent(pr.workerId, nextState === 'merged' ? 'pr.merged' : 'pr.closed', {
        project: pr.repoSlug,
        number: pr.number,
        url: updated.url,
        head: updated.head,
        external: true,
        ...(status.title ? { title: status.title } : {}),
        ...(status.base ? { base: status.base } : {}),
      });
    }
  };
}
