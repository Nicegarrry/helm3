import type { GitHub, PrRow, Store } from './types.js';

const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_PER_TICK = 10;
const MAX_ERROR_BACKOFF_MS = 60 * 60_000;

export function inferPrIssue(store: Store, workerId: string, body: string): void {
  if (store.getMeta(workerId)?.issue != null) return;
  const match = body.match(/\b(?:closes|fixes|resolves)\s+#([1-9]\d*)\b/i);
  if (match) store.setMeta(workerId, { issue: Number(match[1]) });
}

/** Shared with pr.merge so in-flight observations cannot record a merge twice. */
export function recordPrMerge(store: Store, pr: PrRow, data: Record<string, unknown>, at?: string): void {
  const seen = store.sql.prepare("SELECT 1 FROM events WHERE kind='pr.merged' AND json_extract(data,'$.project')=? AND json_extract(data,'$.number')=? LIMIT 1").get(pr.repoSlug, pr.number);
  if (!seen) store.appendEvent(pr.workerId, 'pr.merged', { ...data, project: pr.repoSlug, number: pr.number, url: pr.url, head: pr.head }, at);
}

/** Polls a bounded oldest-first slice of Helm-owned PR rows for external state changes. */
export function createPrTicker(options: { store: Store; github: GitHub; now?: () => Date }): () => Promise<void> {
  const now = options.now ?? (() => new Date());
  const errors = new Map<string, { retryAt: number; attempt: number }>();
  const reconciled = new Map<string, number>();

  return async () => {
    const current = now().getTime();
    for (const repoSlug of new Set(options.store.listWorkers().map((worker) => worker.repoSlug))) {
      if (!options.github.listWorkerPrs || current - (reconciled.get(repoSlug) ?? -Infinity) < POLL_INTERVAL_MS) continue;
      reconciled.set(repoSlug, current);
      try {
        const since = new Date(current - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
        for (const remote of await options.github.listWorkerPrs(repoSlug, since)) {
          const workerId = remote.headRefName.match(/^helm\/(w-[\w-]+)$/)?.[1];
          if (!workerId || options.store.getWorker(workerId)?.repoSlug !== repoSlug || !['OPEN', 'MERGED'].includes(remote.state)) continue;
          inferPrIssue(options.store, workerId, remote.body);
          const existing = options.store.getPrByNumber(repoSlug, remote.number);
          const pr: PrRow = { repoSlug, number: remote.number, workerId, url: `https://github.com/${repoSlug}/pull/${remote.number}`, head: remote.headRefOid, createdAt: existing?.createdAt ?? now().toISOString(), state: remote.state === 'MERGED' ? 'merged' : 'open', checkedAt: existing?.checkedAt ?? null };
          if (!existing) options.store.insertPr(pr);
          if (pr.state === 'merged' && (!existing || (existing.state && existing.state !== 'merged'))) {
            recordPrMerge(options.store, pr, { external: true, adopted: !existing }, remote.mergedAt ?? undefined);
          }
          if (!existing || existing.state !== 'merged') options.store.updatePr(pr);
        }
      } catch { /* Keep polling known PRs if discovery is unavailable. Retry next interval. */ }
    }
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
      inferPrIssue(options.store, pr.workerId, status.body ?? '');
      // Rows with no state are legacy rows: establish a baseline silently on first observation.
      if (pr.state === 'open' && nextState !== 'open') {
        if (options.store.getPrByNumber(pr.repoSlug, pr.number)?.state !== 'open') continue;
        const data = {
          project: pr.repoSlug,
          number: pr.number,
          url: updated.url,
          head: updated.head,
          external: true,
          ...(status.title ? { title: status.title } : {}),
          ...(status.base ? { base: status.base } : {}),
        };
        if (nextState === 'merged') recordPrMerge(options.store, updated, data);
        else options.store.appendEvent(pr.workerId, 'pr.closed', data);
      }
      options.store.updatePr(updated);
    }
  };
}
