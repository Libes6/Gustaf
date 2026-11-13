import type { AnnouncementInput } from "../api/types";

export const EMPTY_ANNOUNCEMENT: AnnouncementInput = {
  textEn: "",
  textRu: "",
  level: "info",
  link: null,
  target: "all",
  minVersion: null,
  maxVersion: null,
  startsAt: null,
  endsAt: null,
  active: true,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO instant as the admin's local `datetime-local` value. */
export function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value (the admin's local time) as an ISO instant. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseLogins(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((login) => login.replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export const optional = (value: string): string | null => value.trim() || null;
