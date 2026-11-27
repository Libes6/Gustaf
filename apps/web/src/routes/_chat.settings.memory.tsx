import { createFileRoute } from "@tanstack/react-router";

import { MemorySettings } from "../components/settings/MemorySettings";

export const Route = createFileRoute("/_chat/settings/memory")({ component: MemorySettings });
