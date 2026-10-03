// SQLite side of the subagent runs: the `agent_runs` and `agent_messages` tables (created by src-tauri/src/db.rs). The same
// statements are exercised on a real SQLite database by tests/agentRunsDb.test.mjs and, in Rust, by the migration tests.
import { db, getSetting, setSetting } from "../lib/api";
import { AGENT_RUNS_SETTING, MAX_RUNS, isActiveStatus, normalizeRuns, runFromRow, runParams, type AgentRun } from "./agentRunsModel";
import { MAX_MESSAGES_PER_RUN, type MessageRow } from "./agentTranscript";

export const AGENT_RUNS_MIGRATED = "agentRunsMigrated";

export const UPSERT_RUN =
  "insert into agent_runs(id, chat_id, title, type, model, status, started_at, ended_at, tokens, tool_uses, error, report, provider_id, project_root, created_at, changed_json, warnings_json) " +
  "values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "on conflict(id) do update set title = excluded.title, model = excluded.model, status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at, " +
  "tokens = excluded.tokens, tool_uses = excluded.tool_uses, error = excluded.error, report = coalesce(excluded.report, agent_runs.report), " +
  "changed_json = excluded.changed_json, warnings_json = excluded.warnings_json";
/** Rows of a legacy migration never overwrite what the new tables already hold. */
export const INSERT_RUN_IF_NEW = UPSERT_RUN.replace(/on conflict\(id\) do update set .*$/, "on conflict(id) do nothing");
export const INSERT_MESSAGE = "insert or replace into agent_messages(run_id, seq, role, parts_json, created_at) values(?, ?, ?, ?, ?)";
export const INSERT_MESSAGE_IF_NEW = "insert or ignore into agent_messages(run_id, seq, role, parts_json, created_at) values(?, ?, ?, ?, ?)";
export const SELECT_RUNS =
  "select id, chat_id, title, type, model, status, started_at, ended_at, tokens, tool_uses, error, substr(report, 1, 1500) as summary, provider_id, project_root, created_at, changed_json, warnings_json " +
  "from agent_runs order by created_at desc, id desc limit ?";
export const SELECT_MESSAGES = "select seq, role, parts_json, created_at from agent_messages where run_id = ? order by seq limit ?";
export const SELECT_REPORT = "select report from agent_runs where id = ?";
export const MARK_INTERRUPTED = "update agent_runs set status = 'interrupted', ended_at = coalesce(ended_at, ?) where id = ? and status in ('queued', 'running')";
/** Retention: keeps every active run and the `?` newest finished ones; messages go with their run (foreign key cascade). */
export const PRUNE_RUNS =
  "delete from agent_runs where status not in ('queued', 'running') and id not in " +
  "(select id from agent_runs where status not in ('queued', 'running') order by created_at desc, id desc limit ?)";
export const DELETE_FINISHED = "delete from agent_runs where status not in ('queued', 'running') and (? is null or project_root = ?)";

export const saveRun = (run: AgentRun) => db.exec(UPSERT_RUN, runParams(run));
export const saveMessage = (runId: string, seq: number, role: string, partsJson: string, at: number) => db.exec(INSERT_MESSAGE, [runId, seq, role, partsJson, at]);
export const pruneRuns = (keep = MAX_RUNS) => db.exec(PRUNE_RUNS, [keep]);
export const deleteFinished = (root?: string) => db.exec(DELETE_FINISHED, [root ?? null, root ?? null]);

/** The stored runs (newest first). Runs that were queued or running belong to a previous session: marked interrupted here and in the table. */
export async function loadStoredRuns(isLive: (id: string) => boolean, now = Date.now()): Promise<AgentRun[]> {
  const rows = await db.select(SELECT_RUNS, [MAX_RUNS]);
  const runs: AgentRun[] = [];
  for (const row of rows) {
    const run = runFromRow(row);
    if (!run) continue;
    // A run of this session may already be in the table (the store inserts it right away): it is not an old one.
    if (isActiveStatus(run.status) && !isLive(run.id)) {
      await db.exec(MARK_INTERRUPTED, [now, run.id]).catch(() => {});
      runs.push({ ...run, status: "interrupted", endedAt: run.endedAt ?? now, currentStep: "" });
    } else runs.push(run);
  }
  return runs;
}

export const loadMessages = (runId: string, limit = MAX_MESSAGES_PER_RUN) => db.select<MessageRow>(SELECT_MESSAGES, [runId, limit]);
export const loadReport = async (runId: string): Promise<string> => {
  const [row] = await db.select<{ report: string | null }>(SELECT_REPORT, [runId]);
  return row?.report ?? "";
};

/**
 * One-time move of the old `agentRuns` setting (bounded runs with clipped steps) into the tables. Idempotent: rows are
 * inserted only when new and the flag is set last, so an interrupted migration just runs again. Returns the runs moved.
 */
export async function migrateLegacyRuns(now = Date.now()): Promise<AgentRun[]> {
  if (await getSetting<boolean>(AGENT_RUNS_MIGRATED, false)) return [];
  const legacy = normalizeRuns(await getSetting<unknown>(AGENT_RUNS_SETTING, []), now);
  for (const run of legacy) {
    await db.exec(INSERT_RUN_IF_NEW, runParams({ ...run, ...(run.summary ? { report: run.summary } : {}) }));
    for (const [seq, step] of run.transcript.entries()) await db.exec(INSERT_MESSAGE_IF_NEW, [run.id, seq, "step", JSON.stringify(step), step.at]);
  }
  await setSetting(AGENT_RUNS_MIGRATED, true);
  if (legacy.length) await setSetting(AGENT_RUNS_SETTING, []);
  return legacy;
}
