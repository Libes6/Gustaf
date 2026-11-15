// @effect-diagnostics nodeBuiltinImport:off -- reads the native transcript tail without following links.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const NATIVE_SESSION_ID = /^[\w-]+$/;
const POLL_INTERVAL = "2 seconds";
// One poll never reads more than this; a wake line is short and sits near the end.
const MAX_READ_BYTES = 256 * 1024;

const decodeStepType = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);

/** agy injects a finished command or subagent into its planner as a SYSTEM_MESSAGE step. */
export function antigravityTranscriptHasWake(lines: string): boolean {
  return lines.split("\n").some((line) =>
    Option.match(decodeStepType(line), {
      onNone: () => false,
      onSome: (step) => step.type === "SYSTEM_MESSAGE",
    }),
  );
}

async function transcriptPath(profileDirectory: string, sessionId: string) {
  const root = await antigravityProfileRoot(profileDirectory);
  if (root === undefined) return undefined;
  return (
    await antigravityManagedPath(
      root,
      ["antigravity-acp", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"],
      "file",
    )
  )?.path;
}

async function readFrom(path: string, offset: number) {
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const size = (await handle.stat()).size;
    if (size <= offset) return { end: size, text: "" };
    const start = Math.max(offset, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Keep a line agy is still writing for the next poll.
    const complete = text.lastIndexOf("\n") + 1;
    return {
      end: start + Buffer.byteLength(text.slice(0, complete)),
      text: text.slice(0, complete),
    };
  } finally {
    await handle.close();
  }
}

/**
 * agy answers `end_turn` while a command or subagent still runs, then wakes its planner
 * with the result and writes it only to this session's transcript. Called when the
 * prompt returns, the inner effect ends at the first wake written after that point.
 * Without a readable transcript it never ends, and the caller's backoff decides.
 */
export const watchAntigravityBackgroundWake = Effect.fn("AntigravityBackgroundWake.watch")(
  function* (profileDirectory: string, sessionId: string) {
    if (!NATIVE_SESSION_ID.test(sessionId)) return Effect.never;
    // An unreadable transcript only loses the early wake; the backoff still re-attaches.
    const start = yield* Effect.promise(() =>
      transcriptPath(profileDirectory, sessionId)
        .then(async (path) =>
          path === undefined ? undefined : { path, offset: (await NodeFSP.stat(path)).size },
        )
        .catch(() => undefined),
    );
    if (start === undefined) return Effect.never;
    let offset = start.offset;
    const poll = Effect.promise(() =>
      readFrom(start.path, offset).then(
        ({ end, text }) => {
          offset = end;
          return antigravityTranscriptHasWake(text);
        },
        () => false,
      ),
    );
    return Effect.sleep(POLL_INTERVAL).pipe(
      Effect.andThen(poll),
      Effect.repeat({ until: (woke) => woke }),
      Effect.asVoid,
    );
  },
);
