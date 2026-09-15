export type LeaseState = "active" | "expired" | "revoked" | "unknown";
export type Orchestrator = "fable" | "astra" | null;

export type OperatorSnapshot = Readonly<{
  schemaVersion: 1;
  observedAt: string;
  source: Readonly<{ kind: "helm-log" | "fixture"; evidenceMode: "authoritative" | "fixture" | "unknown"; id: string; observedAt: string | null }>;
  unknowns: readonly string[];
  map: Readonly<{ state: "known" | "unknown" | "incomplete"; repository: string | null; parentIssue: number | null; nodes: number | null; frontier: number | null; summary: string | null }> | null;
  run: Readonly<{
    runId: string | null;
    owner: Readonly<{ orchestrator: Orchestrator; epoch: number | null }>;
    leases: Readonly<{
      orchestrator: Readonly<{ state: LeaseState; id: string | null; expiresAt: string | null }>;
      autonomy: Readonly<{ state: LeaseState; id: string | null; expiresAt: string | null }>;
    }>;
  }>;
  attempts: readonly Readonly<{
    attemptId: string;
    mapNodeId: string | null;
    role: string;
    state: string;
    model: Readonly<{ id: string; family: string; pool: string }> | null;
    workspace: Readonly<{ path: string; baseSha: string }> | null;
    startedAt: string | null;
    endedAt: string | null;
    outcome: string | null;
    epoch: number | null;
  }>[];
  pendingCommands: readonly Readonly<{
    commandId: string;
    kind: string;
    state: string;
    createdAt: string;
    epoch: number | null;
  }>[];
  needsYou: readonly Readonly<{ id: string; kind: string; summary: string; createdAt: string }>[] | null;
  resources: Readonly<{
    units: readonly Readonly<{ poolId: string; unit: string; used: number | null; reserved: number | null; limit: number | null; unknown: string | null }>[];
    context: readonly Readonly<{ attemptId: string; used: number | null; window: number | null; occupancy: "known" | "unknown" }>[];
  }>;
  quality: Readonly<{ gate: Readonly<{ passed: number | null; total: number | null }>; integration: Readonly<{ passed: number | null; total: number | null }> }>;
}>;

export type SnapshotSource = Readonly<{
  read: () => Promise<OperatorSnapshot>;
  /** Presentation-only: this projection cannot grant authority. */
  presentation?: Readonly<{ mode: 'historical-untrusted' }>;
}>;
