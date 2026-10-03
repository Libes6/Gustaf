import { Command } from "@tauri-apps/plugin-shell";
import { cursorExecutable, shq } from "./cli";

/** First https link in login output (the CLI also opens it in the browser itself; this is the fallback). */
export const loginUrl = (text: string) => /https:\/\/[^\s"'<>]+/.exec(text)?.[0];

/** Runs `cursor-agent login` with an isolated profile as CURSOR_CONFIG_DIR. The profile path goes through the
 *  child environment, the executable is quoted; nothing user-controlled is part of the shell string. */
export async function startCursorLogin(profileDir: string, onOutput: (chunk: string) => void) {
  const script = `exec ${shq(await cursorExecutable())} login < /dev/null`;
  const cmd = Command.create("zsh", ["-lc", script], { env: { CURSOR_CONFIG_DIR: profileDir } });
  const done = new Promise<number | null>((resolve) => cmd.on("close", (e) => resolve(e.code)));
  cmd.stdout.on("data", onOutput);
  cmd.stderr.on("data", onOutput);
  const child = await cmd.spawn();
  return { done, kill: () => child.kill().catch(() => {}) };
}
