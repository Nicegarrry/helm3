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
  options.store.sql.exec('CREATE TABLE IF NOT EXISTS routing_checks (id INTEGER PRIMARY KEY CHECK (id = 1), checkedAt TEXT NOT NULL, report TEXT NOT NULL, staleSignature TEXT, staleEventAt TEXT)');
  for (const column of ['staleSignature TEXT', 'staleEventAt TEXT']) {
    try { options.store.sql.exec(`ALTER TABLE routing_checks ADD COLUMN ${column}`); } catch { /* existing schema already has the column */ }
  }
  const last = options.store.sql.prepare('SELECT checkedAt, report, staleSignature, staleEventAt FROM routing_checks WHERE id = 1');
  const save = options.store.sql.prepare('INSERT INTO routing_checks (id, checkedAt, report, staleSignature, staleEventAt) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET checkedAt = excluded.checkedAt, report = excluded.report, staleSignature = excluded.staleSignature, staleEventAt = excluded.staleEventAt');
  let activeCheck: Promise<{ ok: true; report: RoutingCheckReport }> | undefined;

  function staleSignature(report: RoutingCheckReport): string {
    return JSON.stringify({
      unavailable: [...(report.unavailable ?? [])].sort((a, b) => `${a.model}:${a.reason}`.localeCompare(`${b.model}:${b.reason}`)),
      extraModels: [...(report.extraModels ?? [])].sort((a, b) => `${a.lane}:${a.model}`.localeCompare(`${b.lane}:${b.model}`)),
    });
  }

  function summary(report: RoutingCheckReport): string {
    const unavailable = report.unavailable?.map((entry) => `${entry.model} (${entry.reason})`).join(', ');
    const extra = report.extraModels?.map((entry) => entry.model).join(', ');
    const parts = [unavailable ? `unavailable: ${unavailable}` : '', extra ? `new in lanes: ${extra}` : ''].filter(Boolean);
    return parts.join('; ').slice(0, 400);
  }

  async function runCheck(): Promise<{ ok: true; report: RoutingCheckReport }> {
    const report = await catalog.check(currentSettings(), now());
    const previous = last.get() as { report?: string; staleSignature?: string | null; staleEventAt?: string | null } | undefined;
    const signature = staleSignature(report);
    const stale = Boolean(report.unavailable?.length || report.extraModels?.length);
    const previousReport = previous?.report ? JSON.parse(previous.report) as RoutingCheckReport : undefined;
    const changed = signature !== (previous?.staleSignature ?? (previousReport ? staleSignature(previousReport) : undefined));
    const lastEventAt = previous?.staleEventAt ? Date.parse(previous.staleEventAt) : 0;
    const shouldEmit = stale && (changed || now().getTime() - lastEventAt >= 86_400_000);
    const eventAt = shouldEmit ? report.checkedAt : previous?.staleEventAt ?? null;
    save.run(report.checkedAt, JSON.stringify(report), stale ? signature : null, eventAt);
    if (shouldEmit) {
      const payload = {
        ...(report.unavailable?.length ? { unavailable: report.unavailable } : {}),
        ...(report.extraModels?.length ? { extraModels: report.extraModels } : {}),
        summary: summary(report),
        checkedAt: report.checkedAt,
      };
      const projects = new Set(options.store.listWorkers().map((worker) => worker.repoSlug));
      if (!projects.size) projects.add('routing');
      for (const project of projects) options.store.appendEvent(`project:${project}`, 'routing.stale', { ...payload, project });
    }
    return { ok: true, report };
  }

  async function check(): Promise<{ ok: true; report: RoutingCheckReport }> {
    if (!activeCheck) activeCheck = runCheck().finally(() => { activeCheck = undefined; });
    return activeCheck;
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
