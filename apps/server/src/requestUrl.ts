import * as Option from "effect/Option";
import { Headers, HttpServerRequest } from "effect/http";

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
  const forwardedProto =
    firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() === "https" &&
    request.protocol !== "https"
      ? ("https" as const)
      : undefined;
  const rawForwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const forwardedHost =
    rawForwardedHost !== undefined && isValidForwardedHost(rawForwardedHost)
      ? rawForwardedHost
      : undefined;
  if (forwardedProto === undefined && forwardedHost === undefined) {
    return HttpServerRequest.toURL(request);
  }
  return HttpServerRequest.toURL(
    request.modify({
      ...(forwardedProto !== undefined ? { protocol: forwardedProto } : {}),
      ...(forwardedHost !== undefined
        ? { headers: Headers.set(request.headers, "host", forwardedHost) }
        : {}),
    }),
  );
};
