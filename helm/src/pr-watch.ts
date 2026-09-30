import type { GitHub, PrRow, Store } from './types.js';

/** Polls Helm-owned open PR rows for merges/closes that happened outside Helm. */
export function createPrTicker(options: { store: Store; github: GitHub }): () => Promise<void> {
  options.store.sql.exec(`
    CREATE TABLE IF NOT EXISTS pr_external_notifications (
      repoSlug TEXT NOT NULL,
      number INTEGER NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (repoSlug, number, state)
    )
  `);
  const seen = options.store.sql.prepare('SELECT 1 FROM pr_external_notifications WHERE repoSlug = ? AND number = ? AND state = ?');
  const mark = options.store.sql.prepare('INSERT OR IGNORE INTO pr_external_notifications (repoSlug, number, state) VALUES (?, ?, ?)');

  return async () => {
    for (const pr of options.store.listPrs()) {
      const status = await options.github.prStatus(pr.repoSlug, pr.number).catch(() => undefined);
      if (!status || (status.state !== 'merged' && status.state !== 'closed')) continue;
      if (seen.get(pr.repoSlug, pr.number, status.state)) continue;
      const alreadyEmitted = options.store.listAllEvents().some((event) => event.kind === (status.state === 'merged' ? 'pr.merged' : 'pr.closed')
        && event.data.project === pr.repoSlug && event.data.number === pr.number);
      if (alreadyEmitted) { mark.run(pr.repoSlug, pr.number, status.state); continue; }
      mark.run(pr.repoSlug, pr.number, status.state);
      const updated: PrRow = { ...pr, head: status.head || pr.head, url: status.url || pr.url };
      options.store.updatePr(updated);
      options.store.appendEvent(pr.workerId, status.state === 'merged' ? 'pr.merged' : 'pr.closed', {
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
