import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";

/** Read back by the server's `TraceDiagnostics.readClientCrashes`; keep the names in step. */
const CLIENT_CRASH_SPAN_NAME = "client.crash";
// A render loop can throw the same error many times a second.
const MAX_REPORTS_PER_PAGE = 20;

export type ClientCrashKind = "route" | "component" | "uncaught" | "unhandled-rejection";

const reported = new Set<string>();
let currentRoute = (): string => window.location.pathname;

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/** Records a UI crash as a failed span; the server keeps it in its local trace file. */
export function reportClientCrash(kind: ClientCrashKind, error: unknown, route = currentRoute()) {
  const cause = toError(error);
  const key = `${kind}\0${route}\0${cause.message}`;
  if (reported.has(key) || reported.size >= MAX_REPORTS_PER_PAGE) return;
  reported.add(key);
  runtime.runFork(
    Effect.die(cause).pipe(
      Effect.withSpan(CLIENT_CRASH_SPAN_NAME, {
        attributes: { "crash.kind": kind, "crash.route": route },
      }),
      Effect.exit,
    ),
  );
}

/** Reports uncaught errors and rejections; `readRoute` gives the router's path. */
export function installClientCrashReporting(readRoute: () => string): void {
  currentRoute = readRoute;
  window.addEventListener("error", (event) => {
    reportClientCrash("uncaught", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientCrash("unhandled-rejection", event.reason);
  });
}
