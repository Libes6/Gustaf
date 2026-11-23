import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as MobileSecureStorage from "../../persistence/mobile-secure-storage";

const SESSION_KEY = "gustaf.account.session";
const PHONE_DEVICE_KEY = "gustaf.account.phone-device";

const StoredSession = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.String,
    expiresAt: Schema.String,
    user: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.String,
      image: Schema.NullOr(Schema.String),
    }),
  }),
);
export type StoredSession = typeof StoredSession.Type;

// The device token authenticates this phone as a device; it is stored and never shown.
const StoredPhoneDevice = Schema.fromJsonString(
  Schema.Struct({ userId: Schema.String, deviceId: Schema.String, token: Schema.String }),
);
export type StoredPhoneDevice = typeof StoredPhoneDevice.Type;

const decodeSession = Schema.decodeUnknownEffect(StoredSession);
const decodePhoneDevice = Schema.decodeUnknownEffect(StoredPhoneDevice);
const encodeSession = Schema.encodeSync(StoredSession);
const encodePhoneDevice = Schema.encodeSync(StoredPhoneDevice);

const run = <A>(
  program: Effect.Effect<
    A,
    MobileSecureStorage.MobileSecureStorageError,
    MobileSecureStorage.MobileSecureStorage
  >,
) => Effect.runPromise(program.pipe(Effect.provide(MobileSecureStorage.layer)));

function read<A>(key: string, decode: (raw: string) => Effect.Effect<A, Schema.SchemaError>) {
  return run(
    Effect.gen(function* () {
      const storage = yield* MobileSecureStorage.MobileSecureStorage;
      const raw = yield* storage.getItem(key);
      if (raw === null) return null;
      // A record this build cannot read is treated as absent rather than blocking the screen.
      return yield* decode(raw).pipe(Effect.orElseSucceed(() => null));
    }),
  );
}

function write(key: string, value: string) {
  return run(
    Effect.flatMap(MobileSecureStorage.MobileSecureStorage, (storage) =>
      storage.setItem(key, value),
    ),
  );
}

function remove(key: string) {
  return run(
    Effect.flatMap(MobileSecureStorage.MobileSecureStorage, (storage) => storage.removeItem(key)),
  );
}

export const loadSession = (): Promise<StoredSession | null> => read(SESSION_KEY, decodeSession);
export const saveSession = (session: StoredSession) => write(SESSION_KEY, encodeSession(session));

export const loadPhoneDevice = (): Promise<StoredPhoneDevice | null> =>
  read(PHONE_DEVICE_KEY, decodePhoneDevice);
export const savePhoneDevice = (device: StoredPhoneDevice) =>
  write(PHONE_DEVICE_KEY, encodePhoneDevice(device));
export const clearPhoneDevice = () => remove(PHONE_DEVICE_KEY);

export async function clearAccount(): Promise<void> {
  await Promise.all([remove(SESSION_KEY), remove(PHONE_DEVICE_KEY)]);
}
