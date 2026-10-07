import { X } from "lucide-react";
import { useT, type Key } from "../i18n";
import { allowedProviderIds, refKey, sameRef, type ModelRef } from "../agent/agentSettings";
import { saveAgentSettings, useAgentSettings } from "../agent/agentSettingsStore";
import { cliSubagentSupport } from "../agent/cliSubagentCore";
import { AGENT_ROLES, type AgentRole } from "../agent/subagentCore";
import { useApp } from "../state";
import "../styles/agents.css";

// Settings > Usage > Agents: role presets (planner, implementer, reviewer, tester), the providers a task may name (API or CLI
// agents) and the worktree cleanup switch. Part of the "agentSettings" setting; used by spawn_agent and delegate_tasks.

const ROLE_KEY: Record<AgentRole, Key> = {
  planner: "agentRolePlanner",
  implementer: "agentRoleImplementer",
  reviewer: "agentRoleReviewer",
  tester: "agentRoleTester",
};
const encode = (r: ModelRef | null | undefined) => (r ? `${r.providerId}\n${r.model}` : "");
const decode = (v: string): ModelRef | null => {
  const i = v.indexOf("\n");
  return i > 0 ? { providerId: v.slice(0, i), model: v.slice(i + 1) } : null;
};

export function AgentRolesSection() {
  const t = useT();
  const app = useApp();
  const s = useAgentSettings();
  // Providers a task can be routed to: API providers and CLI agents that run non-interactively (not the Cursor SDK).
  const usable = app.providers.filter((p) => !p.disabled && (cliSubagentSupport(p)?.ok ?? true));
  const models = app.models
    .filter((m) => m.tools !== false && usable.some((p) => p.id === m.providerId))
    .map((m) => ({ providerId: m.providerId, model: m.id }));
  const providerName = (id: string) => app.providers.find((p) => p.id === id)?.name ?? id;
  const label = (r: ModelRef) =>
    `${providerName(r.providerId)} · ${app.models.find((m) => m.providerId === r.providerId && m.id === r.model)?.name ?? r.model}`;
  const options = (current: ModelRef | undefined) =>
    (current && !models.some((r) => sameRef(r, current)) ? [current, ...models] : models).map((r) => (
      <option key={refKey(r)} value={encode(r)}>
        {label(r)}
      </option>
    ));

  // Choosing a role's provider is the user's decision to allow it: the provider joins the allow-list (a role still needs it there).
  const setRole = (role: AgentRole, ref: ModelRef | null) => {
    const roles = { ...s.roles };
    if (ref) roles[role] = ref;
    else delete roles[role];
    const allowed = allowedProviderIds(s, "");
    const allowedProviders =
      ref && !allowed.includes(ref.providerId) ? [...s.allowedProviders, ref.providerId] : s.allowedProviders;
    saveAgentSettings({ ...s, roles, allowedProviders });
  };
  const addable = usable.filter((p) => !s.allowedProviders.includes(p.id));

  return (
    <>
      <h4 aria-level={2}>{t("agentRolesTitle")}</h4>
      <p className="h4-sub">{t("agentRolesLead")}</p>
      <div className="card">
        {AGENT_ROLES.map((role) => {
          const name = t(ROLE_KEY[role]);
          return (
            <div className="card-row" key={role}>
              <div className="grow">
                <div className="t">{name}</div>
                {role === "planner" && <div className="d">{t("agentRolesDesc")}</div>}
              </div>
              <select
                className="input narrow"
                aria-label={t("agentRoleModel", { role: name })}
                value={encode(s.roles[role])}
                onChange={(e) => setRole(role, decode(e.target.value))}
              >
                <option value="">{t("agentRoleNone")}</option>
                {options(s.roles[role])}
              </select>
            </div>
          );
        })}
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentAllowedProviders")}</div>
            <div className="d">{t("agentAllowedProvidersDesc")}</div>
            {!!s.allowedProviders.length && (
              <div className="agent-chips">
                {s.allowedProviders.map((id) => (
                  <span className="agent-chip" key={id}>
                    {providerName(id)}
                    <button
                      className="icon-btn"
                      aria-label={t("agentAllowedProviderRemove", { provider: providerName(id) })}
                      title={t("agentAllowedProviderRemove", { provider: providerName(id) })}
                      onClick={() =>
                        saveAgentSettings({ ...s, allowedProviders: s.allowedProviders.filter((x) => x !== id) })
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <select
            className="input narrow"
            aria-label={t("agentAllowedProviderAdd")}
            value=""
            onChange={(e) => {
              if (e.target.value)
                saveAgentSettings({ ...s, allowedProviders: [...s.allowedProviders, e.target.value] });
            }}
          >
            <option value="">{t("agentAllowedProviderAdd")}</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentCleanupWorktrees")}</div>
            <div className="d">{t("agentCleanupWorktreesDesc")}</div>
          </div>
          <button
            role="switch"
            aria-checked={s.cleanupUntouchedWorktrees}
            aria-label={t("agentCleanupWorktrees")}
            className={`toggle${s.cleanupUntouchedWorktrees ? " on" : ""}`}
            onClick={() => saveAgentSettings({ ...s, cleanupUntouchedWorktrees: !s.cleanupUntouchedWorktrees })}
          />
        </div>
      </div>
    </>
  );
}
