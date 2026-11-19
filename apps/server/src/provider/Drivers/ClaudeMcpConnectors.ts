import {
  query as claudeQuery,
  type McpServerStatus,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpConnector, McpConnectorAuthorizeResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

// Bedrock and slow hosts need longer than first-party startup, as in the capabilities probe.
const PROBE_START_TIMEOUT = Duration.seconds(25);
const CONNECTORS_SETTLE_TIMEOUT = Duration.seconds(20);
const CONNECTORS_SETTLE_POLL = Duration.millis(500);
// The CLI's loopback listener lives in the probe process, so the probe waits this long for the browser.
const AUTHORIZE_CALLBACK_TIMEOUT = Duration.minutes(10);
const AUTHORIZE_CALLBACK_POLL = Duration.seconds(2);

export class ClaudeMcpConnectorError extends Schema.TaggedError<ClaudeMcpConnectorError>()(
  "ClaudeMcpConnectorError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/** `mcp_authenticate` and `mcp_oauth_callback_url` exist on the SDK's Query but are not in its typings. */
interface ClaudeMcpAuthQuery {
  readonly mcpAuthenticate?: (server: string, redirectUri?: string) => Promise<unknown>;
  readonly mcpSubmitOAuthCallbackUrl?: (server: string, callbackUrl: string) => Promise<unknown>;
}

const AuthenticateResponse = Schema.Struct({
  authUrl: Schema.optional(Schema.String),
  callbackExpected: Schema.optional(Schema.Boolean),
});
const decodeAuthenticateResponse = Schema.decodeUnknownEffect(AuthenticateResponse);

export function claudeMcpConnector(
  status: McpServerStatus,
  authorizing: boolean,
): McpConnector | undefined {
  if (status.source === "sdk" || status.source === "dynamic") return undefined;
  const type = status.config?.type;
  const auth =
    type === "claudeai-proxy" || status.source === "claudeai" || status.scope === "claudeai"
      ? "claudeai"
      : type === "http" || type === "sse"
        ? "oauth"
        : "none";
  const source = status.source ?? status.scope;
  return {
    name: status.name,
    status: status.status,
    auth,
    ...(source === undefined ? {} : { source }),
    authorizing,
  };
}

interface ClaudeMcpProbe {
  readonly statuses: Effect.Effect<ReadonlyArray<McpServerStatus>, ClaudeMcpConnectorError>;
  readonly authQuery: ClaudeMcpAuthQuery;
  readonly close: Effect.Effect<void>;
}

export interface ClaudeMcpConnectorsInput {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly defaultCwd: string;
  /** Re-dials a server in the instance's running threads once it has signed in. */
  readonly reconnectOpenSessions: (server: string) => Effect.Effect<void>;
}

/**
 * Lists and signs in to the MCP servers Claude Code loads by itself: claude.ai connectors and the
 * servers in its user, project and local config. Each call runs its own idle Claude process.
 */
export const makeClaudeMcpConnectors = (input: ClaudeMcpConnectorsInput) => {
  const pending = new Map<string, ClaudeMcpProbe>();
  // A claude.ai sign-in finishes on claude.ai, so a later list is the first to see it.
  const lastNeedingAuth = new Set<string>();

  // A plain function: the AbortController is the SDK's cancellation handle, made per probe.
  const openProbe = (cwd: string | undefined) => {
    const abort = new AbortController();
    const close = Effect.sync(() => {
      if (!abort.signal.aborted) abort.abort();
    });
    const options: ClaudeQueryOptions = {
      persistSession: false,
      pathToClaudeCodeExecutable: input.executablePath,
      abortController: abort,
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: true },
      allowedTools: [],
      env: {
        ...input.environment,
        FORCE_CODE_TERMINAL: undefined,
        CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      },
      cwd: cwd ?? input.defaultCwd,
      stderr: () => {},
    };
    return Effect.tryPromise({
      try: async () => {
        const q = claudeQuery({
          // oxlint-disable-next-line require-yield -- never yields, so no prompt reaches the API
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await new Promise<void>((resolve) =>
              abort.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          })(),
          options,
        });
        await q.initializationResult();
        return q;
      },
      catch: (cause) =>
        new ClaudeMcpConnectorError({ detail: "Claude Code did not start.", cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: PROBE_START_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ClaudeMcpConnectorError({ detail: "Claude Code did not start in time." }),
          ),
      }),
      Effect.map((q): ClaudeMcpProbe => ({
        statuses: Effect.tryPromise({
          try: () => q.mcpServerStatus(),
          catch: (cause) =>
            new ClaudeMcpConnectorError({
              detail: "Claude Code did not report its MCP servers.",
              cause,
            }),
        }),
        authQuery: q as unknown as ClaudeMcpAuthQuery,
        close,
      })),
      Effect.onError(() => close),
      Effect.withSpan("ClaudeMcpConnectors.openProbe"),
    );
  };

  // Servers connect after initialization; claude.ai connectors are fetched later still.
  const settledStatuses = (probe: ClaudeMcpProbe) =>
    probe.statuses.pipe(
      Effect.repeat({
        until: (statuses) => !statuses.some((status) => status.status === "pending"),
        schedule: Schedule.spaced(CONNECTORS_SETTLE_POLL),
      }),
      Effect.timeoutOrElse({ duration: CONNECTORS_SETTLE_TIMEOUT, orElse: () => probe.statuses }),
    );

  const list = Effect.fn("ClaudeMcpConnectors.list")(function* (cwd: string | undefined) {
    const statuses = yield* Effect.acquireUseRelease(
      openProbe(cwd),
      settledStatuses,
      (probe) => probe.close,
    );
    for (const status of statuses) {
      if (status.status === "needs-auth") {
        lastNeedingAuth.add(status.name);
      } else if (status.status === "connected" && lastNeedingAuth.delete(status.name)) {
        yield* input.reconnectOpenSessions(status.name);
      }
    }
    return statuses.flatMap((status) => {
      const connector = claudeMcpConnector(status, pending.has(status.name));
      return connector === undefined ? [] : [connector];
    });
  });

  const finishFlow = (name: string, probe: ClaudeMcpProbe) =>
    Effect.suspend(() => {
      if (pending.get(name) === probe) pending.delete(name);
      return probe.close;
    });

  // The CLI finishes the sign-in and reconnects inside the probe; the probe stays up until then.
  const awaitSignIn = (name: string, probe: ClaudeMcpProbe) =>
    probe.statuses.pipe(
      Effect.map((statuses) => statuses.find((status) => status.name === name)?.status),
      Effect.repeat({
        until: (status) => status === "connected",
        schedule: Schedule.spaced(AUTHORIZE_CALLBACK_POLL),
      }),
      Effect.timeout(AUTHORIZE_CALLBACK_TIMEOUT),
      Effect.andThen(() => input.reconnectOpenSessions(name)),
      Effect.ignore,
      Effect.ensuring(finishFlow(name, probe)),
    );

  const authorize = Effect.fn("ClaudeMcpConnectors.authorize")(function* (request: {
    readonly name: string;
    readonly cwd: string | undefined;
  }) {
    const previous = pending.get(request.name);
    if (previous !== undefined) yield* finishFlow(request.name, previous);
    const probe = yield* openProbe(request.cwd);
    const started = yield* Effect.gen(function* () {
      const authenticate = probe.authQuery.mcpAuthenticate;
      if (authenticate === undefined) {
        return yield* new ClaudeMcpConnectorError({
          detail: "This Claude Code version cannot sign in to MCP servers. Update Claude Code.",
        });
      }
      const statuses = yield* settledStatuses(probe);
      if (!statuses.some((status) => status.name === request.name)) {
        return yield* new ClaudeMcpConnectorError({
          detail: `Claude Code has no MCP server named ${request.name}.`,
        });
      }
      const response = yield* Effect.tryPromise({
        try: () => authenticate.call(probe.authQuery, request.name),
        catch: (cause) =>
          new ClaudeMcpConnectorError({
            detail:
              cause instanceof Error && cause.message
                ? cause.message
                : `Claude Code could not start the sign-in to ${request.name}.`,
            cause,
          }),
      });
      return yield* decodeAuthenticateResponse(response).pipe(
        Effect.mapError(
          (cause) =>
            new ClaudeMcpConnectorError({
              detail: "Claude Code answered the sign-in request in an unknown format.",
              cause,
            }),
        ),
      );
    }).pipe(Effect.onError(() => probe.close));
    const callbackExpected = started.callbackExpected === true;
    if (callbackExpected) {
      pending.set(request.name, probe);
      yield* Effect.forkDetach(awaitSignIn(request.name, probe));
    } else {
      yield* probe.close;
      lastNeedingAuth.add(request.name);
      if (started.authUrl === undefined) yield* input.reconnectOpenSessions(request.name);
    }
    return {
      ...(started.authUrl === undefined ? {} : { authUrl: started.authUrl }),
      callbackExpected,
    } satisfies McpConnectorAuthorizeResult;
  });

  const submitCallback = Effect.fn("ClaudeMcpConnectors.submitCallback")(function* (request: {
    readonly name: string;
    readonly callbackUrl: string;
  }) {
    const probe = pending.get(request.name);
    const submit = probe?.authQuery.mcpSubmitOAuthCallbackUrl;
    if (probe === undefined || submit === undefined) {
      return yield* new ClaudeMcpConnectorError({
        detail: `No sign-in to ${request.name} is waiting. Start it again.`,
      });
    }
    yield* Effect.tryPromise({
      try: () => submit.call(probe.authQuery, request.name, request.callbackUrl),
      catch: (cause) =>
        new ClaudeMcpConnectorError({
          detail:
            cause instanceof Error && cause.message
              ? cause.message
              : `Claude Code did not accept the address for ${request.name}.`,
          cause,
        }),
    });
  });

  return { list, authorize, submitCallback };
};
