export const settingsStatusMessages = {
  en: {
    "settingsStatus.composerStashShortcut":
      " Press {shortcut} with a prompt in the composer to stash it.",
    "settingsStatus.attachInterruptedFile": "Attach the interrupted file again or remove it",
    "settingsStatus.attachInterruptedFiles": "Attach the interrupted files again or remove them",
    "settingsStatus.dismissBranchNotice": "Dismiss branch change notice",

    "settingsStatus.hostAccounts": "{host} accounts and token",
    "settingsStatus.hostCredentials": "{host} credentials",
    "settingsStatus.cleanupReport": "Last run {time}. {bytes} recovered.{failures}",
    "settingsStatus.cleanupFailures": " {count} items could not be removed.",
    "settingsStatus.tailscaleDetect": "Turn on Network access to detect Tailscale.",
    "settingsStatus.tailscaleStart": "Start Tailscale to set up HTTPS access through MagicDNS.",
    "settingsStatus.upToDate": "Up to date",
    "settingsStatus.downloading": "Downloading update",
    "settingsStatus.downloadingVersion": "Downloading update {version}",
    "settingsStatus.downloaded": "Update downloaded",
    "settingsStatus.downloadedVersion": "Update {version} downloaded",
    "settingsStatus.available": "Update available",
    "settingsStatus.availableVersion": "Update {version} available",
  },
  ru: {
    "settingsStatus.composerStashShortcut":
      " Нажмите {shortcut}, чтобы отложить запрос из редактора.",
    "settingsStatus.attachInterruptedFile": "Прикрепите прерванный файл заново или удалите его",
    "settingsStatus.attachInterruptedFiles": "Прикрепите прерванные файлы заново или удалите их",
    "settingsStatus.dismissBranchNotice": "Скрыть уведомление о смене ветки",

    "settingsStatus.hostAccounts": "Аккаунты и токен {host}",
    "settingsStatus.hostCredentials": "Учётные данные {host}",
    "settingsStatus.cleanupReport": "Последний запуск: {time}. Освобождено: {bytes}.{failures}",
    "settingsStatus.cleanupFailures": " Не удалось удалить: {count}.",
    "settingsStatus.tailscaleDetect": "Включите доступ по сети, чтобы обнаружить Tailscale.",
    "settingsStatus.tailscaleStart":
      "Запустите Tailscale для настройки HTTPS-доступа через MagicDNS.",
    "settingsStatus.upToDate": "Установлена последняя версия",
    "settingsStatus.downloading": "Загрузка обновления",
    "settingsStatus.downloadingVersion": "Загрузка обновления {version}",
    "settingsStatus.downloaded": "Обновление загружено",
    "settingsStatus.downloadedVersion": "Обновление {version} загружено",
    "settingsStatus.available": "Доступно обновление",
    "settingsStatus.availableVersion": "Доступно обновление {version}",
  },
} as const;
