type Handler = (args: any) => unknown;
const handlers = new Map<string, Handler>();

/** Every `invoke` the components make, newest last: `[command, args]`. */
export const invokeCalls: [string, any][] = [];

/**
 * Stand-in for `invoke` from `@tauri-apps/api/core` (wired up in setup.ts). Unknown commands behave like an empty backend:
 * list commands return `[]`, everything else `undefined`, so a page renders its empty state.
 */
export async function invokeMock(cmd: string, args?: unknown): Promise<unknown> {
  invokeCalls.push([cmd, args]);
  const h = handlers.get(cmd);
  if (h) return h(args);
  if (/^(db_select|fs_files|import_scan|search_models|cursor_scan|read_instructions)$/.test(cmd)) return [];
  if (cmd === "db_execute") return [1, 1];
  if (cmd === "cu_permissions") return { accessibility: true, screen: true };
  return undefined;
}

/** Register backend responses by command name; a function receives the invoke arguments. Cleared after every test. */
export function mockInvoke(map: Record<string, unknown>) {
  for (const [cmd, v] of Object.entries(map)) handlers.set(cmd, typeof v === "function" ? (v as Handler) : () => v);
}

/** Arguments of every call to one command. */
export const callsOf = (cmd: string) => invokeCalls.filter(([c]) => c === cmd).map(([, a]) => a);

export function resetInvoke() {
  handlers.clear();
  invokeCalls.length = 0;
}

/** Answer `select value from settings where key = ?` from a plain object (other `db_select` queries return no rows). */
export function mockSettings(settings: Record<string, unknown>) {
  mockInvoke({
    db_select: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/from settings where key/.test(sql)) {
        const key = String(params[0]);
        return key in settings ? [{ value: JSON.stringify(settings[key]) }] : [];
      }
      return [];
    },
  });
}
