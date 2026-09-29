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
  notifyNick(project: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
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

type Pending = { project: string; lines: string[]; firstAt: number };

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function milestone(event: EventRow): string | null {
  if (event.kind === 'pr') return `PR opened: #${text(event.data.number, 'unknown')}`;
  if (event.kind === 'pr.merged') return `Merged: #${text(event.data.number, 'unknown')}`;
  if (event.kind === 'watch.alert') return `Stall: ${text(event.data.detail ?? event.data.rule, 'watch alert')}`;
  if (event.kind === 'spend.warning') return `Spend 80%: ${text(event.data.spendUsd, 'threshold reached')}`;
  if (event.kind === 'inbox.triage' && event.data.route === 'needs_human') return `Needs Nick: ${text(event.data.question, 'human decision needed')}`;
  if (event.kind === 'state' && (event.data.to === 'failed' || event.data.to === 'unknown')) return `Worker failed: ${text(event.data.to, 'unknown')}`;
  return null;
}

export function createDiscord(options: Options): DiscordService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const env = { ...loadEnvFile(options.envFile ?? join(homedir(), '.config', 'helm', 'env')), ...process.env, ...(options.env ?? {}) };
  const pending = new Map<string, Pending>();
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

  async function post(project: string, content: string): Promise<boolean> {
    const url = webhook(project);
    if (!url) return false;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, username: 'Helm', allowed_mentions: { parse: [] } }),
      });
      if (!response.ok) {
        log(`daemon.log: Discord post failed for ${project} (HTTP ${response.status})`);
        return false;
      }
      return true;
    } catch {
      log(`daemon.log: Discord post failed for ${project}`);
      return false;
    }
  }

  const consume = consumer(options.store, 'discord', (events) => {
    for (const event of events) {
      const line = milestone(event);
      if (!line) continue;
      const worker = options.store.getWorker(event.workerId);
      const project = text(event.data.project ?? worker?.repoSlug, 'unknown');
      const row = pending.get(project) ?? { project, lines: [], firstAt: now().getTime() };
      row.lines.push(line);
      pending.set(project, row);
    }
  });

  async function flush(project: string, row: Pending): Promise<void> {
    const configured = options.settings.discord.projects[project];
    if (!configured || !webhook(project)) { pending.delete(project); return; }
    const current = now().getTime();
    const hourAgo = current - 60 * 60_000;
    const times = (sent.get(project) ?? []).filter((at) => at > hourAgo);
    sent.set(project, times);
    const max = options.settings.discord.maxPerHour;
    if (times.length >= max) {
      if (muted.has(project) && muted.get(project)! > hourAgo) { pending.delete(project); return; }
      const oldest = times[0] ?? current;
      const minutes = Math.max(1, Math.ceil((oldest + 60 * 60_000 - current) / 60_000));
      if (await post(project, `muted for ${minutes} min`)) {
        muted.set(project, current);
        pending.delete(project);
      }
      return;
    }
    if (await post(project, row.lines.join('\n'))) {
      sent.set(project, [...times, current]);
      pending.delete(project);
    }
  }

  async function notifyNick(project: string, content: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const url = webhook(project);
    if (!url) return { ok: false, reason: 'no webhook configured' };
    const current = now().getTime();
    const previous = nickAt.get(project);
    if (previous !== undefined && current - previous < 60_000) return { ok: false, reason: 'notify.nick is rate-limited to once per minute' };
    if (!(await post(project, content))) return { ok: false, reason: 'Discord post failed' };
    nickAt.set(project, current);
    sent.set(project, [...(sent.get(project) ?? []).filter((at) => at > current - 60 * 60_000), current]);
    return { ok: true };
  }

  return {
    consume,
    async tick() {
      await consume();
      const current = now().getTime();
      for (const [project, row] of pending) {
        if (current - row.firstAt >= options.settings.discord.digestSec * 1000) await flush(project, row);
      }
    },
    notifyNick,
  };
}
