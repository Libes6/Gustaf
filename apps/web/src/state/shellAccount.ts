import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { accountView } from "../components/settings/AccountSettings.logic";
import { shellAccount, type ShellAccountDevice } from "../shellAccount";

class ShellAccountLoadError extends Schema.TaggedError<ShellAccountLoadError>()(
  "ShellAccountLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : "Failed to load the account.";
  }
}

async function loadAccount() {
  const account = shellAccount();
  if (!account) return { view: accountView(null, 0), devices: null };
  const state = await account.getState();
  let devices: readonly ShellAccountDevice[] | null = null;
  if (state.signedIn) {
    try {
      devices = await account.listDevices();
    } catch (error) {
      // The shell forgets a rejected session; the page then offers sign-in again.
      const after = await account.getState();
      if (after.signedIn) throw error;
      return { view: accountView(after, Date.now()), devices: null };
    }
  }
  return { view: accountView(state, Date.now()), devices };
}

export const shellAccountAtom = Atom.make(
  Effect.tryPromise({
    try: loadAccount,
    catch: (cause) => new ShellAccountLoadError({ cause }),
  }),
).pipe(
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("shell:account:load"),
);

export function refreshShellAccount(): void {
  appAtomRegistry.refresh(shellAccountAtom);
}
