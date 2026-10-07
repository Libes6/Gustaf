// Lazy, once-per-session Keychain reads. macOS asks the user before an app reads a Keychain item (again after every
// re-signed build), so nothing may read a secret just because the app started: values are fetched on first real use
// and kept in memory until the user saves or deletes them. A non-secret presence flag per secret id ("secretFlags"
// setting) lets the UI and the model-list cache know whether a key exists without touching the Keychain.
import { getSetting, secrets, setSetting } from "./api";

/** Returns the key, reading the Keychain on the first call only. */
export type KeyGetter = () => Promise<string>;
/** Adapters accept a fixed key (tests, the "Test connection" form) or a lazy getter. */
export type KeySource = string | KeyGetter;
export const resolveKey = (k: KeySource): Promise<string> => (typeof k === "string" ? Promise.resolve(k) : k());

const FLAGS = "secretFlags";
const values = new Map<string, Promise<string | null>>();
let flagWrites: Promise<unknown> = Promise.resolve();

/** Whether a value is stored for `id`: true / false when known, undefined for secrets saved before flags existed. */
export const secretPresence = async (id: string): Promise<boolean | undefined> =>
  (await getSetting<Record<string, boolean>>(FLAGS, {}).catch(() => ({}) as Record<string, boolean>))[id];

function setPresence(id: string, present: boolean | null) {
  const run = flagWrites.then(async () => {
    const flags = { ...(await getSetting<Record<string, boolean>>(FLAGS, {})) };
    if (present === null) delete flags[id];
    else if (flags[id] === present) return;
    else flags[id] = present;
    await setSetting(FLAGS, flags);
  });
  flagWrites = run.catch(() => {});
  return run.catch(() => {});
}

/** Reads a secret at most once per session (a failed or empty read is retried next time); records its presence. */
export function readSecret(id: string): Promise<string | null> {
  const cached = values.get(id);
  if (cached) return cached;
  const p: Promise<string | null> = secrets.get(id).then((v) => {
    void setPresence(id, !!v);
    if (!v && values.get(id) === p) values.delete(id);
    return v ?? null;
  });
  p.catch(() => values.get(id) === p && values.delete(id));
  values.set(id, p);
  return p;
}

/** Saves a secret and updates the cache and the presence flag. */
export async function storeSecret(id: string, value: string) {
  values.delete(id);
  await secrets.set(id, value);
  values.set(id, Promise.resolve(value));
  await setPresence(id, !!value);
}

/** Deletes a secret; `forget` drops its flag entirely (the owner is gone) instead of recording "absent". */
export async function removeSecret(id: string, forget = false) {
  values.delete(id);
  await secrets.delete(id);
  await setPresence(id, forget ? null : false);
}

/** Drops cached values (all when no id is given), e.g. after something else changed the Keychain. */
export const invalidateSecret = (id?: string) => void (id === undefined ? values.clear() : values.delete(id));

export const providerSecretId = (providerId: string) => `provider:${providerId}`;

/**
 * The lazy key of a provider. A provider known to have no key never touches the Keychain. A failed read (the user
 * denied access, the Keychain is locked) is reported with the provider's name instead of the bare OS message.
 */
export const providerKey =
  (providerId: string, label = providerId): KeyGetter =>
  async () => {
    const id = providerSecretId(providerId);
    // Known to be absent: remembered as "no value" until the user saves one.
    if (!values.has(id) && (await secretPresence(id)) === false && !values.has(id))
      values.set(id, Promise.resolve(null));
    try {
      return (await readSecret(id)) ?? "";
    } catch (e) {
      const why = String((e as Error)?.message ?? e).replace(/\.$/, "");
      throw new Error(
        `Could not read the API key of ${label} from the Keychain: ${why}. Allow access when the system asks, or enter the key again in Settings.`,
      );
    }
  };
