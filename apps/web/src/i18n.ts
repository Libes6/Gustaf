import type { UiLanguage } from "@t3tools/contracts/settings";

import { sidebarMessages } from "./i18nMessages/sidebar";
import { chatAMessages } from "./i18nMessages/chatA";
import { chatBMessages } from "./i18nMessages/chatB";
import { shellMessages } from "./i18nMessages/shell";
import { settingsAMessages } from "./i18nMessages/settingsA";
import { settingsBMessages } from "./i18nMessages/settingsB";
import { settingsCMessages } from "./i18nMessages/settingsC";
import { settingsDMessages } from "./i18nMessages/settingsD";
import { settingsEMessages } from "./i18nMessages/settingsE";
import { miscMessages } from "./i18nMessages/misc";
import { computerUseMessages } from "./i18nMessages/computerUse";

const baseMessages = {
  en: {
    "settings.language": "Language",
    "settings.languageDescription":
      "Language of the Gustaf interface. Screens that are not translated yet stay in English.",
    "settings.nav.general": "General",
    "settings.nav.appearance": "Appearance",
    "settings.nav.chat": "Chat",
    "settings.nav.diffs": "Diffs & pull requests",
    "settings.nav.keybindings": "Keybindings",
    "settings.nav.voice": "Voice",
    "settings.nav.snapShot": "SnapShots",
    "settings.nav.providers": "Providers",
    "settings.nav.threads": "Threads",
    "settings.nav.browser": "Browser",
    "settings.nav.devices": "Devices",
    "settings.nav.scheduledTasks": "Scheduled tasks",
    "settings.nav.projects": "Projects",
    "settings.nav.sourceControl": "Source control",
    "settings.nav.worktrees": "Worktrees",
    "settings.nav.connections": "Environments",
    "settings.nav.access": "Sharing & access",
    "settings.nav.secrets": "Secrets",
    "settings.nav.maintenance": "Maintenance",
    "settings.nav.labs": "Labs",
    "settings.nav.account": "Account",
    "settings.nav.about": "About",
    "settings.nav.archived": "Archive",
    "settings.nav.diagnostics": "Diagnostics",
    "settings.group.agents": "Agents",
    "settings.group.code": "Code",
    "settings.group.connections": "Connections",
    "settings.section.notifications": "Notifications",
    "settings.section.sidebar": "Sidebar",
    "settings.section.confirmations": "Confirmations",
    "settings.section.display": "Display",
    "settings.section.interface": "Interface",
    "settings.section.typography": "Typography",
    "settings.section.composer": "Composer",
    "settings.section.followUps": "Follow-ups",
    "settings.section.activity": "Activity",
    "settings.section.diffs": "Diffs",
    "settings.section.pullRequests": "Pull requests",
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
    "option.send.multiline": "{mod} + Enter for multiline prompts",
    "option.send.always": "{mod} + Enter always",
    "option.follow.queue": "Queue",
    "option.follow.steer": "Steer",
    "option.follow.multiline":
      "Press {mod} + Enter for single-line prompts or {mod} + Shift + Enter for multiline prompts to do the opposite for one message.",
    "option.follow.opposite": "Press {mod}{shift} + Enter to do the opposite for one message.",
    "option.tools.showAll": "Show all",
    "option.tools.hideSuccessful": "Hide successful",
    "option.tools.hideAll": "Hide all",
    "option.tools.zen": "Zen",
    "option.diff.stacked": "Stacked",
    "option.diff.split": "Split",
    "option.diff.expanded": "Expanded",
    "option.diff.collapsed": "Collapsed",
    "option.diff.redGreen": "Red & green",
    "option.diff.redGreenDefault": "Red & green (default)",
    "option.diff.blueOrange": "Blue & orange",
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
    "setting.composer-rich-text.title": "Rich text composer",
    "setting.composer-rich-text.description": "Show formatted Markdown as you type.",
    "setting.send-shortcut.title": "Send shortcut",
    "setting.send-shortcut.description": "Choose when Enter sends a prompt or inserts a new line",
    "setting.skills-in-slash-menu.title": "Show skills in slash menu",
    "setting.skills-in-slash-menu.description":
      "Also include skills in the / command menu. Skills always appear when you type $.",
    "setting.follow-up-behavior.title": "Follow-up behavior",
    "setting.follow-up-behavior.description":
      "Queue follow-ups while the agent runs or steer the current run.",
    "setting.tool-call-visibility.title": "Tool calls in chat",
    "setting.tool-call-visibility.description":
      "Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions, and errors always show.",
    "setting.diff-layout.title": "Diff layout",
    "setting.diff-layout.description":
      "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
    "setting.hide-whitespace-changes.title": "Hide whitespace changes",
    "setting.hide-whitespace-changes.description":
      "Set whether the diff panel ignores whitespace-only edits by default.",
    "setting.default-diff-file-state.title": "Default diff file state",
    "setting.default-diff-file-state.description":
      "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
    "setting.diff-color-scheme.title": "Diff colors",
    "setting.diff-color-scheme.description":
      "Choose colors for additions and deletions, including change counts.",
    "setting.proactive-panels.title": "Open pull requests and changes panels proactively",
    "setting.proactive-panels.description":
      "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
    "setting.pull-request-links-open-in-app.title": "Open pull requests in Gustaf",
    "setting.pull-request-links-open-in-app.description":
      "Clicking a pull request link opens it in Gustaf. Turn off to open pull request links like any other link, on your git host.",
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
    "settings.nav.appearance": "Внешний вид",
    "settings.nav.chat": "Чат",
    "settings.nav.diffs": "Диффы и пул-реквесты",
    "settings.nav.keybindings": "Сочетания клавиш",
    "settings.nav.voice": "Голос",
    "settings.nav.snapShot": "SnapShots",
    "settings.nav.providers": "Провайдеры",
    "settings.nav.threads": "Треды",
    "settings.nav.browser": "Браузер",
    "settings.nav.devices": "Устройства",
    "settings.nav.scheduledTasks": "Запланированные задачи",
    "settings.nav.projects": "Проекты",
    "settings.nav.sourceControl": "Контроль версий",
    "settings.nav.worktrees": "Worktrees",
    "settings.nav.connections": "Окружения",
    "settings.nav.access": "Общий доступ",
    "settings.nav.secrets": "Секреты",
    "settings.nav.maintenance": "Обслуживание",
    "settings.nav.labs": "Labs",
    "settings.nav.account": "Аккаунт",
    "settings.nav.about": "О программе",
    "settings.nav.archived": "Архив",
    "settings.nav.diagnostics": "Диагностика",
    "settings.group.agents": "Агенты",
    "settings.group.code": "Код",
    "settings.group.connections": "Подключения",
    "settings.section.notifications": "Уведомления",
    "settings.section.sidebar": "Боковая панель",
    "settings.section.confirmations": "Подтверждения",
    "settings.section.display": "Отображение",
    "settings.section.interface": "Интерфейс",
    "settings.section.typography": "Типографика",
    "settings.section.composer": "Поле ввода",
    "settings.section.followUps": "Продолжения",
    "settings.section.activity": "Действия",
    "settings.section.diffs": "Диффы",
    "settings.section.pullRequests": "Запросы на слияние",
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
    "option.sort.created": "Дата создания",
    "option.sort.manual": "Вручную",
    "option.time.system": "Как в системе",
    "option.time.12": "12-часовой",
    "option.time.24": "24-часовой",
    "option.quit.direct": "Одно нажатие",
    "option.quit.hold": "Удержание",
    "option.quit.double": "Двойное нажатие",
    "option.width.comfortable": "Обычная (по умолчанию)",
    "option.width.wide": "Широкая",
    "option.width.full": "На всю ширину",
    "option.effort.word": "Слово (по умолчанию)",
    "option.effort.bars": "Полоски",
    "option.theme.system": "Как в системе",
    "option.theme.light": "Светлая",
    "option.theme.dark": "Тёмная",
    "option.send.multiline": "{mod} + Enter для нескольких строк",
    "option.send.always": "{mod} + Enter всегда",
    "option.follow.queue": "В очередь",
    "option.follow.steer": "Сразу в ход",
    "option.follow.multiline":
      "Нажмите {mod} + Enter для одной строки или {mod} + Shift + Enter для нескольких строк, чтобы один раз сделать наоборот.",
    "option.follow.opposite": "Нажмите {mod}{shift} + Enter, чтобы один раз сделать наоборот.",
    "option.tools.showAll": "Показывать все",
    "option.tools.hideSuccessful": "Скрыть удачные",
    "option.tools.hideAll": "Скрыть все",
    "option.tools.zen": "Только ответ",
    "option.diff.stacked": "Столбиком",
    "option.diff.split": "Рядом",
    "option.diff.expanded": "Развёрнуты",
    "option.diff.collapsed": "Свёрнуты",
    "option.diff.redGreen": "Красный и зелёный",
    "option.diff.redGreenDefault": "Красный и зелёный (по умолчанию)",
    "option.diff.blueOrange": "Синий и оранжевый",
    "threadDetails.count": "{enabled} из {total}",
    "setting.thread-notifications.title": "Уведомления о тредах",
    "setting.thread-notifications.description":
      "Системные оповещения, когда тред закончился, упал или ждёт ввод или разрешение. Действует на этом устройстве, пока Gustaf открыт.",
    "setting.in-app-notifications.title": "Уведомления в приложении",
    "setting.in-app-notifications.description":
      "Показывает всплывающее уведомление, если другой тред завершился, столкнулся с ошибкой или ждёт ввода либо подтверждения, пока приложение в фокусе.",
    "setting.project-grouping.title": "Группировка проектов",
    "setting.project-grouping.description":
      "Объединяет одинаковые репозитории из разных окружений.",
    "setting.project-order.title": "Порядок проектов",
    "setting.project-order.description":
      "Порядок проектов в меню выбора проекта на боковой панели и в палитре команд.",
    "setting.working-shelf.title": "Раздел Working",
    "setting.working-shelf.description":
      "Складывать работающие треды в раздел «В работе». Они поднимаются наверх, когда нужно ваше внимание. В сайдбаре с папками проектов этого раздела нет.",
    "setting.unpin-confirmation.title": "Подтверждение открепления",
    "setting.unpin-confirmation.description": "Запрашивает подтверждение перед откреплением треда.",
    "setting.archive-confirmation.title": "Подтверждение архивации",
    "setting.archive-confirmation.description":
      "Требует повторного нажатия на кнопку архивации в строке, прежде чем тред будет архивирован.",
    "setting.delete-confirmation.title": "Подтверждение удаления",
    "setting.delete-confirmation.description":
      "Запрашивает подтверждение перед удалением треда и его истории.",
    "setting.quit-confirmation.title": "Сочетание клавиш для выхода",
    "setting.quit-confirmation.description":
      "В режиме удержания выход также срабатывает по двойному нажатию.",
    "setting.time-format.title": "Формат времени",
    "setting.time-format.description": "«Как в системе» использует формат времени браузера или ОС.",
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
    "setting.composer-rich-text.title": "Форматирование в поле ввода",
    "setting.composer-rich-text.description": "Показывать оформленный Markdown по мере набора.",
    "setting.send-shortcut.title": "Клавиша отправки",
    "setting.send-shortcut.description":
      "Когда Enter отправляет запрос, а когда вставляет новую строку.",
    "setting.skills-in-slash-menu.title": "Навыки в меню /",
    "setting.skills-in-slash-menu.description":
      "Показывать навыки и в меню команд /. По $ они видны всегда.",
    "setting.follow-up-behavior.title": "Поведение продолжений",
    "setting.follow-up-behavior.description":
      "Ставить следующие сообщения в очередь, пока агент работает, или вмешиваться в текущий ход.",
    "setting.tool-call-visibility.title": "Вызовы инструментов в чате",
    "setting.tool-call-visibility.description":
      "Скрывать команды, правки и поиски, которые запускает агент. «Скрыть удачные» оставляет ошибки. «Только ответ» показывает итог. Запросы разрешений, вопросы и ошибки видны всегда.",
    "setting.diff-layout.title": "Вид диффа",
    "setting.diff-layout.description":
      "Показывать дифф столбиком или рядом. То же переключается в панели диффа.",
    "setting.hide-whitespace-changes.title": "Скрывать пробелы",
    "setting.hide-whitespace-changes.description":
      "Игнорировать правки, где изменились только пробелы.",
    "setting.default-diff-file-state.title": "Файлы в диффе",
    "setting.default-diff-file-state.description":
      "Открывать файлы развёрнутыми или свёрнутыми в диффе и на вкладке кода запроса.",
    "setting.diff-color-scheme.title": "Цвета диффа",
    "setting.diff-color-scheme.description": "Цвета добавлений и удалений, включая счётчики.",
    "setting.proactive-panels.title": "Сами открывать запросы и изменения",
    "setting.proactive-panels.description":
      "Сначала открывать связанный запрос. Иначе открывать изменения, если правок не меньше 3 файлов или 50 строк.",
    "setting.pull-request-links-open-in-app.title": "Открывать запросы в Gustaf",
    "setting.pull-request-links-open-in-app.description":
      "Ссылка на запрос открывается в Gustaf. Выключите, чтобы открывать её как обычную ссылку на хосте git.",
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

const messages = {
  en: {
    ...baseMessages.en,
    ...sidebarMessages.en,
    ...chatAMessages.en,
    ...chatBMessages.en,
    ...shellMessages.en,
    ...settingsAMessages.en,
    ...settingsBMessages.en,
    ...settingsCMessages.en,
    ...settingsDMessages.en,
    ...settingsEMessages.en,
    ...miscMessages.en,
    ...computerUseMessages.en,
  },
  ru: {
    ...baseMessages.ru,
    ...sidebarMessages.ru,
    ...chatAMessages.ru,
    ...chatBMessages.ru,
    ...shellMessages.ru,
    ...settingsAMessages.ru,
    ...settingsBMessages.ru,
    ...settingsCMessages.ru,
    ...settingsDMessages.ru,
    ...settingsEMessages.ru,
    ...miscMessages.ru,
    ...computerUseMessages.ru,
  },
} satisfies Record<UiLanguage, Record<string, string>>;

export type MessageKey = keyof (typeof messages)["en"];

export function translate(language: UiLanguage, key: MessageKey): string {
  return (messages[language] as Record<string, string>)[key] ?? messages.en[key];
}

const settingsNavKeys = {
  "/settings/general": "settings.nav.general",
  "/settings/appearance": "settings.nav.appearance",
  "/settings/chat": "settings.nav.chat",
  "/settings/diffs": "settings.nav.diffs",
  "/settings/keybindings": "settings.nav.keybindings",
  "/settings/voice": "settings.nav.voice",
  "/settings/snap-shot": "settings.nav.snapShot",
  "/settings/providers": "settings.nav.providers",
  "/settings/threads": "settings.nav.threads",
  "/settings/browser": "settings.nav.browser",
  "/settings/devices": "settings.nav.devices",
  "/settings/scheduled-tasks": "settings.nav.scheduledTasks",
  "/settings/projects": "settings.nav.projects",
  "/settings/source-control": "settings.nav.sourceControl",
  "/settings/worktrees": "settings.nav.worktrees",
  "/settings/connections": "settings.nav.connections",
  "/settings/access": "settings.nav.access",
  "/settings/secrets": "settings.nav.secrets",
  "/settings/maintenance": "settings.nav.maintenance",
  "/settings/labs": "settings.nav.labs",
  "/settings/account": "settings.nav.account",
  "/settings/about": "settings.nav.about",
  "/settings/archived": "settings.nav.archived",
  "/settings/diagnostics": "settings.nav.diagnostics",
} as const satisfies Partial<Record<string, MessageKey>>;

const settingsGroupKeys = {
  Agents: "settings.group.agents",
  Code: "settings.group.code",
  Connections: "settings.group.connections",
} as const satisfies Record<string, MessageKey>;

export function translateSettingsGroup(language: UiLanguage, heading: string): string {
  const key = settingsGroupKeys[heading as keyof typeof settingsGroupKeys];
  return key ? translate(language, key) : heading;
}

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
