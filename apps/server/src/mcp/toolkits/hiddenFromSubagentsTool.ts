import { McpSchema, type Tool } from "effect/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";

/**
 * Keeps a tool out of a delegated child's list and answers its call "not found": the child
 * works inside its task and hands the result back, so setup and admin tools only cost it context.
 * Ordinary threads and outside clients (the CLI) keep the tool.
 */
export const hiddenFromSubagentsTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents) as T;
