import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";

import { ApiError } from "./client";
import { createQueryClient, queryKeys } from "./queries";

function observe(
  client: ReturnType<typeof createQueryClient>,
  queryKey: ReadonlyArray<unknown>,
  queryFn: () => Promise<unknown>,
) {
  const observer = new QueryObserver(client, { queryKey, queryFn, retry: false });
  const { promise: settled, resolve } = Promise.withResolvers<void>();
  const unsubscribe = observer.subscribe((result) => {
    if (result.status !== "pending" && result.fetchStatus === "idle") resolve();
  });
  return { settled, unsubscribe };
}

describe("createQueryClient", () => {
  it("does not refetch /v1/me in a loop when it answers 401", async () => {
    const client = createQueryClient();
    let calls = 0;
    const me = observe(client, queryKeys.me, async () => {
      calls += 1;
      throw new ApiError(401, "Unauthorized");
    });
    await me.settled;
    expect(calls).toBe(1);
    expect(client.isFetching({ queryKey: queryKeys.me })).toBe(0);
    me.unsubscribe();
  });

  it("rechecks /v1/me when an admin request answers 401", async () => {
    const client = createQueryClient();
    let meCalls = 0;
    const me = observe(client, queryKeys.me, async () => {
      meCalls += 1;
      return { id: "a1", role: "admin" };
    });
    await me.settled;
    const overview = observe(client, queryKeys.overview, async () => {
      throw new ApiError(401, "Session expired");
    });
    await overview.settled;
    expect(client.isFetching({ queryKey: queryKeys.me })).toBe(1);
    me.unsubscribe();
    overview.unsubscribe();
    expect(meCalls).toBe(2);
  });
});
