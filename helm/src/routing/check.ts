import { loadSettings, type Settings } from '../settings.js';
import type { Store } from '../types.js';
import { createModelCatalog, type CatalogProbe, type ModelCatalog, type RoutingCheckReport } from './catalog.js';

export type RoutingCheckService = Readonly<{
  check(): Promise<{ ok: true; report: RoutingCheckReport }>;
  tick(): Promise<void>;
}>;

export function createRoutingCheck(options: { store: Store; settings: Settings; settingsHome?: string; now?: () => Date; catalog?: ModelCatalog; probe?: CatalogProbe; claudeLaneRegistered?: boolean }): RoutingCheckService {
  const now = options.now ?? (() => new Date());
  const currentSettings = () => options.settingsHome ? loadSettings(options.settingsHome) : options.settings;
  const catalog = options.catalog ?? createModelCatalog({ getSettings: currentSettings, probe: options.probe, claudeLaneRegistered: options.claudeLaneRegistered });
  options.store.sql.exec('CREATE TABLE IF NOT EXISTS routing_checks (id INTEGER PRIMARY KEY CHECK (id = 1), checkedAt TEXT NOT NULL, report TEXT NOT NULL)');
  const last = options.store.sql.prepare('SELECT checkedAt FROM routing_checks WHERE id = 1');
  const save = options.store.sql.prepare('INSERT INTO routing_checks (id, checkedAt, report) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET checkedAt = excluded.checkedAt, report = excluded.report');

  async function check(): Promise<{ ok: true; report: RoutingCheckReport }> {
    const report = await catalog.check(currentSettings(), now());
    save.run(report.checkedAt, JSON.stringify(report));
    if (report.unavailable?.length || report.extraModels?.length) {
      const payload = {
        ...(report.unavailable?.length ? { unavailable: report.unavailable } : {}),
        ...(report.extraModels?.length ? { extraModels: report.extraModels } : {}),
        summary: `${report.unavailable?.length ?? 0} unavailable tier candidate(s); ${report.extraModels?.length ?? 0} unlisted lane model(s)`,
        checkedAt: report.checkedAt,
      };
      const projects = new Set(options.store.listWorkers().map((worker) => worker.repoSlug));
      if (!projects.size) projects.add('routing');
      for (const project of projects) options.store.appendEvent(`project:${project}`, 'routing.stale', { ...payload, project });
    }
    return { ok: true, report };
  }

  return {
    check,
    async tick() {
      const checkedAt = (last.get() as { checkedAt?: string } | undefined)?.checkedAt;
      const days = currentSettings().routing.checkDays ?? 7;
      if (!checkedAt || now().getTime() - Date.parse(checkedAt) >= days * 86_400_000) await check();
    },
  };
}
