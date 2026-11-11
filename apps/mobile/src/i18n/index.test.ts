import { expect, it } from "vite-plus/test";
import { t } from "./index";

it("uses Russian for regional Russian locales and leaves other languages intact", () => {
  expect(t("Add environment", "ru-RU")).toBe("Добавить окружение");
  expect(t("Add environment", "en-US")).toBe("Add environment");
  expect(t("custom-project-name", "ru-RU")).toBe("custom-project-name");
});
