export const DEFAULT_DAEMON_PORT = 4747;

export function defaultDaemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.HELM_DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_DAEMON_PORT;
}
