interface CorsRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

interface CorsResponse {
  setHeader(name: string, value: string): void;
  statusCode: number;
  end(): void;
}

// Credentialed CORS for the admin app's exact origins only; no wildcard, nothing when empty.
export function corsHeaders(request: CorsRequest, allowedOrigins: readonly string[]) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) return undefined;
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
  };
  if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
    headers["access-control-allow-methods"] = "GET, POST, PATCH, DELETE";
    headers["access-control-allow-headers"] = "content-type, x-requested-with";
    headers["access-control-max-age"] = "600";
  }
  return headers;
}

export function corsMiddleware(allowedOrigins: readonly string[]) {
  return (request: CorsRequest, response: CorsResponse, next: () => void) => {
    response.setHeader("vary", "Origin");
    const headers = corsHeaders(request, allowedOrigins);
    if (!headers) return next();
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if ("access-control-allow-methods" in headers) {
      response.statusCode = 204;
      return response.end();
    }
    next();
  };
}
