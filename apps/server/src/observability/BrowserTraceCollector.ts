import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CLIENT_CRASH_SPAN_NAME } from "../diagnostics/TraceDiagnostics.ts";

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

/**
 * `crashSink` keeps UI crashes after the busy trace log has rotated them away.
 * @public
 */
export const make = (sink: TraceSink, crashSink?: TraceSink): BrowserTraceCollector["Service"] =>
  BrowserTraceCollector.of({
    record: Effect.fn("BrowserTraceCollector.record")(function (records) {
      return Effect.sync(() => {
        for (const record of records) {
          sink.push(record);
          if (record.name === CLIENT_CRASH_SPAN_NAME) crashSink?.push(record);
        }
      });
    }),
  });

export const layer = (sink: TraceSink, crashSink?: TraceSink) =>
  Layer.succeed(BrowserTraceCollector, make(sink, crashSink));
