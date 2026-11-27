import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

const firstHeaderValue = (value: string | undefined): string | undefined => {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
};

const isValidForwardedHost = (host: string): boolean => {
  try {
    const parsed = new URL(`http://${host}`);
    return (
      parsed.host !== "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
};

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https` and
 * `X-Forwarded-Host`. Effect 4.1 stopped reading forwarded headers, but
 * proxies and the Gustaf relay host rely on them for OAuth, DPoP and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> => {
  const base = HttpServerRequest.toURL(request);
  if (Option.isNone(base)) {
    return base;
  }
  const forwardedProto =
    firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() === "https" &&
    base.value.protocol !== "https:"
      ? "https:"
      : undefined;
  const rawForwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const forwardedHost =
    rawForwardedHost !== undefined && isValidForwardedHost(rawForwardedHost)
      ? rawForwardedHost
      : undefined;
  if (forwardedProto === undefined && forwardedHost === undefined) {
    return base;
  }
  const resolved = new URL(base.value.href);
  if (forwardedProto !== undefined) {
    resolved.protocol = forwardedProto;
  }
  if (forwardedHost !== undefined) {
    resolved.port = "";
    resolved.host = forwardedHost;
  }
  return Option.some(resolved);
};
