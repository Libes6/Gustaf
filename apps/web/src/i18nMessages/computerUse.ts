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
    "computerUse.confirmOnMac": "Waiting for the person at the Mac to confirm…",
    "computerUse.disable": "Turn off on this Mac",
    "computerUse.whatItDoes":
      "This thread's agent will see the Mac's screen and use its mouse and keyboard until control stops. Works with Claude, Codex, OpenCode and Pi.",
    "computerUse.howToStop":
      "To stop: Stop in the thread header, Stop control in the Mac's menu bar, or {shortcut} on the Mac.",
    "computerUse.firstTime":
      "The first time, Gustaf asks the person at the Mac to confirm in a dialog there.",
    "computerUse.starting": "Starting control…",
    "computerUse.grantOne": "Gustaf on the Mac still needs the {permission} permission.",
    "computerUse.grantBoth": "Gustaf on the Mac still needs two permissions.",
    "computerUse.grantAutoCheck":
      "Switch Gustaf on in the list that opens. This panel notices on its own; then click Allow this thread.",
    "computerUse.grantOldEntry":
      "Gustaf already looks switched on? The list can hold an older Gustaf build under the same name. Remove the Gustaf entries with −, then click Open settings again.",
    "computerUse.checkFailed":
      "Gustaf could not ask macOS about its permissions. Check again; if it keeps failing, reopen Gustaf on the Mac.",
    "computerUse.screenRecording": "Screen Recording",
    "computerUse.accessibility": "Accessibility",
    "computerUse.openSettings": "Open settings",
    "computerUse.checkAgain": "Check again",
    "computerUse.allow": "Allow this thread",
    "computerUse.ownedHere": "This thread's agent controls the Mac.",
    "computerUse.ownedElsewhere": "The Mac is controlled by “{owner}”.",
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
    "computerUse.error.permission-required": "Gustaf lacks a macOS permission on the Mac.",
    "computerUse.error.disabled": "Control is turned off on the Mac. Try again.",
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
    "computerUse.confirmOnMac": "Ждём подтверждения на Mac…",
    "computerUse.disable": "Выключить на этом Mac",
    "computerUse.whatItDoes":
      "Агент этого треда будет видеть экран Mac и пользоваться мышью и клавиатурой, пока управление не остановят. Работает с Claude, Codex, OpenCode и Pi.",
    "computerUse.howToStop":
      "Остановить: «Стоп» в шапке треда, «Остановить управление» в строке меню Mac или {shortcut} на Mac.",
    "computerUse.firstTime":
      "В первый раз Gustaf попросит человека у Mac подтвердить в окне на самом Mac.",
    "computerUse.starting": "Запускаю управление…",
    "computerUse.grantOne": "Gustaf на Mac не хватает разрешения «{permission}».",
    "computerUse.grantBoth": "Gustaf на Mac не хватает двух разрешений.",
    "computerUse.grantAutoCheck":
      "Включите Gustaf в открывшемся списке. Панель заметит это сама; затем нажмите «Разрешить этому треду».",
    "computerUse.grantOldEntry":
      "Gustaf там уже включён? В списке может остаться старая сборка Gustaf с тем же именем. Удалите записи Gustaf кнопкой −, затем снова нажмите «Открыть настройки».",
    "computerUse.checkFailed":
      "Gustaf не смог узнать у macOS свои разрешения. Проверьте снова; если не помогает, перезапустите Gustaf на Mac.",
    "computerUse.screenRecording": "Запись экрана",
    "computerUse.accessibility": "Универсальный доступ",
    "computerUse.openSettings": "Открыть настройки",
    "computerUse.checkAgain": "Проверить снова",
    "computerUse.allow": "Разрешить этому треду",
    "computerUse.ownedHere": "Агент этого треда управляет Mac.",
    "computerUse.ownedElsewhere": "Mac управляет «{owner}».",
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
    "computerUse.error.permission-required": "Gustaf не хватает разрешения macOS на Mac.",
    "computerUse.error.disabled": "Управление на Mac выключено. Попробуйте снова.",
    "computerUse.error.emergency-stop-unavailable":
      "Не удалось назначить аварийное сочетание, поэтому управление не началось.",
    "computerUse.error.unsupported": "Недоступно в этом окружении.",
    "computerUse.error.failed": "Что-то пошло не так. Попробуйте снова.",
  },
} as const satisfies Record<UiLanguage, Record<string, string>>;
