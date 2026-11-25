import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  DESKTOP_RENDERER_ORIGINS,
} from "./httpCors.ts";

const cors = HttpMiddleware.cors({
  allowedOrigins: [...DESKTOP_RENDERER_ORIGINS],
  credentials: true,
  allowedMethods: browserApiCorsAllowedMethods,
  allowedHeaders: browserApiCorsAllowedHeaders,
});

const allowedOriginFor = (origin: string) =>
  Effect.gen(function* () {
    const request = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1:3773/api/health", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      }),
    );
    const response = yield* cors(Effect.succeed(HttpServerResponse.empty())).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    return response.headers["access-control-allow-origin"];
  });

it("lists the packaged and development Gustaf renderer origins", () => {
  assert.deepEqual([...DESKTOP_RENDERER_ORIGINS], ["gustaf://app", "gustaf-dev://app"]);
});

it.effect.each(["gustaf://app", "gustaf-dev://app"])("echoes the %s renderer origin", (origin) =>
  Effect.map(allowedOriginFor(origin), (allowed) => assert.equal(allowed, origin)),
);

it.effect("does not echo the retired T3 renderer origins", () =>
  Effect.gen(function* () {
    for (const origin of ["t3code://app", "t3code-dev://app"]) {
      assert.notEqual(yield* allowedOriginFor(origin), origin);
    }
  }),
);
