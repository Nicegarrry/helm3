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
  postTap(text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
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

function processAlertText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'process headroom is low';
  const detail = value as { headroomPct?: unknown; topProcesses?: unknown };
  const names = Array.isArray(detail.topProcesses)
    ? detail.topProcesses.map((item) => item && typeof item === 'object' ? `${String((item as { name?: unknown }).name ?? 'unknown')} (${String((item as { count?: unknown }).count ?? 0)})` : '').filter(Boolean).slice(0, 3).join(', ')
    : '';
  const headroom = typeof detail.headroomPct === 'number' ? ` (${(detail.headroomPct * 100).toFixed(1)}% headroom)` : '';
  return `${names || 'process headroom is low'}${headroom}`;
}

function spendStartupLine(data: EventRow['data']): string {
  const values = data.values && typeof data.values === 'object' ? data.values as Record<string, unknown> : {};
  const cap = values.capUsd === 0 ? 'NO spend cap' : `spend cap $${text(values.capUsd, 'unknown')}`;
  return `Helm started: ${cap}, warn $${text(values.warnUsd, 'unknown')}, max workers ${text(values.maxWorkers, 'unknown')}${data.tampered ? ' (tampered)' : ''}`;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function milestone(event: EventRow, projectCount: number): string | null {
  const project = optional(event.data.project);
  const prefix = projectCount > 1 && project ? `${project} ` : '';
  if (event.kind === 'dispatched') {
    const issue = optional(event.data.issue);
    if (!issue) return null;
    const title = optional(event.data.title) ?? 'untitled issue';
    const model = optional(event.data.model) ?? 'unknown model';
    const tier = optional(event.data.tier) ?? 'unknown';
    return `Dispatched ${text(event.workerId, 'unknown')} on #${issue} ${title} (${model}, tier ${tier})`;
  }
  if (event.kind === 'pr') {
    const title = optional(event.data.title);
    const url = optional(event.data.url);
    const updated = event.data.updated === true ? 'PR updated' : '';
    return `${updated ? `${updated}: ` : ''}${prefix}#${text(event.data.number, 'unknown')}${title ? ` ${title}` : ''}${url ? ` ${url}` : ''}`;
  }
  if (event.kind === 'pr.merged') {
    const title = optional(event.data.title);
    const base = optional(event.data.base);
    const url = optional(event.data.url);
    return `${prefix}#${text(event.data.number, 'unknown')}${title ? ` ${title}` : ''} merged into ${base ?? 'unknown'}${url ? ` ${url}` : ''}`;
  }
  if (event.kind === 'pr.closed') return `${prefix}#${text(event.data.number, 'unknown')} closed${optional(event.data.url) ? ` ${optional(event.data.url)}` : ''}`;
  if (event.kind === 'watch.alert') return event.data.rule === 'procs.low'
    ? `Process headroom low: ${processAlertText(event.data.detail)}`
    : `Stall: ${text(event.data.detail ?? event.data.rule, 'watch alert')}`;
  if (event.kind === 'spend.warning') return `Spend 80%: ${text(event.data.spendUsd, 'threshold reached')}`;
  if (event.kind === 'capacity.waiting') {
    const waited = Math.max(0, Math.round(Number(event.data.waitedMs ?? 0) / 60_000));
    return `Waiting for capacity: ${text(event.data.kind, 'job')} ${text(event.data.loadClass, 'unknown')}, ${waited} min`;
  }
  if (event.kind === 'spend.invalid') return 'helm.json invalid; keeping last good limits';
  if (event.kind === 'spend.changed') {
    if (event.data.source === 'startup') return spendStartupLine(event.data);
    const values = event.data.values && typeof event.data.values === 'object' ? Object.entries(event.data.values).map(([name, value]) => `${name}=${String(value)}`).join(', ') : '';
    return `Spend changed: ${event.data.ignored ? 'raise ignored' : text(event.data.source, 'updated')}${values ? `: ${values}` : ''}`;
  }
  if (event.kind === 'inbox.triage' && event.data.route === 'needs_human') return `Needs Nick: ${text(event.data.question, 'human decision needed')}`;
  if (event.kind === 'state' && (event.data.to === 'failed' || event.data.to === 'unknown')) return `Worker failed: ${text(event.data.to, 'unknown')}`;
  if (event.kind === 'envelope.changed') return `Envelope changed: ${text(event.data.project, 'project')}`;
  if (event.kind === 'gate.sandbox.opt_out') return `Gate sandbox disabled: ${text(event.data.project, 'project')} (${text(event.data.reason, 'repo opt-out')})`;
  if (event.kind === 'gate.unsandboxed') return `Gate ran unsandboxed: ${text(event.data.project, 'project')} (${text(event.data.reason, 'sandbox failure')})`;
  if (event.kind === 'gate' && event.data.configFallback === true) return `${prefix}Gate ${event.data.passed === true ? 'passed' : 'failed'} on fallback config branch ${text(event.data.configBranch, 'unknown')}`;
  if (event.kind === 'deploy' || event.kind === 'deploy.rolledback' || event.kind === 'deploy.failed') {
    const state = event.kind === 'deploy' ? 'Deployed' : event.kind === 'deploy.rolledback' ? 'Deploy rolled back' : 'Deploy failed';
    const details = [event.data.env, event.data.sha, event.data.url, event.data.pr ? `PR #${event.data.pr}` : undefined, event.data.issue ? `issue #${event.data.issue}` : undefined]
      .map(optional).filter((value): value is string => Boolean(value)).join(' ');
    return `${state}: ${text(event.data.target, 'target')}${details ? ` ${details}` : ''}`;
  }
  if (event.kind === 'routing.stale') return `Routing catalog stale: ${text(event.data.summary, 'check routing candidates')}`;
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
    const global = globalWebhooks().find((route) => route.project === project)?.url;
    if (global) return global;
    const name = options.settings.discord.projects[project]?.webhookEnv;
    return name ? env[name] : undefined;
  }

  function tapWebhook(): string | undefined {
    const name = options.settings.discord.tapWebhookEnv;
    return name ? env[name] : undefined;
  }

  function configuredGlobalWebhook(): string | undefined {
    const name = options.settings.discord.globalWebhookEnv;
    return name ? env[name] : undefined;
  }

  function globalWebhooks(): Array<{ project: string; url: string }> {
    const tap = normalizeWebhook(tapWebhook());
    const global = configuredGlobalWebhook();
    if (global) return normalizeWebhook(global) !== tap ? [{ project: 'global', url: global }] : [];
    const routes = new Map<string, { project: string; url: string }>();
    for (const [project, configured] of Object.entries(options.settings.discord.projects)) {
      const url = env[configured.webhookEnv];
      const normalized = normalizeWebhook(url);
      if (url && normalized && normalized !== tap && !routes.has(normalized)) routes.set(normalized, { project: `global:${normalized}`, url });
    }
    return [...routes.values()];
  }

  function isMilestoneWebhook(url: string): boolean {
    const normalized = normalizeWebhook(url);
    return [...Object.values(options.settings.discord.projects).map((project) => env[project.webhookEnv]), configuredGlobalWebhook()]
      .some((milestoneUrl) => normalizeWebhook(milestoneUrl) === normalized);
  }

  function normalizeWebhook(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      const parsed = new URL(url);
      const webhook = /^\/api\/(?:v\d+\/)?webhooks\/([^/]+)\/([^/]+)\/?$/i.exec(parsed.pathname);
      if (webhook && ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(parsed.hostname.toLowerCase())) {
        return `discord-webhook:${webhook[1]}/${webhook[2]}`;
      }
      const path = parsed.pathname.replace(/\/+$/, '') || '/';
      return `${parsed.host.toLowerCase()}${path}`;
    } catch {
      return url.toLowerCase().replace(/\/+$/, '');
    }
  }

  async function postTap(content: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const url = tapWebhook();
    if (!url) return { ok: false, reason: 'no tap channel configured' };
    if (isMilestoneWebhook(url)) return { ok: false, reason: 'tap channel must differ from the milestone channel' };
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, username: 'Helm', allowed_mentions: { parse: [] } }) });
      if (response.status >= 200 && response.status < 300) return { ok: true };
      log('daemon.log: tap Discord post failed');
      return { ok: false, reason: 'tap channel post failed' };
    } catch {
      log('daemon.log: tap Discord post failed');
      return { ok: false, reason: 'tap channel post failed' };
    }
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
      let milestoneEvent = event;
      if (event.kind === 'deploy' || event.kind === 'deploy.rolledback' || event.kind === 'deploy.failed') {
        try {
          const id = optional(event.data.id);
          const deployment = id ? options.store.sql.prepare('SELECT env, sha, url FROM deploys WHERE id = ?').get(id) as Record<string, unknown> | undefined : undefined;
          if (deployment) {
            const sha = optional(deployment.sha);
            const project = optional(event.data.project);
            const pr = sha && project ? options.store.listPrs().find((candidate) => candidate.repoSlug === project && candidate.head === deployment.sha) : undefined;
            const issue = pr ? options.store.getMeta(pr.workerId)?.issue : undefined;
            milestoneEvent = { ...event, data: {
              ...event.data,
              ...(deployment.env !== undefined ? { env: deployment.env } : {}),
              ...(sha ? { sha: sha.slice(0, 7) } : {}),
              ...(deployment.url ? { url: deployment.url } : {}),
              ...(pr ? { pr: pr.number } : {}),
              ...(issue !== undefined && issue !== null ? { issue } : {}),
            } };
          }
        } catch { /* deployment enrichment is best effort */ }
      }
      const line = milestone(milestoneEvent, Object.keys(options.settings.discord.projects).length);
      if (!line) continue;
      const worker = options.store.getWorker(event.workerId);
      const project = text(event.data.project ?? worker?.repoSlug, 'unknown');
      const destinations = event.workerId === 'project:global' || project === 'global' ? globalWebhooks() : [{ project, url: webhook(project) ?? '' }];
      for (const destination of destinations) {
        const target = destination.project;
        const existing = getPendingStmt.get(target) as Record<string, unknown> | undefined;
        const lastSeq = Number(existing?.lastSeq ?? 0);
        if (event.seq <= lastSeq) continue;
        const lines = existing ? JSON.parse(String(existing.lines)) as string[] : [];
        lines.push(line);
        upsertPendingStmt.run(target, JSON.stringify(lines), Number(existing?.firstAt ?? now().getTime()), Number(existing?.nextAttemptAt ?? 0), event.seq);
      }
    }
  });

  async function flush(row: Pending): Promise<void> {
    const project = row.project;
    if (!webhook(project)) { deletePendingStmt.run(project); return; }
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
    postTap,
  };
}
