import type { UiLanguage } from "@t3tools/contracts/settings";

const messages = {
  en: {
    "settings.language": "Language",
    "settings.languageDescription":
      "Language of the Gustaf interface. Screens that are not translated yet stay in English.",
    "settings.nav.general": "General",
    "settings.nav.appearance": "Appearance",
    "settings.section.notifications": "Notifications",
    "settings.section.sidebar": "Sidebar",
    "settings.section.confirmations": "Confirmations",
    "settings.section.display": "Display",
    "settings.section.interface": "Interface",
    "settings.section.typography": "Typography",
    "option.notifications.off": "Off",
    "option.notifications.only": "Notifications only",
    "option.notifications.sound": "Sound only",
    "option.notifications.both": "Notifications with sound",
    "option.notifications.https":
      "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
    "option.notifications.unavailable":
      "Notifications are unavailable in this browser. Sound only is still available.",
    "option.notifications.denied":
      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
    "option.sort.lastMessage": "Last user message",
    "option.sort.created": "Created at",
    "option.sort.manual": "Manual",
    "option.time.system": "System default",
    "option.time.12": "12-hour",
    "option.time.24": "24-hour",
    "option.quit.direct": "Direct",
    "option.quit.hold": "Hold",
    "option.quit.double": "Double press",
    "option.width.comfortable": "Comfortable (default)",
    "option.width.wide": "Wide",
    "option.width.full": "Full",
    "option.effort.word": "Word (default)",
    "option.effort.bars": "Bars",
    "option.theme.system": "System",
    "option.theme.light": "Light",
    "option.theme.dark": "Dark",
    "threadDetails.count": "{enabled} of {total} on",
    "setting.thread-notifications.title": "Thread notifications",
    "setting.thread-notifications.description":
      "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while Gustaf is open.",
    "setting.in-app-notifications.title": "In-app notifications",
    "setting.in-app-notifications.description":
      "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
    "setting.project-grouping.title": "Project grouping",
    "setting.project-grouping.description": "Combine matching repositories across environments.",
    "setting.project-order.title": "Project order",
    "setting.project-order.description":
      "Order of projects in the sidebar project picker and command palette.",
    "setting.working-shelf.title": "Working section",
    "setting.working-shelf.description":
      "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The project-folder sidebar has no Working section.",
    "setting.unpin-confirmation.title": "Unpin confirmation",
    "setting.unpin-confirmation.description":
      "Ask before unpinning a thread from the pinned section.",
    "setting.archive-confirmation.title": "Archive confirmation",
    "setting.archive-confirmation.description":
      "Require a second click on the inline archive action before a thread is archived.",
    "setting.delete-confirmation.title": "Delete confirmation",
    "setting.delete-confirmation.description": "Ask before deleting a thread and its chat history.",
    "setting.quit-confirmation.title": "Quit shortcut",
    "setting.quit-confirmation.description": "Hold mode also quits on two quick presses.",
    "setting.time-format.title": "Time format",
    "setting.time-format.description":
      "System default follows your browser or OS clock preference.",
    "setting.setting-appearance-contrast.title": "Contrast",
    "setting.setting-appearance-contrast.description":
      "Adjust the contrast of colors and borders across the interface.",
    "setting.setting-glass-opacity.title": "Glass opacity",
    "setting.setting-glass-opacity.description":
      "Higher values make menus, dialogs, and the composer more solid.",
    "setting.chat-width.title": "Chat width",
    "setting.chat-width.description":
      "Set how wide messages and the composer can grow on large screens.",
    "setting.thread-details-items.title": "Thread details",
    "setting.thread-details-items.description":
      "Choose what the thread details card shows. You can also right-click the card.",
    "setting.effort-display.title": "Effort display",
    "setting.effort-display.description":
      "Show reasoning effort in the composer as its name, such as High, or as bars.",
    "setting.math-rendering.title": "Render math",
    "setting.math-rendering.description":
      "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.",
    "setting.panel-animations.title": "Panel animations",
    "setting.panel-animations.description": "Set how fast panels open and close.",
    "setting.environment-identification.title": "Environment identification",
    "setting.environment-identification.description":
      "Choose how Dev and Nightly environments are identified.",
    "setting.environment-identification.pill":
      "Only built-in themes show artwork, so this theme shows the version pill.",
    "setting.environment-identification.noArt": "Only built-in themes show artwork.",
    "setting.environment-identification.header":
      "Show Dev or Nightly artwork in the sidebar header.",
    "setting.composer-context.title": "Composer context",
    "setting.composer-context.description":
      "Keep branch and worktree controls below the composer after a thread starts.",
    "setting.interface-font.title": "Interface font",
    "setting.interface-font.description": "Everything outside code blocks and the terminal.",
    "setting.prompt-font.title": "Prompt font",
    "setting.prompt-font.description": "Only the box you write prompts in. Mono works well here.",
    "setting.code-font.title": "Code font",
    "setting.code-font.description": "Code blocks, diffs, file previews, and the terminal.",
    "setting.monospace.title": "Monospace font",
    "setting.terminal-font.title": "Terminal font",
    "setting.terminal-font.description": "Terminal output, independent from code blocks and diffs.",
    "setting.font-smoothing.title": "Font smoothing",
    "setting.font-smoothing.description":
      "Use thinner grayscale text smoothing instead of the macOS default.",
    "setting.word-wrap.title": "Word wrap",
    "setting.word-wrap.description":
      "Wrap long lines in code blocks, diffs, and file previews by default.",
    "setting.separate-fonts.title": "Separate fonts",
    "setting.separate-fonts.description":
      "Set the prompt, code, and terminal fonts separately instead of one monospace font.",
    "sidebar.search": "Search",
    "sidebar.searchThreads": "Search threads",
    "sidebar.clearSearch": "Clear thread search",
    "sidebar.newThread": "New thread",
    "sidebar.pinned": "Pinned",
    "sidebar.working": "Working",
    "sidebar.settled": "Settled",
    "composer.placeholder": "Ask anything. @ files, $ skills, / commands",
    "composer.ask": "Ask anything...",
    "composer.enableProvider": "Enable a provider in Settings",
    "composer.enableProviderLong": "Enable a provider in Settings to send a message",
  },
  ru: {
    "settings.language": "Язык",
    "settings.languageDescription":
      "Язык интерфейса Gustaf. Экраны, которые ещё не переведены, остаются на английском.",
    "settings.nav.general": "Общие",
    "settings.nav.appearance": "Оформление",
    "settings.section.notifications": "Уведомления",
    "settings.section.sidebar": "Сайдбар",
    "settings.section.confirmations": "Подтверждения",
    "settings.section.display": "Отображение",
    "settings.section.interface": "Интерфейс",
    "settings.section.typography": "Типографика",
    "option.notifications.off": "Выкл.",
    "option.notifications.only": "Только уведомления",
    "option.notifications.sound": "Только звук",
    "option.notifications.both": "Уведомления со звуком",
    "option.notifications.https":
      "Уведомлениям нужен поддерживаемый браузер по HTTPS или приложение. Только звук всё равно доступен.",
    "option.notifications.unavailable":
      "В этом браузере уведомления недоступны. Только звук всё равно доступен.",
    "option.notifications.denied":
      "Разрешите уведомления в браузере или системе и выберите пункт снова. Только звук всё равно доступен.",
    "option.sort.lastMessage": "Последнее сообщение",
    "option.sort.created": "По дате создания",
    "option.sort.manual": "Вручную",
    "option.time.system": "Как в системе",
    "option.time.12": "12 часов",
    "option.time.24": "24 часа",
    "option.quit.direct": "Сразу",
    "option.quit.hold": "Удерживать",
    "option.quit.double": "Двойное нажатие",
    "option.width.comfortable": "Обычная (по умолчанию)",
    "option.width.wide": "Широкая",
    "option.width.full": "На всю ширину",
    "option.effort.word": "Слово (по умолчанию)",
    "option.effort.bars": "Полоски",
    "option.theme.system": "Как в системе",
    "option.theme.light": "Светлая",
    "option.theme.dark": "Тёмная",
    "threadDetails.count": "{enabled} из {total}",
    "setting.thread-notifications.title": "Уведомления о тредах",
    "setting.thread-notifications.description":
      "Системные оповещения, когда тред закончился, упал или ждёт ввод или разрешение. Действует на этом устройстве, пока Gustaf открыт.",
    "setting.in-app-notifications.title": "Уведомления в приложении",
    "setting.in-app-notifications.description":
      "Показывать всплывающее сообщение, когда другой тред закончился, упал или ждёт ввод или разрешение, пока это окно в фокусе.",
    "setting.project-grouping.title": "Группировка проектов",
    "setting.project-grouping.description": "Объединять одинаковые репозитории с разных машин.",
    "setting.project-order.title": "Порядок проектов",
    "setting.project-order.description": "Порядок проектов в выборе проекта и в палитре команд.",
    "setting.working-shelf.title": "Раздел «В работе»",
    "setting.working-shelf.description":
      "Складывать работающие треды в раздел «В работе». Они поднимаются наверх, когда нужно ваше внимание. В сайдбаре с папками проектов этого раздела нет.",
    "setting.unpin-confirmation.title": "Подтверждение открепления",
    "setting.unpin-confirmation.description": "Спрашивать перед снятием треда с закреплённых.",
    "setting.archive-confirmation.title": "Подтверждение архива",
    "setting.archive-confirmation.description":
      "Требовать второй клик по кнопке архива, прежде чем тред уйдёт в архив.",
    "setting.delete-confirmation.title": "Подтверждение удаления",
    "setting.delete-confirmation.description": "Спрашивать перед удалением треда и его истории.",
    "setting.quit-confirmation.title": "Закрытие приложения",
    "setting.quit-confirmation.description":
      "В режиме удержания приложение также закрывается двумя быстрыми нажатиями.",
    "setting.time-format.title": "Формат времени",
    "setting.time-format.description": "«Как в системе» берёт настройку часов браузера или ОС.",
    "setting.setting-appearance-contrast.title": "Контраст",
    "setting.setting-appearance-contrast.description":
      "Контраст цветов и границ по всему интерфейсу.",
    "setting.setting-glass-opacity.title": "Прозрачность стекла",
    "setting.setting-glass-opacity.description":
      "Чем выше значение, тем плотнее меню, диалоги и поле ввода.",
    "setting.chat-width.title": "Ширина чата",
    "setting.chat-width.description":
      "Насколько широко могут расти сообщения и поле ввода на большом экране.",
    "setting.thread-details-items.title": "Подробности треда",
    "setting.thread-details-items.description":
      "Что показывать в карточке треда. То же меню открывается правым кликом по карточке.",
    "setting.effort-display.title": "Усилие модели",
    "setting.effort-display.description":
      "Показывать усилие рассуждения в поле ввода словом, например High, или полосками.",
    "setting.math-rendering.title": "Формулы",
    "setting.math-rendering.description":
      "Набирать формулы LaTeX, например $x^2$ или \\[x^2\\], в сообщениях и просмотре Markdown. В поле ввода исходник TeX остаётся редактируемым.",
    "setting.panel-animations.title": "Анимация панелей",
    "setting.panel-animations.description": "Как быстро панели открываются и закрываются.",
    "setting.environment-identification.title": "Метка окружения",
    "setting.environment-identification.description": "Как отмечать окружения Dev и Nightly.",
    "setting.environment-identification.pill":
      "Рисунок есть только у встроенных тем, поэтому здесь показана плашка версии.",
    "setting.environment-identification.noArt": "Рисунок есть только у встроенных тем.",
    "setting.environment-identification.header":
      "Показывать рисунок Dev или Nightly в шапке сайдбара.",
    "setting.composer-context.title": "Контекст поля ввода",
    "setting.composer-context.description":
      "Оставлять ветку и worktree под полем ввода после старта треда.",
    "setting.interface-font.title": "Шрифт интерфейса",
    "setting.interface-font.description": "Всё, кроме блоков кода и терминала.",
    "setting.prompt-font.title": "Шрифт запроса",
    "setting.prompt-font.description":
      "Только поле, где вы пишете запрос. Здесь хорошо подходит моноширинный шрифт.",
    "setting.code-font.title": "Шрифт кода",
    "setting.code-font.description": "Блоки кода, диффы, просмотр файлов и терминал.",
    "setting.monospace.title": "Моноширинный шрифт",
    "setting.terminal-font.title": "Шрифт терминала",
    "setting.terminal-font.description": "Вывод терминала, отдельно от блоков кода и диффов.",
    "setting.font-smoothing.title": "Сглаживание шрифта",
    "setting.font-smoothing.description":
      "Более тонкое серое сглаживание вместо стандартного macOS.",
    "setting.word-wrap.title": "Перенос строк",
    "setting.word-wrap.description":
      "По умолчанию переносить длинные строки в коде, диффах и просмотре файлов.",
    "setting.separate-fonts.title": "Разные шрифты",
    "setting.separate-fonts.description":
      "Задавать шрифты запроса, кода и терминала по отдельности, а не один моноширинный.",
    "sidebar.search": "Поиск",
    "sidebar.searchThreads": "Искать треды",
    "sidebar.clearSearch": "Очистить поиск",
    "sidebar.newThread": "Новый тред",
    "sidebar.pinned": "Закреплённые",
    "sidebar.working": "В работе",
    "sidebar.settled": "Готово",
    "composer.placeholder": "Спросите что угодно. @ файлы, $ навыки, / команды",
    "composer.ask": "Спросите что угодно...",
    "composer.enableProvider": "Включите провайдера в настройках",
    "composer.enableProviderLong": "Включите провайдера в настройках, чтобы отправить сообщение",
  },
} as const satisfies Record<UiLanguage, Record<string, string>>;

export type MessageKey = keyof (typeof messages)["en"];

export function translate(language: UiLanguage, key: MessageKey): string {
  return messages[language][key] ?? messages.en[key];
}

const settingsNavKeys = {
  "/settings/general": "settings.nav.general",
  "/settings/appearance": "settings.nav.appearance",
} as const satisfies Partial<Record<string, MessageKey>>;

export function translateSettingsNav(language: UiLanguage, path: string, fallback: string): string {
  const key = settingsNavKeys[path as keyof typeof settingsNavKeys];
  return key ? translate(language, key) : fallback;
}

export function settingCopy(
  language: UiLanguage,
  id: string,
): { readonly title: string; readonly description: string } | null {
  const titleKey = `setting.${id}.title`;
  if (!(titleKey in messages.en)) return null;
  return {
    title: translate(language, titleKey as MessageKey),
    description: translate(language, `setting.${id}.description` as MessageKey),
  };
}
