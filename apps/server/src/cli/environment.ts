import {
  AuthMcpClientAccess,
  EnvironmentId,
  PeerLinkError,
  peerLinkFailureKind,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RelayPeerTransport from "../relay/RelayPeerTransport.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { expandHomePath } from "../os-jank.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Links live in this environment's database and secret store, so these
 * commands work whether or not its server is running.
 */
const runWithPeerLinks = Effect.fn("environment.runWithPeerLinks")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (links: PeerLinks.PeerLinks["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* PeerLinks.PeerLinks.pipe(
    Effect.flatMap(run),
    // A refused or unreachable link is an expected outcome: print its message, not a stack.
    Effect.catchIf(Schema.is(PeerLinkError), (error) =>
      Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message })),
    ),
    Effect.provide(
      PeerLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerCliConfig,
            // A relay link goes through a tunnel to a computer on the same Gustaf account.
            RelayPeerTransport.layerHttpClient.pipe(
              Layer.provideMerge(RelayPeerTransport.layer),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(ServerSecretStore.layer),
            ),
          ),
        ),
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provide(
          ServerSettings.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSecretStore.layer,
                SqlitePersistence.layerCliConfig,
                ManagedPolicy.layer,
              ),
            ),
          ),
        ),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeLinks = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(Schema.Unknown))),
);

const formatLinks = (links: ReadonlyArray<PeerLinkSummary>) =>
  links.length === 0
    ? "No linked environments.\n"
    : `${links
        .map(
          (link) =>
            `${link.label} (${link.environmentId})\n  ${link.status}, access ${link.access}, expires ${DateTime.formatIso(link.expiresAt)}\n  ${link.urls.join(", ")}${link.lastError === null ? "" : `\n  last error: ${link.lastError}`}`,
        )
        .join("\n\n")}\n`;

export class EnvironmentLinkUsageError extends Schema.TaggedError<EnvironmentLinkUsageError>()(
  "EnvironmentLinkUsageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class EnvironmentLinkBatchError extends Schema.TaggedError<EnvironmentLinkBatchError>()(
  "EnvironmentLinkBatchError",
  { failed: Schema.Number, total: Schema.Number },
) {
  override get message(): string {
    return `${this.failed} of ${this.total} environments were not linked.`;
  }
}

/** Pairings a batch opens at once, so a fleet is not signed in to all at the same moment. */
const LINK_BATCH_CONCURRENCY = 4;

const FAILURE_KIND_LABELS = {
  unreachable: "unreachable",
  code_refused: "code refused",
  wrong_environment: "wrong environment answered",
  other: "failed",
} as const;

/**
 * How a result line names its entry: the address's origin, since a username,
 * password, path or query in it may be a credential and stdout is kept in logs.
 */
const linkBatchEntryName = (entry: { readonly line: number; readonly url: string }) => {
  const parsed = URL.parse(entry.url);
  return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:")
    ? parsed.origin
    : `line ${entry.line}`;
};

/** One `<url> <pairing-code>` per line; blank lines and `#` comments are skipped. */
const parseLinkBatch = (text: string) =>
  text.split(/\r?\n/).flatMap((raw, index) => {
    const fields = raw.trim().split(/\s+/);
    if (raw.trim().length === 0 || raw.trim().startsWith("#")) return [];
    const [url, pairingCode] = fields;
    return [
      url !== undefined && pairingCode !== undefined && fields.length === 2
        ? { line: index + 1, url, pairingCode }
        : { line: index + 1, url: url ?? "", pairingCode: null },
    ];
  });

const linkBatch = Effect.fn("environment.linkBatch")(function* (
  links: PeerLinks.PeerLinks["Service"],
  text: string,
  access: AuthMcpClientAccess,
) {
  const entries = parseLinkBatch(text);
  if (entries.length === 0) {
    return yield* new EnvironmentLinkUsageError({
      detail: "Nothing to link: expected lines of `<url> <pairing-code>`.",
    });
  }
  // Results never include a pairing code, only where it was sent.
  const outcomes = yield* Effect.forEach(
    entries,
    (entry) =>
      entry.pairingCode === null
        ? Effect.succeed({
            linked: false,
            text: `line ${entry.line}: failed: expected \`<url> <pairing-code>\``,
          })
        : links.linkUnlessLinked({ url: entry.url, pairingCode: entry.pairingCode, access }).pipe(
            Effect.map(({ link, alreadyLinked }) => ({
              linked: true,
              text: alreadyLinked
                ? `${linkBatchEntryName(entry)}: already linked as ${link.label} (${link.environmentId}), left as it is`
                : `${linkBatchEntryName(entry)}: linked ${link.label} (${link.environmentId}) with ${link.access} access`,
            })),
            Effect.catch((error) =>
              Effect.succeed({
                linked: false,
                text: `${linkBatchEntryName(entry)}: ${FAILURE_KIND_LABELS[peerLinkFailureKind(error)]}: ${error.message}`,
              }),
            ),
          ),
    { concurrency: LINK_BATCH_CONCURRENCY },
  );
  const failed = outcomes.filter((outcome) => !outcome.linked).length;
  yield* Console.log(
    `${outcomes.map((outcome) => outcome.text).join("\n")}\n\n${outcomes.length - failed} of ${outcomes.length} linked.\n`,
  );
  if (failed > 0) {
    return yield* new EnvironmentLinkBatchError({ failed, total: outcomes.length });
  }
});

const readLinkBatch = Effect.fn("environment.readLinkBatch")(function* (from: string) {
  if (from === "-") {
    return yield* Stdio.Stdio.pipe(
      Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* expandHomePath(from));
});

interface RelayMachineChoice {
  readonly deviceId: string;
  readonly name: string;
  readonly online: boolean;
  readonly linkedEnvironmentId?: string;
}

const describeRelayMachines = (machines: ReadonlyArray<RelayMachineChoice>) =>
  machines
    .map(
      (machine) =>
        `${machine.name} (${machine.deviceId}) ${machine.online ? "online" : "offline"}${
          machine.linkedEnvironmentId === undefined
            ? ""
            : `, linked as ${machine.linkedEnvironmentId}`
        }`,
    )
    .join("\n");

/**
 * The computer a `--relay` value names: its device id, else its name as the account shows it
 * (any capitalisation), else the only name that contains it. Anything unclear lists the choices.
 */
const pickRelayMachine = Effect.fn("environment.pickRelayMachine")(function* (
  machines: ReadonlyArray<RelayMachineChoice>,
  wanted: string,
) {
  const query = wanted.trim().toLowerCase();
  const byId = machines.filter((machine) => machine.deviceId.toLowerCase() === query);
  const byName = machines.filter((machine) => machine.name.toLowerCase() === query);
  const matches =
    byId.length > 0
      ? byId
      : byName.length > 0
        ? byName
        : machines.filter((machine) => machine.name.toLowerCase().includes(query));
  const [only, ...others] = matches;
  if (only !== undefined && others.length === 0) return only;
  return yield* new EnvironmentLinkUsageError({
    detail:
      machines.length === 0
        ? "No other computers are on this Gustaf account."
        : `${matches.length === 0 ? `No computer on this Gustaf account matches "${wanted}".` : `More than one computer matches "${wanted}"; use its device id.`} Choose one of:\n${describeRelayMachines(matches.length === 0 ? machines : matches)}`,
  });
});

const environmentLinkCommand = Command.make("link", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription(
      "Where the other environment answers: its T3 Connect, Tailscale, LAN or loopback address.",
    ),
    Argument.optional,
  ),
  alternateUrl: Flag.String("url").pipe(
    Flag.withDescription("Another address for the same environment, tried after the first."),
    Flag.atLeast(0),
  ),
  pairingCode: Flag.String("pairing-code").pipe(
    Flag.withDescription("A pairing code from the other environment (`t3 pair` there)."),
    Flag.optional,
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription(
      "Link several environments: a file with one `<url> <pairing-code>` per line, or - for stdin. Environments already linked are left as they are.",
    ),
    Flag.optional,
  ),
  relay: Flag.String("relay").pipe(
    Flag.withDescription(
      "Link another computer on this Gustaf account through the Gustaf relay, by its name or device id (`t3 environment machines` lists them). No address and no pairing code: someone at that computer has to allow it in Gustaf, and the safety code printed here must match the one shown there.",
    ),
    Flag.optional,
  ),
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What this environment's agents may do there: read-only, or the broadest runtime mode.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
}).pipe(
  Command.withDescription(
    "Link another Gustaf environment, so agents here can work there. It shows up there under Authorized clients in Settings → Sharing & access, where it can be revoked.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.relay)) {
        if (
          Option.isSome(flags.url) ||
          Option.isSome(flags.pairingCode) ||
          Option.isSome(flags.from) ||
          flags.alternateUrl.length > 0
        ) {
          return yield* new EnvironmentLinkUsageError({
            detail: "--relay takes no address, --url, --pairing-code or --from.",
          });
        }
        const wanted = flags.relay.value;
        const runFork = Effect.runForkWith(yield* Effect.context<never>());
        return yield* runWithPeerLinks(flags, (links) =>
          Effect.gen(function* () {
            const listed = yield* links.relayMachines;
            if (listed.problem === "signed_out") {
              return yield* new EnvironmentLinkUsageError({
                detail:
                  "This computer is not signed in to the Gustaf relay. Run `gustaf relay login` first.",
              });
            }
            if (listed.problem === "unavailable") {
              return yield* new EnvironmentLinkUsageError({
                detail: "The Gustaf relay did not answer. Try again in a moment.",
              });
            }
            const machine = yield* pickRelayMachine(listed.machines, wanted);
            const linked = yield* links.linkRelay(
              { deviceId: machine.deviceId, access: flags.access },
              {
                onSafetyCode: (code) =>
                  void runFork(
                    Console.log(
                      `Waiting for ${machine.name} to allow this. Open Gustaf there and check that it shows this code before allowing it:\n  ${code}\n(On a computer with no screen: gustaf relay requests, then gustaf relay allow <id>.)\n`,
                    ),
                  ),
              },
            );
            yield* Console.log(
              `Linked ${linked.label} (${linked.environmentId}) with ${linked.access} access, until ${DateTime.formatIso(linked.expiresAt)}.\n`,
            );
          }),
        );
      }
      if (Option.isSome(flags.from)) {
        if (
          Option.isSome(flags.url) ||
          Option.isSome(flags.pairingCode) ||
          flags.alternateUrl.length > 0
        ) {
          return yield* new EnvironmentLinkUsageError({
            detail: "--from takes its addresses and pairing codes from the file.",
          });
        }
        const text = yield* readLinkBatch(flags.from.value);
        return yield* runWithPeerLinks(flags, (links) => linkBatch(links, text, flags.access));
      }
      if (Option.isNone(flags.url) || Option.isNone(flags.pairingCode)) {
        return yield* new EnvironmentLinkUsageError({
          detail: "Give an address and --pairing-code, --from <file>, or --relay <computer>.",
        });
      }
      const url = flags.url.value;
      const pairingCode = flags.pairingCode.value;
      return yield* runWithPeerLinks(flags, (links) =>
        Effect.gen(function* () {
          const linked = yield* links.link({
            url,
            alternateUrls: flags.alternateUrl,
            pairingCode,
            access: flags.access,
          });
          yield* Console.log(
            `Linked ${linked.label} (${linked.environmentId}) with ${linked.access} access, until ${DateTime.formatIso(linked.expiresAt)}.\n`,
          );
        }),
      );
    }),
  ),
);

const environmentListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List linked environments and whether each answers now."),
  Command.withHandler((flags) =>
    runWithPeerLinks(
      flags,
      (links) =>
        Effect.gen(function* () {
          const listed = yield* links.list;
          yield* Console.log(flags.json ? `${yield* encodeLinks(listed)}\n` : formatLinks(listed));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const environmentMachinesCommand = Command.make("machines", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List the other computers on this Gustaf account that `t3 environment link --relay` can reach, and which are online.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(
      flags,
      (links) =>
        Effect.gen(function* () {
          const listed = yield* links.relayMachines;
          if (flags.json) {
            yield* Console.log(`${yield* encodeJson(listed)}\n`);
          } else if (listed.problem === "signed_out") {
            yield* Console.log(
              "This computer is not signed in to the Gustaf relay. Run `gustaf relay login`.\n",
            );
          } else if (listed.problem === "unavailable") {
            yield* Console.log("The Gustaf relay did not answer.\n");
          } else {
            yield* Console.log(
              listed.machines.length === 0
                ? "No other computers on this Gustaf account.\n"
                : `${describeRelayMachines(listed.machines)}\n`,
            );
          }
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const environmentUnlinkCommand = Command.make("unlink", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `t3 environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Forget a linked environment here, and end its session there when that environment answers.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const { removed, endedThere } = yield* links.unlink(
          EnvironmentId.make(flags.environmentId),
        );
        yield* Console.log(
          !removed
            ? `No linked environment ${flags.environmentId}.\n`
            : endedThere
              ? `Forgot ${flags.environmentId} and ended its session there.\n`
              : `Forgot ${flags.environmentId}. It did not answer, so revoke it in that environment's Sharing & access to end its session there.\n`,
        );
      }),
    ),
  ),
);

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription("Link other Gustaf environments, so agents here can work there."),
  Command.withSubcommands([
    environmentLinkCommand,
    environmentMachinesCommand,
    environmentListCommand,
    environmentUnlinkCommand,
  ]),
);
