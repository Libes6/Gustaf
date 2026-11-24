import { createFileRoute } from "@tanstack/react-router";

import { McpSettings } from "../components/settings/McpSettings";

export const Route = createFileRoute("/_chat/settings/mcp")({ component: McpSettings });
