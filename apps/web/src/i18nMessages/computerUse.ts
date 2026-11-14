import type { UiLanguage } from "@t3tools/contracts/settings";

// Interface strings for one area of the app. Keys start with "computerUse." and both languages list the same keys.
export const computerUseMessages = {
  en: {
    "computerUse.button": "Control Mac",
    "computerUse.activeHere": "Controls the Mac",
    "computerUse.stop": "Stop",
    "computerUse.title": "Control this Mac",
    "computerUse.unsupported":
      "Not available here. Agents can control a Mac only through the Gustaf app on that Mac, in its own environment.",
    "computerUse.disabled":
      "Turned off on this Mac. Turning it on asks the person at the Mac to confirm.",
    "computerUse.enable": "Turn on for this Mac",
    "computerUse.confirmOnMac": "Confirm on the Mac.",
    "computerUse.disable": "Turn off on this Mac",
    "computerUse.permissionsNeeded":
      "Gustaf needs these permissions in System Settings › Privacy & Security on the Mac:",
    "computerUse.screenRecording": "Screen Recording",
    "computerUse.accessibility": "Accessibility",
    "computerUse.openSettings": "Open on the Mac",
    "computerUse.checkAgain": "Check again",
    "computerUse.ready":
      "Let this thread's agent see the screen and use the mouse and keyboard. Works with Claude, Codex, OpenCode and Pi; other providers are not supported.",
    "computerUse.allow": "Allow this thread",
    "computerUse.ownedHere": "This thread's agent controls the Mac.",
    "computerUse.ownedElsewhere": "The Mac is controlled by “{owner}”.",
    "computerUse.emergency": "Emergency stop on the Mac: {shortcut}.",
    "computerUse.lastEnd": "Last stopped: {reason}.",
    "computerUse.end.stopped-by-user": "by the user",
    "computerUse.end.emergency-shortcut": "with the emergency shortcut",
    "computerUse.end.stopped-by-owner": "by the agent",
    "computerUse.end.connection-lost": "connection lost",
    "computerUse.end.permission-revoked": "a permission was turned off",
    "computerUse.end.disabled": "turned off",
    "computerUse.end.app-quit": "Gustaf quit",
    "computerUse.error.busy": "The Mac is already controlled by another thread. Stop it first.",
    "computerUse.error.declined": "The person at the Mac did not allow it.",
    "computerUse.error.permission-required": "Grant the permissions on the Mac first.",
    "computerUse.error.disabled": "Turn it on for this Mac first.",
    "computerUse.error.emergency-stop-unavailable":
      "The emergency stop shortcut could not be set up, so control did not start.",
    "computerUse.error.unsupported": "Not available in this environment.",
    "computerUse.error.failed": "Something went wrong. Try again.",
  },
  ru: {
    "computerUse.button": "Управление Mac",
    "computerUse.activeHere": "Управляет Mac",
    "computerUse.stop": "Стоп",
    "computerUse.title": "Управление этим Mac",
    "computerUse.unsupported":
      "Здесь недоступно. Агенты управляют Mac только через приложение Gustaf на этом Mac, в его собственном окружении.",
    "computerUse.disabled":
      "Выключено на этом Mac. При включении человек у Mac должен подтвердить.",
    "computerUse.enable": "Включить на этом Mac",
    "computerUse.confirmOnMac": "Подтвердите на Mac.",
    "computerUse.disable": "Выключить на этом Mac",
    "computerUse.permissionsNeeded":
      "Gustaf нужны разрешения в Системных настройках › Конфиденциальность и безопасность на Mac:",
    "computerUse.screenRecording": "Запись экрана",
    "computerUse.accessibility": "Универсальный доступ",
    "computerUse.openSettings": "Открыть на Mac",
    "computerUse.checkAgain": "Проверить снова",
    "computerUse.ready":
      "Агент этого треда будет видеть экран и пользоваться мышью и клавиатурой. Работает с Claude, Codex, OpenCode и Pi; другие провайдеры не поддерживаются.",
    "computerUse.allow": "Разрешить этому треду",
    "computerUse.ownedHere": "Агент этого треда управляет Mac.",
    "computerUse.ownedElsewhere": "Mac управляет «{owner}».",
    "computerUse.emergency": "Аварийная остановка на Mac: {shortcut}.",
    "computerUse.lastEnd": "Последняя остановка: {reason}.",
    "computerUse.end.stopped-by-user": "пользователем",
    "computerUse.end.emergency-shortcut": "аварийным сочетанием",
    "computerUse.end.stopped-by-owner": "агентом",
    "computerUse.end.connection-lost": "потеряно соединение",
    "computerUse.end.permission-revoked": "отозвано разрешение",
    "computerUse.end.disabled": "функция выключена",
    "computerUse.end.app-quit": "Gustaf закрыт",
    "computerUse.error.busy": "Mac уже управляет другой тред. Сначала остановите его.",
    "computerUse.error.declined": "Человек у Mac не разрешил.",
    "computerUse.error.permission-required": "Сначала выдайте разрешения на Mac.",
    "computerUse.error.disabled": "Сначала включите для этого Mac.",
    "computerUse.error.emergency-stop-unavailable":
      "Не удалось назначить аварийное сочетание, поэтому управление не началось.",
    "computerUse.error.unsupported": "Недоступно в этом окружении.",
    "computerUse.error.failed": "Что-то пошло не так. Попробуйте снова.",
  },
} as const satisfies Record<UiLanguage, Record<string, string>>;
