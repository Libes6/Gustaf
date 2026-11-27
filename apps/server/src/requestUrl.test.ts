import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { requestUrl } from "./requestUrl.ts";

const makeRequest = (url: string, headers: Record<string, string> = {}) => {
  const parsed = new URL(url);
  return HttpServerRequest.fromWeb(new Request(url)).modify({
    headers: Headers.fromInput({ host: parsed.host, ...headers }),
  });
};

describe("requestUrl", () => {
  it("returns the request URL as-is when no forwarded headers are set", () => {
    const url = requestUrl(makeRequest("http://127.0.0.1:3773/oauth/token?a=1"));
    expect(Option.map(url, (u) => u.href)).toEqual(
      Option.some("http://127.0.0.1:3773/oauth/token?a=1"),
    );
  });

  it("honors X-Forwarded-Proto: https and X-Forwarded-Host", () => {
    const url = requestUrl(
      makeRequest("http://127.0.0.1:3773/oauth/token", {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "laptop.relay.gustaf.invalid",
      }),
    );
    expect(Option.map(url, (u) => u.href)).toEqual(
      Option.some("https://laptop.relay.gustaf.invalid/oauth/token"),
    );
  });

  it("uses the first value from comma-separated forwarded headers", () => {
    const url = requestUrl(
      makeRequest("http://127.0.0.1:3773/ws?wsTicket=abc", {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "mac.example.com:8443, 127.0.0.1:3773",
      }),
    );
    expect(Option.map(url, (u) => u.href)).toEqual(
      Option.some("https://mac.example.com:8443/ws?wsTicket=abc"),
    );
  });

  it("ignores malformed X-Forwarded-Host values", () => {
    for (const badHost of [
      "",
      "evil.example/path",
      "user@evil.example",
      "evil.example?query=1",
      "evil.example#hash",
      "not a host",
    ]) {
      const url = requestUrl(
        makeRequest("http://127.0.0.1:3773/oauth/token", {
          "x-forwarded-host": badHost,
        }),
      );
      expect(Option.map(url, (u) => u.href)).toEqual(
        Option.some("http://127.0.0.1:3773/oauth/token"),
      );
    }
  });
});
