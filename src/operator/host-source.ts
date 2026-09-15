import type { HostSnapshot } from '../host/index.js';
import type { GitHubMapSnapshot } from '../tracker/index.js';
import { validateOperatorSnapshot } from './projection.js';
import type { LeaseState, OperatorSnapshot, SnapshotSource } from './types.js';

export type HostSnapshotReader = { snapshot(runId: string): Promise<HostSnapshot> };
export type HostSourceOptions = Readonly<{
  host: HostSnapshotReader;
  runId: string;
  /** Explicitly describes execution provenance, independently of durable storage. */
  evidenceMode: 'fixture' | 'authoritative';
  map?: { snapshot(): Promise<GitHubMapSnapshot> };
  now?: () => string;
}>;

const unavailableLease = () => ({ state: 'unknown' as const, id: null, expiresAt: null });
function leaseState(expiresAt: string, now: string): LeaseState {
  const expiry = Date.parse(expiresAt), observed = Date.parse(now);
  return !Number.isFinite(expiry) || !Number.isFinite(observed) ? 'unknown' : expiry <= observed ? 'expired' : 'active';
}

/** A display projection. No cached field from this adapter authorises an effect. */
export function projectHostSnapshot(host: HostSnapshot, map: GitHubMapSnapshot | null, observedAt: string, evidenceMode: 'fixture' | 'authoritative'): OperatorSnapshot {
  const unknowns = [
    'Human decision queue is not connected.',
    'Provider quota and remaining subscription capacity are unknown.',
    'Gate and integration evidence are not connected to this run view.',
    'Context occupancy is not available in the host read model.',
  ];
  if (!map) unknowns.push('GitHub Map observation is unavailable.');
  else if (map.completeness !== 'complete') unknowns.push(...map.incomplete.map((reason) => `Map ${reason.code}: ${reason.subject}`));
  const ownership = host.ownership;
  const leases = host.autonomyLeases;
  // Several leases may cover distinct scopes. A single status must not imply
  // that one active lease grants authority over every displayed command.
  const autonomy = leases.length === 1 ? {
    state: leases[0].revoked ? 'revoked' as const : leaseState(leases[0].lease.expiresAt, observedAt),
    id: leases[0].lease.leaseId,
    expiresAt: leases[0].lease.expiresAt,
  } : unavailableLease();
  if (leases.length !== 1) unknowns.push(leases.length ? 'Multiple autonomy leases cover this run; inspect their individual scopes.' : 'No autonomy lease is linked to a recorded command.');

  const groups = new Map<string, HostSnapshot['reservations'][number][]>();
  for (const reservation of host.reservations) {
    const key = JSON.stringify([reservation.poolId, reservation.unit]);
    groups.set(key, [...(groups.get(key) ?? []), reservation]);
  }
  const units = [...groups.values()].map((rows) => ({
    poolId: rows[0].poolId, unit: rows[0].unit,
    used: rows.every((row) => row.state === 'settled' && row.settledActual !== undefined)
      ? rows.reduce((sum, row) => sum + row.settledActual!, 0) : null,
    reserved: rows.filter((row) => row.state !== 'settled').reduce((sum, row) => sum + row.reserved, 0),
    limit: null,
    unknown: 'Run-local command accounting; provider quota and pool-wide headroom are unknown.',
  }));

  return validateOperatorSnapshot({
    schemaVersion: 1, observedAt,
    source: { kind: 'helm-log', evidenceMode, id: `Helm Log / ${host.runId}`, observedAt },
    unknowns,
    map: map ? {
      state: map.completeness === 'complete' ? 'known' : 'incomplete',
      repository: map.source.repository, parentIssue: map.source.parentIssue,
      nodes: map.nodes.length, frontier: map.completeness === 'complete' ? map.frontier.length : null,
      summary: `GitHub #${map.source.parentIssue} observed ${map.observedAt}; ${map.nodes.filter((node) => node.state === 'CLOSED').length} observed closed`,
    } : null,
    run: {
      runId: host.runId,
      owner: { orchestrator: ownership?.owner ?? null, epoch: ownership?.epoch ?? null },
      leases: {
        orchestrator: ownership ? { state: leaseState(ownership.expiresAt, observedAt), id: ownership.leaseId, expiresAt: ownership.expiresAt } : unavailableLease(),
        autonomy,
      },
    },
    attempts: host.attempts.map((attempt) => {
      const commands = host.commands.filter((row) => attempt.commandIds.includes(row.command.commandId));
      const epochs = [...new Set(commands.flatMap((row) => row.command.origin === 'orchestrator' ? [row.command.orchestratorEpoch] : []))];
      return {
        attemptId: attempt.attemptId, mapNodeId: attempt.mapNodeId, role: attempt.role,
        state: attempt.outcome ?? (commands.some((row) => row.status === 'effect_started' || row.status === 'observing') ? 'running' : 'unknown'),
        model: { id: attempt.model, family: attempt.family, pool: attempt.poolId },
        workspace: { path: attempt.workspace, baseSha: attempt.baseSha },
        startedAt: attempt.startedAt, endedAt: attempt.endedAt ?? null, outcome: attempt.outcome ?? null,
        epoch: epochs.length === 1 ? epochs[0] : null,
      };
    }),
    pendingCommands: host.commands.filter((row) => !['succeeded', 'failed', 'refused'].includes(row.status)).map((row) => ({
      commandId: row.command.commandId, kind: row.command.kind, state: row.status,
      createdAt: row.command.plannedAt, epoch: row.command.origin === 'orchestrator' ? row.command.orchestratorEpoch : null,
    })),
    needsYou: null,
    resources: { units, context: host.attempts.map((attempt) => ({ attemptId: attempt.attemptId, used: null, window: null, occupancy: 'unknown' })) },
    quality: { gate: { passed: null, total: null }, integration: { passed: null, total: null } },
  });
}

/** GitHub failure degrades the Map only; durable host facts remain inspectable. */
export function createHostSnapshotSource(options: HostSourceOptions): SnapshotSource {
  const { host, runId, map, evidenceMode, now = () => new Date().toISOString() } = options;
  return { async read() {
    const [snapshot, observedMap] = await Promise.all([host.snapshot(runId), map?.snapshot().catch(() => null) ?? Promise.resolve(null)]);
    return projectHostSnapshot(snapshot, observedMap, now(), evidenceMode);
  } };
}
