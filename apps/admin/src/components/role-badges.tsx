import type { AdminUser } from "../api/types";
import { strings } from "../strings";
import { Badge } from "./ui/badge";

export function RoleBadge({ role }: { readonly role: AdminUser["role"] }) {
  return <Badge variant={role === "admin" ? "primary" : "secondary"}>{strings.roles[role]}</Badge>;
}

export function StatusBadge({ banned }: { readonly banned: boolean }) {
  return banned ? (
    <Badge variant="error">{strings.users.banned}</Badge>
  ) : (
    <Badge variant="success">{strings.users.active}</Badge>
  );
}
