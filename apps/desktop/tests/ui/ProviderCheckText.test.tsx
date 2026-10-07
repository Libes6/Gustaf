import { describe, expect, it } from "vitest";
import { translate } from "../../src/i18n";
import { runProviderCheck } from "../../src/lib/providerCheck";

// state.tsx passes translate(locale, "providerCheckTimeout") to runProviderCheck, so the recorded timeout text follows the profile language.
const timedOut = (locale: "en" | "ru") =>
  runProviderCheck((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), translate(locale, "providerCheckTimeout"), 10);

describe("provider check timeout text", () => {
  it("an English profile gets English text, a Russian one Russian", async () => {
    const en = await timedOut("en");
    const ru = await timedOut("ru");
    expect(en).toBe("The check took longer than 30 seconds");
    expect(en).not.toMatch(/[А-Яа-я]/);
    expect(ru).toBe("Проверка превысила 30 секунд");
  });
});
