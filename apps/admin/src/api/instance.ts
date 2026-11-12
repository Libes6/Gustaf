import { createApiClient } from "./client";

export const DEFAULT_API_URL = "https://api.libes6.ru";

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL?.trim() || DEFAULT_API_URL,
});
