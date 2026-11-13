import { expect, it } from "vite-plus/test";
import { formatElapsed, localizeSnoozePresetLabel, localizeWakeLabel, t } from "./index";

it("uses Russian for regional Russian locales and leaves other languages intact", () => {
  expect(t("Add environment", "ru-RU")).toBe("Добавить окружение");
  expect(t("Add environment", "en-US")).toBe("Add environment");
  expect(t("custom-project-name", "ru-RU")).toBe("custom-project-name");
});

it.each([
  [-1_000, "0s", "0 с"],
  [4_900, "4s", "4 с"],
  [59_999, "59s", "59 с"],
  [60_000, "1m 00s", "1 мин 00 с"],
  [65_000, "1m 05s", "1 мин 05 с"],
  [3_599_000, "59m 59s", "59 мин 59 с"],
  [3_600_000, "1h 00m", "1 ч 00 мин"],
  [3_720_000, "1h 02m", "1 ч 02 мин"],
])("formats %d ms of elapsed time in English and Russian", (ms, en, ru) => {
  expect(formatElapsed(ms, "en-US")).toBe(en);
  expect(formatElapsed(ms, "ru-RU")).toBe(ru);
});

it.each([
  [{ id: "after:60", label: "In 1 hour" }, "Через 1 час"],
  [{ id: "after:180", label: "In 3 hours" }, "Через 3 часа"],
  [{ id: "after:300", label: "In 5 hours" }, "Через 5 часов"],
  [{ id: "after:21", label: "In 21 minutes" }, "Через 21 минуту"],
  [{ id: "after:2880", label: "In 2 days" }, "Через 2 дня"],
  [{ id: "at:today:18:00", label: "This evening" }, "Сегодня вечером"],
  [{ id: "at:monday:09:00", label: "Tomorrow" }, "Завтра"],
  [{ id: "at:monday:09:00", label: "Next week" }, "На следующей неделе"],
  [{ id: "at:friday:09:00", label: "Friday" }, "Пятница"],
  [{ id: "at:wednesday:09:00", label: "Next Wednesday" }, "В следующую среду"],
])("localizes snooze preset %j", (preset, ru) => {
  expect(localizeSnoozePresetLabel(preset, "ru-RU")).toBe(ru);
  expect(localizeSnoozePresetLabel(preset, "en-US")).toBe(preset.label);
});

it("localizes compact snooze wake labels", () => {
  expect(localizeWakeLabel("5m", "ru-RU")).toBe("5 мин");
  expect(localizeWakeLabel("2d", "ru-RU")).toBe("2 д");
  expect(localizeWakeLabel("now", "ru-RU")).toBe("сейчас");
  expect(localizeWakeLabel("3h", "en-US")).toBe("3h");
});
