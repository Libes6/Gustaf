import { createFileRoute } from "@tanstack/react-router";

import { SubscriptionsSettings } from "../components/settings/SubscriptionsSettings";

export const Route = createFileRoute("/_chat/settings/subscriptions")({
  component: SubscriptionsSettings,
});
