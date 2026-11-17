// @effect-diagnostics nodeBuiltinImport:off - pure native path normalization also supports Windows configs.
import * as NodePath from "node:path";

import type { NativeMcpServer } from "./nativeMcp.ts";

export type NativeMcpCandidate = Pick<NativeMcpServer, "name"> &
  (
    | {
        readonly transport: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }
    | { readonly transport: "http"; readonly url: string }
  );

const normalizeCommand = (command: string) => {
  const trimmed = command.trim();
  if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes("\\")) {
    const normalized = NodePath.win32.normalize(trimmed);
    return normalized.includes("\\") ? normalized : `.\\${normalized}`;
  }
  if (!trimmed.includes("/")) return trimmed;
  const normalized = NodePath.posix.normalize(trimmed);
  // A relative executable path must not become a PATH lookup after normalization.
  return normalized.includes("/") ? normalized : `./${normalized}`;
};

const normalizeUrl = (url: string) => {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
};

/** The Gustaf server id an imported native server name becomes; also how duplicates are matched. */
export const toMcpServerName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

export const findNativeDuplicate = (
  candidate: NativeMcpCandidate,
  nativeList: ReadonlyArray<NativeMcpServer>,
): NativeMcpServer | undefined =>
  nativeList.find((native) => {
    if (native.name !== candidate.name) return false;
    if (native.transport === "stdio" && candidate.transport === "stdio") {
      return (
        normalizeCommand(native.command) === normalizeCommand(candidate.command) &&
        native.args.length === candidate.args.length &&
        native.args.every((arg, index) => arg === candidate.args[index])
      );
    }
    if (native.transport === "http" && candidate.transport === "http") {
      const normalized = normalizeUrl(candidate.url);
      return normalized !== undefined && normalizeUrl(native.url) === normalized;
    }
    return false;
  });

export type NativeMcpProvider = "claudeAgent" | "codex" | "cursor" | "gemini";

export const nativeServersForProvider = (
  provider: NativeMcpProvider,
  nativeList: ReadonlyArray<NativeMcpServer>,
  projectDir: string,
  options: { readonly includeProjectMcpJson?: boolean } = {},
): NativeMcpServer[] => {
  const source = provider === "claudeAgent" ? "claude" : provider;
  const projectPath = NodePath.resolve(projectDir);
  const selected = nativeList.filter((server) => {
    if (
      server.source !== source &&
      !(
        provider === "claudeAgent" &&
        options.includeProjectMcpJson &&
        server.source === "project-mcp-json"
      )
    )
      return false;
    return server.projectDir === undefined || NodePath.resolve(server.projectDir) === projectPath;
  });
  // Project-local entries shadow the same name globally, including disabled entries.
  const byName = new Map<string, NativeMcpServer>();
  for (const server of selected.filter((entry) => entry.projectDir === undefined)) {
    byName.set(server.name, server);
  }
  for (const server of selected.filter((entry) => entry.source === "project-mcp-json")) {
    byName.set(server.name, server);
  }
  for (const server of selected.filter(
    (entry) => entry.projectDir !== undefined && entry.source !== "project-mcp-json",
  )) {
    byName.set(server.name, server);
  }
  return [...byName.values()].filter((server) => server.enabled);
};
