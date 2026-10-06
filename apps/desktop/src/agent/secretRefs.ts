// Secrets the agent asked for with `request_secret` (T10). The value is typed by the user into a private card and kept
// only here, in memory: never in a message, the action log or the settings. The agent gets a reference and uses it as an
// environment variable in run_command (`$GUSTAF_SECRET_<REF>`); the app passes the value to that one command, removes
// it afterwards (one use) and masks it in the command's output. Pure apart from the module-level map (tests/secretRefs.test.mjs).

export type SecretEntry = { name: string; value: string };
const store = new Map<string, SecretEntry>();
export const SECRET_ENV_PREFIX = "GUSTAF_SECRET_";
const REF = /GUSTAF_SECRET_([A-Z0-9]{8})\b/g;

/** Keeps a value and returns its reference (8 upper-case characters). */
export function issueSecret(name: string, value: string, random: () => number = Math.random): string {
  let ref = "";
  do ref = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(random() * 32)]).join(""); while (store.has(ref));
  store.set(ref, { name, value });
  return ref;
}

/** The environment for a command that mentions secret references, and the references it used. Unknown or used ones are left out. */
export function secretEnv(command: string): { env: Record<string, string>; used: string[] } {
  const env: Record<string, string> = {};
  const used: string[] = [];
  for (const m of command.matchAll(REF)) {
    const e = store.get(m[1]);
    if (e && !used.includes(m[1])) (env[SECRET_ENV_PREFIX + m[1]] = e.value), used.push(m[1]);
  }
  return { env, used };
}

/** Masks the values of `refs` in text (output of the command that used them). */
export function redactSecrets(text: string, refs: string[]): string {
  let out = text;
  for (const ref of refs) {
    const v = store.get(ref)?.value;
    if (v && v.length >= 3) out = out.split(v).join(`[secret ${ref}]`);
  }
  return out;
}

/** One use: the command ran, the values are dropped. */
export const spendSecrets = (refs: string[]) => refs.forEach((r) => store.delete(r));
export const secretCount = () => store.size;
/** Drops everything (a chat run ended or the app closes the chat). */
export const clearSecrets = () => store.clear();
