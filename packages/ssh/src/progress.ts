import type { DesktopSshEnsureProgress, DesktopSshEnsureProgressStep } from "@t3tools/contracts";

export type SshProgressSink = (event: DesktopSshEnsureProgress) => void;

/** The remote launch and runner scripts print `<marker> <name>` on stderr at each stage. */
export const SSH_PROGRESS_MARKER = "@@gustaf-progress@@";

const MAX_PROGRESS_TEXT_LENGTH = 400;
const MAX_PROGRESS_TEXT_LINES = 6;

// Progress text reaches the renderer and gets copied into bug reports, so it
// carries no credentials, key paths or user names, and stays short.
export function scrubSshProgressText(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => !line.includes(SSH_PROGRESS_MARKER))
    .map((line) =>
      line
        .replace(
          /("(?:access_token|bearerToken|credential|pairingToken|token|password|passphrase|secret)"\s*:\s*")[^"]*(")/giu,
          "$1[redacted]$2",
        )
        .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
        .replace(
          /\b(token|credential|password|passphrase|secret|pairing[-_ ]?code)(\s*[=:]\s*)\S+/giu,
          "$1$2[redacted]",
        )
        .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gu, "$1")
        .replace(/(\s-i\s+|IdentityFile\s+)\S+/gu, "$1[key]")
        .replace(/\S*\.ssh\/\S+/gu, "[key]")
        .replace(/\S+\.(?:pem|ppk|key)\b/gu, "[key]")
        .replace(/(?:\/Users|\/home)\/[^/\s]+/gu, "~")
        .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gu, "~")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(0, MAX_PROGRESS_TEXT_LINES);
  const joined = lines.join("\n");
  return joined.length > MAX_PROGRESS_TEXT_LENGTH
    ? `${joined.slice(0, MAX_PROGRESS_TEXT_LENGTH)}…`
    : joined;
}

export interface SshProgressReporter {
  /** Starts `step`; whichever step was running before it is done. */
  readonly enter: (step: DesktopSshEnsureProgressStep, detail?: string) => void;
  /** Finishes the running step, if any. */
  readonly finish: (detail?: string) => void;
  /** Marks the running step, or the last one, failed with a scrubbed `message`. */
  readonly fail: (message: string) => void;
  readonly active: () => DesktopSshEnsureProgressStep | null;
}

const noopReporter: SshProgressReporter = {
  enter: () => {},
  finish: () => {},
  fail: () => {},
  active: () => null,
};

export function makeSshProgressReporter(
  sink: SshProgressSink | undefined,
  now: () => number = Date.now,
): SshProgressReporter {
  if (sink === undefined) return noopReporter;
  let active: DesktopSshEnsureProgressStep | null = null;
  let last: DesktopSshEnsureProgressStep | null = null;
  const emit = (
    step: DesktopSshEnsureProgressStep,
    status: DesktopSshEnsureProgress["status"],
    detail: string | undefined,
  ) => {
    const scrubbed = detail === undefined ? "" : scrubSshProgressText(detail);
    // A sink is renderer plumbing; its failure must not fail the SSH operation.
    try {
      sink({ step, status, ...(scrubbed === "" ? {} : { detail: scrubbed }), at: now() });
    } catch {}
  };
  const finish = (detail?: string) => {
    if (active === null) return;
    const step = active;
    active = null;
    emit(step, "done", detail);
  };
  return {
    enter: (step, detail) => {
      if (active === step) {
        emit(step, "running", detail);
        return;
      }
      finish();
      active = step;
      last = step;
      emit(step, "running", detail);
    },
    finish,
    fail: (message) => {
      const step = active ?? last ?? "resolve-host";
      active = null;
      last = step;
      emit(step, "failed", message);
    },
    active: () => active,
  };
}

/** The part of a remote launch the markers need to describe. */
export interface SshRemoteProgressContext {
  readonly version: string | null;
  readonly downloadHost: string | null;
}

const withDetail = (...parts: ReadonlyArray<string | null | undefined>) => {
  const joined = parts.filter((part) => part !== null && part !== undefined && part !== "");
  return joined.length === 0 ? undefined : joined.join(" · ");
};

/** Turns one remote stage marker into progress events. Unknown names are ignored. */
export function applyRemoteProgressMarker(
  reporter: SshProgressReporter,
  marker: string,
  context: SshRemoteProgressContext,
): void {
  const version = context.version === null ? null : `v${context.version}`;
  switch (marker.trim()) {
    case "connected":
      reporter.finish("connected");
      return;
    case "runtime.check":
      reporter.enter("runtime-check", version ?? undefined);
      return;
    case "runtime.download":
      if (reporter.active() === "runtime-check")
        reporter.finish(withDetail(version, "not installed"));
      reporter.enter("runtime-download", withDetail(version, context.downloadHost));
      return;
    case "runtime.verify":
      reporter.enter("runtime-verify", "SHA-256");
      return;
    case "runtime.install":
      reporter.enter("runtime-install", version ?? undefined);
      return;
    case "runtime.ready":
      reporter.finish(reporter.active() === "runtime-check" ? "already installed" : undefined);
      return;
    case "server.check":
      reporter.enter("server-check");
      return;
    case "server.reuse":
      reporter.enter("server-reuse");
      return;
    case "server.start":
      reporter.enter("server-start");
      return;
    case "server.ready":
      reporter.finish();
      return;
    default:
  }
}

/** Splits stderr chunks into text and marker names, holding back a line that may still become a marker. */
export function makeRemoteProgressLineFilter(onMarker: (marker: string) => void) {
  let pending = "";
  const couldBeMarker = (text: string) =>
    text.startsWith(SSH_PROGRESS_MARKER) || SSH_PROGRESS_MARKER.startsWith(text);
  return (chunk: string): string => {
    pending += chunk;
    let text = "";
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      if (line.startsWith(SSH_PROGRESS_MARKER)) {
        onMarker(line.slice(SSH_PROGRESS_MARKER.length).trim());
      } else {
        text += line;
      }
    }
    if (pending !== "" && !couldBeMarker(pending)) {
      text += pending;
      pending = "";
    }
    return text;
  };
}
