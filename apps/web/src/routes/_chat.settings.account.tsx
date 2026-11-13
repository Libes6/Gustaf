import { createFileRoute } from "@tanstack/react-router";
import { AccountSettingsPanel } from "../components/settings/AccountSettings";

export const Route = createFileRoute("/_chat/settings/account")({
  component: AccountSettingsPanel,
});
