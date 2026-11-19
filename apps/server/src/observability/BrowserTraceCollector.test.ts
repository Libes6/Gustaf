import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";

const recordingSink = () => {
  const names: string[] = [];
  const sink: TraceSink = {
    filePath: "/logs/sink.ndjson",
    push: (record) => names.push(record.name),
    flush: Effect.void,
    close: () => Effect.void,
  };
  return { names, sink };
};

it.effect("keeps client crashes in their own log as well as the trace log", () =>
  Effect.gen(function* () {
    const trace = recordingSink();
    const crashes = recordingSink();
    const collector = BrowserTraceCollector.make(trace.sink, crashes.sink);
    yield* collector.record([
      { name: "browser.request" } as TraceRecord,
      { name: "client.crash" } as TraceRecord,
    ]);
    expect(trace.names).toEqual(["browser.request", "client.crash"]);
    expect(crashes.names).toEqual(["client.crash"]);
  }),
);
