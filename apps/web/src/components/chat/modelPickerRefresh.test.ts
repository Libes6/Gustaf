import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MODEL_PICKER_REFRESH_INTERVAL_MS,
  takeModelPickerRefreshTargets,
} from "./modelPickerRefresh";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ollama = ProviderInstanceId.make("ollama");
const codex = ProviderInstanceId.make("codex");

describe("takeModelPickerRefreshTargets", () => {
  it("refreshes each instance at most once per interval and environment", () => {
    const stamps = new Map<string, number>();
    const take = (environmentId: EnvironmentId, instanceIds: ProviderInstanceId[], now: number) =>
      takeModelPickerRefreshTargets(stamps, { environmentId, instanceIds, now });

    expect(take(local, [ollama, codex], 0)).toEqual([ollama, codex]);
    expect(take(local, [ollama, codex], MODEL_PICKER_REFRESH_INTERVAL_MS - 1)).toEqual([]);
    expect(take(remote, [ollama], 1)).toEqual([ollama]);
    expect(take(local, [ollama], MODEL_PICKER_REFRESH_INTERVAL_MS)).toEqual([ollama]);
    // Codex was not stamped by the previous open, so its own window has passed too.
    expect(take(local, [ollama, codex], MODEL_PICKER_REFRESH_INTERVAL_MS + 1)).toEqual([codex]);
  });
});
