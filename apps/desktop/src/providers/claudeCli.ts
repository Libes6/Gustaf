/** `addDir` is passed as `--add-dir=<dir>`: the flag is variadic, so a separate value would also swallow the positional prompt. */
export function claudeArgs({
  model,
  session,
  access,
  mode,
  addDir,
  reasoning,
  deviceCommand,
  agentCommand,
}: {
  model?: string;
  session?: string;
  access?: "readonly" | "auto" | "full";
  mode?: "ask" | "plan" | "agent";
  addDir?: string;
  reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Agent device access is on: the `gustaf-device` command may run without a permission prompt. */
  deviceCommand?: boolean;
  /** Subagents from CLI agents are on: the `gustaf-agent` command may run without a permission prompt. */
  agentCommand?: boolean;
}) {
  // Claude Code has one read-only permission mode (`plan`); it serves the Ask and Plan chat modes too.
  const readonly = access === "readonly" || mode === "plan" || mode === "ask";
  return [
    "-p",
    ...(addDir ? [`--add-dir=${addDir}`] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    readonly ? "plan" : access === "full" ? "bypassPermissions" : "acceptEdits",
    ...(model ? ["--model", model] : []),
    ...(reasoning ? ["--effort", reasoning] : []),
    ...(!readonly && (deviceCommand || agentCommand)
      ? [
          `--allowedTools=${[deviceCommand && "Bash(gustaf-device:*)", agentCommand && "Bash(gustaf-agent:*)"].filter(Boolean).join(",")}`,
        ]
      : []),
    ...(session ? ["--resume", session] : []),
  ];
}
export function parseClaudeEvent(e: any) {
  // Text streamed from inside a subagent (marked with the Task call's id) is not part of the answer.
  if (e.type === "stream_event" && e.event?.delta?.type === "text_delta" && !e.parent_tool_use_id)
    return { text: e.event.delta.text };
  if (e.type === "assistant") return { session: e.session_id };
  if (e.type === "result")
    return {
      session: e.session_id,
      final: e.result,
      error: e.is_error
        ? String(e.result || e.errors?.join("\n") || e.terminal_reason || e.subtype || "Claude request failed")
        : undefined,
    };
  return { session: e.session_id };
}
