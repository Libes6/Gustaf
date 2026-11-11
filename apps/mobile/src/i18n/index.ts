import ru from "./ru.json";

const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;

// Translate interface copy only at its call site; messages, code and names stay untouched.
export function t(text: string, locale = systemLocale): string {
  return locale.toLowerCase().startsWith("ru") ? (ru[text as keyof typeof ru] ?? text) : text;
}
