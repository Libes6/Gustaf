import {
  keepPreviousData,
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import { notify } from "../components/ui/toast";
import { errorMessage } from "../lib/format";
import { back, currentCursor, FIRST_PAGE, forward } from "../lib/pagination";
import { strings } from "../strings";
import { isApiError } from "./client";
import { api } from "./instance";
import type { DeviceKind, Page } from "./types";

export const queryKeys = {
  me: ["me"] as const,
  admin: ["admin"] as const,
  overview: ["admin", "overview"] as const,
  users: (query: string) => ["admin", "users", { query }] as const,
  user: (id: string) => ["admin", "user", id] as const,
  devices: (query: string, kind: DeviceKind | undefined) =>
    ["admin", "devices", { query, kind }] as const,
  audit: ["admin", "audit"] as const,
};

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    // An expired session on any request sends the app back to the sign-in screen.
    // /v1/me itself is skipped: its own 401 is the signed-out state, and refetching it would loop.
    queryCache: new QueryCache({
      onError: (error, query) => query.queryKey[0] !== queryKeys.me[0] && onAnyError(error),
    }),
    mutationCache: new MutationCache({ onError: (error) => onAnyError(error) }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failures, error) =>
          failures < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
      },
    },
  });
  function onAnyError(error: unknown) {
    if (isApiError(error, "unauthorized")) {
      void client.invalidateQueries({ queryKey: queryKeys.me });
    }
  }
  return client;
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, retry: false });
}

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: api.overview });
}

export function useUser(id: string) {
  return useQuery({ queryKey: queryKeys.user(id), queryFn: () => api.getUser(id) });
}

/** One page of a cursor-paginated list; the trail resets whenever the filters in `key` change. */
function usePagedList<T>(
  key: ReadonlyArray<unknown>,
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
) {
  const filters = JSON.stringify(key);
  const [state, setState] = useState({ filters, trail: FIRST_PAGE });
  const trail = state.filters === filters ? state.trail : FIRST_PAGE;
  const cursor = currentCursor(trail);
  const query = useQuery({
    queryKey: [...key, cursor],
    queryFn: () => fetchPage(cursor),
    placeholderData: keepPreviousData,
  });
  const nextCursor = query.isPlaceholderData ? null : (query.data?.nextCursor ?? null);
  return {
    query,
    page: trail.length,
    hasPrevious: trail.length > 1,
    hasNext: nextCursor !== null,
    next: () => setState({ filters, trail: forward(trail, nextCursor) }),
    previous: () => setState({ filters, trail: back(trail) }),
  };
}

export function useUsers(query: string) {
  return usePagedList(queryKeys.users(query), (cursor) => api.listUsers({ query, cursor }));
}

export function useDevices(query: string, kind: DeviceKind | undefined) {
  return usePagedList(queryKeys.devices(query, kind), (cursor) =>
    api.listDevices({ query, kind, cursor }),
  );
}

export function useAudit() {
  return usePagedList(queryKeys.audit, (cursor) => api.listAudit({ cursor }));
}

/** An admin action: toast on success or failure, then refresh every admin view. */
export function useAdminAction<Variables>(
  mutationFn: (variables: Variables) => Promise<unknown>,
  successMessage: (variables: Variables) => string,
  afterSuccess?: (variables: Variables) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data, variables) => {
      notify("success", successMessage(variables));
      afterSuccess?.(variables);
    },
    onError: (error) => notify("error", strings.toasts.failed, errorMessage(error)),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.admin }),
  });
}

export function useSignIn() {
  return useMutation({
    mutationFn: () => api.signIn(`${window.location.origin}/`),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.signOut,
    onError: (error) => notify("error", strings.toasts.failed, errorMessage(error)),
    onSuccess: () => {
      client.removeQueries({ queryKey: queryKeys.admin });
      void client.resetQueries({ queryKey: queryKeys.me });
    },
  });
}
