import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  antigravityTranscriptHasWake,
  watchAntigravityBackgroundWake,
} from "./AntigravityBackgroundWake.ts";

const SESSION = "7d40e54d-5977-4239-940b-246cdd81a12b";
const line = (type: string, content: string) =>
  `${JSON.stringify({ step_index: 4, type, status: "DONE", content })}\n`;

it.layer(NodeServices.layer)("watchAntigravityBackgroundWake", (it) => {
  it.effect("ends at the first wake agy writes after the prompt returned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-wake-" });
      const logs = path.join(profile, "antigravity-acp", "brain", SESSION, ".system_generated");
      yield* fs.makeDirectory(path.join(logs, "logs"), { recursive: true });
      const transcript = path.join(logs, "logs", "transcript.jsonl");
      yield* fs.writeFileString(transcript, line("PLANNER_RESPONSE", "Started the check."));

      const waitForWake = yield* watchAntigravityBackgroundWake(profile, SESSION);
      const wake = yield* waitForWake.pipe(Effect.forkScoped);
      yield* fs.writeFileString(
        transcript,
        line("SYSTEM_MESSAGE", "Command task-3 finished with exit code 0."),
        { flag: "a" },
      );
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(wake);
    }),
  );
});

it.each([
  ["a planner reply", line("PLANNER_RESPONSE", "Waiting for the command."), false],
  ["the wake agy injects", line("SYSTEM_MESSAGE", "Command task-3 finished."), true],
  ["a line agy is still writing", '{"step_index":5,"type":"SYSTEM_', false],
])("reads %s as a wake: %s", (_name, text, wake) => {
  expect(antigravityTranscriptHasWake(text)).toBe(wake);
});
