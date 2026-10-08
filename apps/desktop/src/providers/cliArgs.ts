import { flattenMsg, textOf, type Reasoning, type TurnInput } from "./types.ts";
import { cursorModel } from "./reasoning.ts";

export type ChatMode = "ask" | "plan" | "agent";
/** Plan and Ask must not change anything. */
export const isPlanning = (mode?: ChatMode) => mode === "plan" || mode === "ask";

/**
 * Cursor Agent: `--plan` (shorthand for `--mode=plan`) and `--mode ask` exist in `cursor-agent --help`. The older read-only
 * access mode keeps `--mode plan`; "full" access adds `--force` unless the chat mode is read-only.
 */
export function cursorArgs({
  model,
  session,
  access,
  mode,
  attachDir,
  reasoning,
}: {
  model?: string;
  session?: string;
  access?: "readonly" | "auto" | "full";
  mode?: ChatMode;
  attachDir?: string;
  reasoning?: Reasoning;
}): string[] {
  const modeFlags =
    mode === "plan"
      ? ["--plan"]
      : mode === "ask"
        ? ["--mode", "ask"]
        : access === "readonly"
          ? ["--mode", "plan"]
          : access === "full"
            ? ["--force"]
            : [];
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    ...modeFlags,
    ...(model ? ["--model", cursorModel(model, reasoning)] : []),
    ...(session ? ["--resume", session] : []),
    ...(attachDir ? ["--add-dir", attachDir] : []),
  ];
}

/**
 * `images` are absolute paths of attachments written by `attachments_save`. `--image=<path>` (one flag per file) is used
 * instead of `-i <path>` because `codex exec -i` takes a variadic list and would swallow the positional prompt/session id.
 * Each flag is followed by another `--` option, never by a positional.
 */
export function codexArgs({
  model,
  session,
  access,
  mode,
  images = [],
  reasoning,
}: {
  model?: string;
  session?: string;
  access?: "readonly" | "auto" | "full";
  mode?: ChatMode;
  images?: string[];
  reasoning?: Reasoning;
}): string[] {
  // Plan and Ask have no native Codex mode: the read-only sandbox is the equivalent, and it wins over "full" access.
  const readonly = access === "readonly" || isPlanning(mode);
  const permissions =
    access === "full" && !readonly
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : session
        ? ["-c", `sandbox_mode="${readonly ? "read-only" : "workspace-write"}"`]
        : ["--sandbox", readonly ? "read-only" : "workspace-write"];
  return [
    "exec",
    ...(session ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...images.map((p) => `--image=${p}`),
    ...permissions,
    ...(model ? ["-m", model] : []),
    ...(reasoning ? ["-c", `model_reasoning_effort="${reasoning}"`] : []),
    ...(session ? [session] : []),
  ];
}

/**
 * Why a Cursor SDK sidecar run failed, or "" when it did not. The sidecar reports its own errors as an `error` event
 * (`reported`) and exits 0; a non-zero exit without one means Node could not run it (old Node, missing modules, a crash),
 * which must not pass for an empty answer or an empty model list.
 */
export function sidecarFailure(o: {
  code: number | null;
  stderr: string;
  reported: boolean;
  aborted: boolean;
}): string {
  if (/command not found: node|not recognized|Cannot find package/.test(o.stderr))
    return `Cursor sidecar: ${o.stderr.slice(0, 300)}`;
  if (o.reported || o.aborted || o.code === 0) return "";
  const tail = o.stderr.trim().slice(-600);
  return `Cursor sidecar failed (exit code ${o.code ?? "none"})${tail ? `: ${tail}` : "."}`;
}

/** Claude and Cursor Agent have no image flag: the prompt points them at the files, and their tool permissions must cover the folder. */
export function withImagePaths(prompt: string, images: string[]): string {
  if (!images.length) return prompt;
  const lines = images.map((p) => `Attached image: ${p} (read it with your file-reading tool)`);
  return `${prompt}\n\n${lines.join("\n")}`;
}

/** Images to send with this turn: those of the user messages after the resumed session, or only the latest user message when the history is replayed as text. */
export function turnImages(
  rest: { role: string; parts: { type: string; data?: string }[] }[],
  resumed: boolean,
): string[] {
  const users = rest.filter((m) => m.role === "user");
  const picked = resumed ? users : users.slice(-1);
  return picked.flatMap((m) => m.parts.flatMap((p) => (p.type === "image" && p.data ? [p.data] : [])));
}

/**
 * Finds the last session this provider left in the history and the prompt to continue it with.
 * A provider session only knows its own turns: if another provider answered after it (for example another
 * Cursor account took over and the pool wrapped back), resuming would silently drop those turns, so the
 * session is not resumed and the whole history is replayed as text into a fresh session instead.
 */
export function resumePoint(t: TurnInput, providerId: string, withSystem: boolean) {
  let from = 0;
  let session: string | undefined;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.role === "assistant" && m.meta?.provider === providerId && m.meta.responseId) {
      const interleaved = t.messages
        .slice(i + 1)
        .some((x) => x.role === "assistant" && x.meta?.provider && x.meta.provider !== providerId);
      if (!interleaved) {
        session = m.meta.responseId;
        from = i + 1;
      }
      break;
    }
  }
  const rest = t.messages.slice(from);
  // A per-turn CLI stopped mid-reply keeps its tool calls but not the text it was writing: hand it back.
  const cutText =
    session && from > 0 && t.messages[from - 1].meta?.interrupted ? textOf(t.messages[from - 1]).trim() : "";
  const prompt = session
    ? (cutText ? [`[Your previous reply was interrupted. What you had written so far:]\n${cutText.slice(-4000)}`] : [])
        .concat(rest.filter((m) => m.role === "user").map(textOf))
        .join("\n\n")
    : (withSystem ? `${t.system}\n\n` : "") +
      (rest.length === 1
        ? textOf(rest[0])
        : rest.map((m) => `${m.role.toUpperCase()}:\n${flattenMsg(m)}`).join("\n\n"));
  // Resumed CLI sessions may predate canvas support and don't receive the API system message.
  return {
    session,
    prompt: session || !withSystem ? `${t.system}\n\n${prompt}` : prompt,
    images: turnImages(rest, !!session || rest.some((m) => m.meta?.branchHistory)),
  };
}
