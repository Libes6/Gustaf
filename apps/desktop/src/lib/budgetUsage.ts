import { db, getSetting } from "./api";
import {
  BUDGETS_SETTING,
  exceededBudget,
  localDayKey,
  localDayStart,
  nextLocalDayStart,
  normalizeBudgets,
  parseUsageRow,
  summarizeUsage,
  withExtraTokens,
  type UsageTotals,
} from "./budgets";
import { loadAgentUsage } from "../agent/agentRuns";
import { ledgerChat, ledgerDay } from "../agent/agentRunsModel";

// Reads the same numbers as the Budgets banner (components/Budgets.tsx): provider-reported tokens of the stored chat
// messages plus the subagent token ledger. Used to stop subagents when a budget is exceeded (agentSettings.stopOnBudget).

type Row = { role: string; created_at: number; content: string };
const SELECT = "select role, created_at, content from messages where";
const FILTER = `(role = 'assistant' or content like '%"compacted":true%')`;

/** The message part is cached for a few seconds (it needs reading and parsing a day of messages); the subagent ledger is always live. */
const CACHE_MS = 5_000;
let cache: { key: string; at: number; day: UsageTotals; chat?: UsageTotals } | undefined;

export const resetBudgetUsageCache = () => {
  cache = undefined;
};

/** `day` / `chat` when that token budget is exceeded now; null when no budget is set, none is exceeded, or usage cannot be read. */
export async function currentBudgetStop(chatId: number | undefined, now = Date.now()): Promise<"day" | "chat" | null> {
  try {
    const settings = normalizeBudgets(await getSetting<unknown>(BUDGETS_SETTING, null));
    if (settings.dayTokens === null && settings.chatTokens === null) return null;
    const dayStart = localDayStart(now);
    const key = `${dayStart}:${chatId ?? ""}`;
    if (!cache || cache.key !== key || now - cache.at > CACHE_MS) {
      const dayRows =
        settings.dayTokens === null ? [] : await db.select<Row>(`${SELECT} created_at >= ? and ${FILTER}`, [dayStart]);
      const chatRows =
        chatId === undefined || settings.chatTokens === null
          ? undefined
          : await db.select<Row>(`${SELECT} chat_id = ? and ${FILTER}`, [chatId]);
      cache = {
        key,
        at: now,
        day: summarizeUsage(dayRows.map(parseUsageRow), { from: dayStart, to: nextLocalDayStart(dayStart) }),
        ...(chatRows ? { chat: summarizeUsage(chatRows.map(parseUsageRow)) } : {}),
      };
    }
    const agents = await loadAgentUsage();
    return exceededBudget(
      settings,
      withExtraTokens(cache.day, ledgerDay(agents, localDayKey(dayStart))),
      cache.chat && withExtraTokens(cache.chat, ledgerChat(agents, chatId)),
    );
  } catch {
    return null;
  }
}
