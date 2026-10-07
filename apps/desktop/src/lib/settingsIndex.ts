// Index of the individual settings for search (the settings search field and the Cmd+K palette).
// Pure: no DOM/React imports, so node tests cover it. `id` is the `data-setting` attribute of the row in the page
// (components/SettingRow.tsx); a test renders every page and checks that each indexed row exists.
// Text comes from the i18n dictionaries, so the search works in every language; the query is matched against the
// current language and English.

import type { Key } from "../i18n/index.tsx";
import type { SettingsPage } from "../state.tsx";
import { displayKeys } from "./platform.ts";
import { SHORTCUTS, type Shortcut } from "./shortcuts.ts";

export type SettingEntry = {
  id: string;
  page: SettingsPage;
  title: Key;
  desc?: Key;
  /** Extra search words (dictionary keys), e.g. the old name of a setting. */
  keywords?: Key[];
};

/** Labels of the settings pages (same as the navigation). */
export const PAGE_LABEL: Record<SettingsPage, Key> = {
  general: "general", storage: "cleanupTitle", web: "webTools", shortcuts: "shortcuts", import: "import", providers: "providers", usage: "usage", memory: "memoryTitle",
  computer: "computerUse", mcp: "mcp", scheduled: "scheduledNav", knowledge: "knowledgeNav", mobile: "mobileTitle", git: "gitAndCommands", rules: "rules", archive: "archivedChats", diagnostics: "appDiagNav",
};

export const SETTING_ENTRIES: readonly SettingEntry[] = [
  { id: "language", page: "general", title: "language" },
  { id: "onboarding", page: "general", title: "onboarding", desc: "onboardingDesc" },
  { id: "theme", page: "general", title: "themeLabel", keywords: ["appearance"] },
  { id: "chatWidth", page: "general", title: "chatWidth", desc: "chatWidthHint", keywords: ["appearance"] },
  { id: "accent", page: "general", title: "accentColor", keywords: ["appearance"] },
  { id: "cleanupAuto", page: "storage", title: "cleanupAuto", desc: "cleanupDesc" },
  { id: "cleanupAfter", page: "storage", title: "cleanupAfter" },
  { id: "diagProcesses", page: "diagnostics", title: "appDiagProcesses", desc: "appDiagProcessesDesc" },
  { id: "diagProviders", page: "diagnostics", title: "appDiagProviders", desc: "appDiagProvidersDesc" },
  { id: "diagErrors", page: "diagnostics", title: "appDiagErrors", desc: "appDiagErrorsDesc" },
  { id: "diagLogs", page: "diagnostics", title: "appDiagOpenLogs", desc: "appDiagLogsDesc" },
  { id: "webEnable", page: "web", title: "webEnable", desc: "webToolsDesc" },
  { id: "webBraveKey", page: "web", title: "webBraveKey" },
  { id: "webAllow", page: "web", title: "webAllow" },
  { id: "webDeny", page: "web", title: "webDeny" },
  { id: "permAccessibility", page: "computer", title: "permAccessibility", desc: "permAccessibilityDesc" },
  { id: "permScreen", page: "computer", title: "permScreen", desc: "permScreenDesc" },
  { id: "computerEnable", page: "computer", title: "computerEnable", desc: "computerEnableDesc" },
  { id: "computerSafety", page: "computer", title: "computerSafety" },
  { id: "reviewCopy", page: "git", title: "reviewCopySetting", desc: "reviewCopySettingDesc" },
  { id: "autoReview", page: "git", title: "autoReviewSetting", desc: "autoReviewSettingDesc" },
  { id: "autoReviewTrigger", page: "git", title: "autoReviewTrigger" },
  { id: "diagnosticsAuto", page: "git", title: "diagnosticsAuto" },
  { id: "semanticEnable", page: "git", title: "semanticEnable" },
  { id: "verifFixAttempts", page: "git", title: "verifFixAttempts" },
  { id: "updaterCheck", page: "general", title: "updaterTitle", keywords: ["updaterCheck"] },
  { id: "budgetDayLimit", page: "usage", title: "budgetDayLimit", desc: "budgetDayLimitDesc" },
  { id: "budgetChatLimit", page: "usage", title: "budgetChatLimit", desc: "budgetChatLimitDesc" },
  { id: "budgetWarnAt", page: "usage", title: "budgetWarnAt", desc: "budgetWarnAtDesc" },
  { id: "agentAllowedModels", page: "usage", title: "agentAllowedModels", desc: "agentAllowedModelsDesc" },
  { id: "agentCheapModel", page: "usage", title: "agentCheapModel", desc: "agentCheapModelDesc" },
  { id: "agentBudgets", page: "usage", title: "agentBudgets", desc: "agentBudgetsDesc" },
  { id: "agentStopOnBudget", page: "usage", title: "agentStopOnBudget", desc: "agentStopOnBudgetDesc" },
  { id: "agentCancelDependents", page: "usage", title: "agentCancelDependents", desc: "agentCancelDependentsDesc" },
  { id: "agentNotifications", page: "usage", title: "agentNotifications", desc: "agentNotificationsDesc" },
  { id: "codexSessions", page: "usage", title: "codexSessions", desc: "codexSessionsDesc" },
  { id: "codexAppServer", page: "usage", title: "codexAppServer", desc: "codexAppServerDesc" },
  { id: "memoryEnabled", page: "memory", title: "memoryEnabled" },
  { id: "memoryApproval", page: "memory", title: "memoryApproval" },
  { id: "memorySuggestAuto", page: "memory", title: "memorySuggestAuto", desc: "memorySuggestAutoHint" },
  { id: "providerCheckAll", page: "providers", title: "providerCheckAll", desc: "providerCheckAllHint" },
  { id: "mobileSwitch", page: "mobile", title: "mobileSwitch" },
  { id: "mobilePort", page: "mobile", title: "mobilePort", desc: "mobilePortHint" },
  { id: "quickAskSwitch", page: "shortcuts", title: "quickAskSwitch", desc: "quickAskSwitchDesc" },
  { id: "quickAskShortcut", page: "shortcuts", title: "quickAskShortcut" },
  { id: "quickAskHideOnBlur", page: "shortcuts", title: "quickAskHideOnBlur" },
];

export type SettingHit = {
  id: string;
  page: SettingsPage;
  title: string;
  /** Page name, plus the key combination for a shortcut. */
  detail: string;
  /** Combination shown for a shortcut result. */
  keys?: string;
};

type Translate = (key: Key) => string;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Same text without separators, so `cmd n`, `cmd+n` and `cmd-n` find the same combination. */
const compact = (s: string) => s.toLowerCase().replace(/[\s+\-]/g, "");

/**
 * Settings that match every word of `query`, best first: title starts with the query, title contains it, keywords,
 * then description / page name. `translators` are the dictionaries to look in (current language first, then English).
 */
export function searchSettings(query: string, translators: readonly Translate[], shortcuts: readonly Shortcut[] = SHORTCUTS, entries: readonly SettingEntry[] = SETTING_ENTRIES, limit = 30): SettingHit[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const words = q.split(" ");
  const t = translators[0];
  type Cand = { hit: SettingHit; title: string[]; rest: string[]; compactKeys: string };
  const cands: Cand[] = [
    ...entries.map((e): Cand => ({
      hit: { id: e.id, page: e.page, title: t(e.title), detail: t(PAGE_LABEL[e.page]) },
      title: translators.map((tr) => norm(tr(e.title))),
      rest: [...translators.flatMap((tr) => [e.desc ? tr(e.desc) : "", ...(e.keywords ?? []).map(tr), tr(PAGE_LABEL[e.page])])].map(norm),
      compactKeys: "",
    })),
    ...shortcuts.map((s): Cand => {
      const keys = [displayKeys(s.display, "macos"), displayKeys(s.display, "windows"), s.combo];
      return {
        hit: { id: `shortcut-${s.id}`, page: "shortcuts", title: t(s.label), detail: t(PAGE_LABEL.shortcuts), keys: displayKeys(s.display) },
        title: translators.map((tr) => norm(tr(s.label))),
        rest: translators.map((tr) => norm(tr(PAGE_LABEL.shortcuts))),
        compactKeys: compact(keys.join(" ")),
      };
    }),
  ];
  const cq = compact(q);
  const scored: { hit: SettingHit; score: number; order: number }[] = [];
  cands.forEach((c, order) => {
    const hay = [...c.title, ...c.rest].join(" ");
    const wordsOk = words.every((w) => hay.includes(w));
    const keysOk = c.compactKeys !== "" && c.compactKeys.includes(cq);
    if (!wordsOk && !keysOk) return;
    const score = c.title.some((x) => x.startsWith(q)) ? 0 : c.title.some((x) => x.includes(q)) ? 1 : wordsOk && words.every((w) => c.title.join(" ").includes(w)) ? 2 : keysOk && !wordsOk ? 3 : 4;
    scored.push({ hit: c.hit, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).slice(0, limit).map((s) => s.hit);
}
