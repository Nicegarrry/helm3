/** Event-driven Discord milestone delivery. Webhook values never enter Helm events or logs. */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { consumer } from './daemon.js';
import { loadEnvFile } from './settings.js';
import type { EventRow, Store } from './types.js';
import type { Settings } from './settings.js';

type FetchLike = typeof globalThis.fetch;
type Env = Record<string, string | undefined>;

export type DiscordService = Readonly<{
  consume(): Promise<void>;
  tick(): Promise<void>;
  notifyNick(project: string, text: string): Promise<{ ok: true; sent: true } | { ok: false; reason: string }>;
}>;

type Options = Readonly<{
  store: Store;
  settings: Pick<Settings, 'discord'>;
  home?: string;
  env?: Env;
  envFile?: string;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (line: string) => void;
}>;

type Pending = { project: string; lines: string[]; firstAt: number; nextAttemptAt: number; lastSeq: number };
type PostResult = 'sent' | 'drop' | 'retry';

function text(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function milestone(event: EventRow): string | null {
  if (event.kind === 'pr') return `PR opened: #${text(event.data.number, 'unknown')}`;
  if (event.kind === 'pr.merged') return `Merged: #${text(event.data.number, 'unknown')}`;
  if (event.kind === 'watch.alert') return `Stall: ${text(event.data.detail ?? event.data.rule, 'watch alert')}`;
  if (event.kind === 'spend.warning') return `Spend 80%: ${text(event.data.spendUsd, 'threshold reached')}`;
  if (event.kind === 'inbox.triage' && event.data.route === 'needs_human') return `Needs Nick: ${text(event.data.question, 'human decision needed')}`;
  if (event.kind === 'state' && (event.data.to === 'failed' || event.data.to === 'unknown')) return `Worker failed: ${text(event.data.to, 'unknown')}`;
  if (event.kind === 'envelope.changed') return `Envelope changed: ${text(event.data.project, 'project')}`;
  return null;
}

export function createDiscord(options: Options): DiscordService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const env = { ...loadEnvFile(options.envFile ?? join(homedir(), '.config', 'helm', 'env')), ...process.env, ...(options.env ?? {}) };
  const sent = new Map<string, number[]>();
  const muted = new Map<string, number>();
  const nickAt = new Map<string, number>();
  const log = options.log ?? ((line: string) => {
      try { appendFileSync(join(options.home ?? process.env.HELM_HOME ?? join(homedir(), '.helm'), 'daemon.log'), `${line}\n`); } catch { /* logging must not break the daemon */ }
  });

  function webhook(project: string): string | undefined {
    const name = options.settings.discord.projects[project]?.webhookEnv;
    return name ? env[name] : undefined;
  }

  options.store.sql.exec(`
    CREATE TABLE IF NOT EXISTS discord_pending (
      project TEXT PRIMARY KEY,
      lines TEXT NOT NULL,
      firstAt INTEGER NOT NULL,
      nextAttemptAt INTEGER NOT NULL,
      lastSeq INTEGER NOT NULL
    )
  `);
  const getPendingStmt = options.store.sql.prepare('SELECT * FROM discord_pending WHERE project = ?');
  const upsertPendingStmt = options.store.sql.prepare(`
    INSERT INTO discord_pending (project, lines, firstAt, nextAttemptAt, lastSeq) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET lines = excluded.lines, lastSeq = excluded.lastSeq
  `);
  const listPendingStmt = options.store.sql.prepare('SELECT * FROM discord_pending ORDER BY firstAt ASC, project ASC');
  const deletePendingStmt = options.store.sql.prepare('DELETE FROM discord_pending WHERE project = ?');
  const retryPendingStmt = options.store.sql.prepare('UPDATE discord_pending SET nextAttemptAt = ? WHERE project = ?');

  async function post(project: string, content: string): Promise<PostResult> {
    const url = webhook(project);
    if (!url) return 'drop';
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 2000), username: 'Helm', allowed_mentions: { parse: [] } }),
      });
      if (response.status >= 200 && response.status < 300) return 'sent';
      log(`daemon.log: Discord post failed for ${project} (HTTP ${response.status})`);
      return response.status === 429 || response.status >= 500 ? 'retry' : 'drop';
    } catch {
      log(`daemon.log: Discord post failed for ${project}`);
      return 'retry';
    }
  }

  const consume = consumer(options.store, 'discord', (events) => {
    for (const event of events) {
      const line = milestone(event);
      if (!line) continue;
      const worker = options.store.getWorker(event.workerId);
      const project = text(event.data.project ?? worker?.repoSlug, 'unknown');
      const existing = getPendingStmt.get(project) as Record<string, unknown> | undefined;
      const lastSeq = Number(existing?.lastSeq ?? 0);
      if (event.seq <= lastSeq) continue;
      const lines = existing ? JSON.parse(String(existing.lines)) as string[] : [];
      lines.push(line);
      upsertPendingStmt.run(project, JSON.stringify(lines), Number(existing?.firstAt ?? now().getTime()), Number(existing?.nextAttemptAt ?? 0), event.seq);
    }
  });

  async function flush(row: Pending): Promise<void> {
    const project = row.project;
    const configured = options.settings.discord.projects[project];
    if (!configured || !webhook(project)) { deletePendingStmt.run(project); return; }
    const current = now().getTime();
    if (current < row.nextAttemptAt || current - row.firstAt < options.settings.discord.digestSec * 1000) return;
    const hourAgo = current - 60 * 60_000;
    const times = (sent.get(project) ?? []).filter((at) => at > hourAgo);
    sent.set(project, times);
    const max = options.settings.discord.maxPerHour;
    if (times.length >= max) {
      if (muted.has(project) && muted.get(project)! > hourAgo) { deletePendingStmt.run(project); return; }
      const oldest = times[0] ?? current;
      const minutes = Math.max(1, Math.ceil((oldest + 60 * 60_000 - current) / 60_000));
      const result = await post(project, `muted for ${minutes} min`);
      if (result === 'sent' || result === 'drop') {
        muted.set(project, current);
        deletePendingStmt.run(project);
      } else {
        retryPendingStmt.run(current + options.settings.discord.digestSec * 1000, project);
      }
      return;
    }
    const result = await post(project, row.lines.join('\n'));
    if (result === 'sent' || result === 'drop') {
      sent.set(project, [...times, current]);
      deletePendingStmt.run(project);
    } else {
      retryPendingStmt.run(current + options.settings.discord.digestSec * 1000, project);
    }
  }

  async function notifyNick(project: string, content: string): Promise<{ ok: true; sent: true } | { ok: false; reason: string }> {
    const url = webhook(project);
    if (!url) return { ok: false, reason: 'no webhook configured' };
    const current = now().getTime();
    const previous = nickAt.get(project);
    if (previous !== undefined && current - previous < 60_000) return { ok: false, reason: 'notify.nick is rate-limited to once per minute' };
    const result = await post(project, content.slice(0, 2000));
    if (result !== 'sent') return { ok: false, reason: 'Discord post failed' };
    nickAt.set(project, current);
    sent.set(project, [...(sent.get(project) ?? []).filter((at) => at > current - 60 * 60_000), current]);
    return { ok: true, sent: true };
  }

  return {
    consume,
    async tick() {
      await consume();
      const rows = listPendingStmt.all() as Array<Record<string, unknown>>;
      for (const row of rows) await flush({
        project: String(row.project), lines: JSON.parse(String(row.lines)) as string[], firstAt: Number(row.firstAt),
        nextAttemptAt: Number(row.nextAttemptAt), lastSeq: Number(row.lastSeq),
      });
    },
    notifyNick,
  };
}
