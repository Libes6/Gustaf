// Last PostgreSQL backup from Coolify 4.x: GET /api/v1/databases/{uuid}/backups answers the
// database's scheduled backups, each with its `executions` (newest Coolify builds may send only
// `latest_log`). Reading needs an API token with the `read` ability.

export interface BackupStatus {
  schedules: number;
  enabled: number;
  frequency: string | null;
  last: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    sizeBytes: number | null;
  } | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

function timeOf(value: unknown) {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export function parseCoolifyBackups(body: unknown): BackupStatus {
  if (!Array.isArray(body)) throw new Error("Unexpected Coolify backups response");
  const configs = body.filter(isObject);
  const enabled = configs.filter((config) => config.enabled !== false && config.enabled !== 0);
  let last: BackupStatus["last"] = null;
  for (const config of configs) {
    const executions = Array.isArray(config.executions)
      ? config.executions
      : isObject(config.latest_log)
        ? [config.latest_log]
        : [];
    for (const execution of executions.filter(isObject)) {
      const startedAt = timeOf(execution.created_at);
      if (!startedAt || (last && last.startedAt >= startedAt)) continue;
      const size = Number(execution.size);
      last = {
        status: typeof execution.status === "string" ? execution.status : "unknown",
        startedAt,
        finishedAt: timeOf(execution.finished_at),
        sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
      };
    }
  }
  const frequency = enabled.find((config) => typeof config.frequency === "string")?.frequency;
  return {
    schedules: configs.length,
    enabled: enabled.length,
    frequency: typeof frequency === "string" ? frequency : null,
    last,
  };
}

export async function fetchCoolifyBackups(
  config: { url: string; token: string; databaseUuid: string },
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(
    `${config.url}/api/v1/databases/${encodeURIComponent(config.databaseUuid)}/backups`,
    {
      headers: { accept: "application/json", authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error(`Coolify answered HTTP ${response.status}`);
  return parseCoolifyBackups(await response.json());
}
