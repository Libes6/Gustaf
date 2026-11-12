import type { UiLanguage } from "@t3tools/contracts/settings";

// Interface strings for one area of the app. Keys start with "settingsD." and both languages list the same keys.
export const settingsDMessages = {
  en: {
    "settingsD.scheduledTasksSettings.workspaceModeWorktree": "Create a new worktree",
    "settingsD.scheduledTasksSettings.workspaceModeRoot": "Use the project checkout",
    "settingsD.scheduledTasksSettings.workspaceModeExisting": "Use a specific checkout",
    "settingsD.scheduledTasksSettings.filters": "Filters",
    "settingsD.scheduledTasksSettings.filtersHint":
      "Run only when every filter matches. Other requests are logged as filtered. Separate “is one of” values with commas; a value can't contain a comma.",
    "settingsD.scheduledTasksSettings.addFilter": "Add filter",
    "settingsD.scheduledTasksSettings.filterPath": "Filter {index} path",
    "settingsD.scheduledTasksSettings.removeFilter": "Remove filter {index}",
    "settingsD.scheduledTasksSettings.filterOperator": "Filter {index} test",
    "settingsD.scheduledTasksSettings.filterValue": "Filter {index} value",
    "settingsD.scheduledTasksSettings.title": "Scheduled tasks",
    "settingsD.scheduledTasksSettings.newTask": "New task",
    "settingsD.scheduledTasksSettings.unavailableSelection": "Unavailable selection",
    "settingsD.scheduledTasksSettings.noEnvironments": "No environments available",
    "settingsD.scheduledTasksSettings.connectEnvironment":
      "Connect an environment to manage scheduled tasks.",
    "settingsD.scheduledTasksSettings.summaryNotConnected": "Not connected:",
    "settingsD.scheduledTasksSettings.summaryLoading": "Loading scheduled tasks on",
    "settingsD.scheduledTasksSettings.summaryCouldNotLoad": "Could not load scheduled tasks:",
    "settingsD.scheduledTasksSettings.summaryNoTasks": "No tasks on",
    "settingsD.scheduledTasksSettings.taskUnavailable": "Task unavailable",
    "settingsD.scheduledTasksSettings.taskUnavailableHint":
      "This task was deleted or belongs to a different project. Check your project filter.",
    "settingsD.scheduledTasksSettings.noScheduledTasks": "No scheduled tasks",
    "settingsD.scheduledTasksSettings.noTasksMatch":
      "No tasks match this environment and project selection.",
    "settingsD.scheduledTasksSettings.environmentDisconnected": "Environment disconnected",
    "settingsD.scheduledTasksSettings.reconnect": "Reconnect {label} to view its scheduled tasks.",
    "settingsD.scheduledTasksSettings.couldNotLoad": "Could not load scheduled tasks",
    "settingsD.scheduledTasksSettings.loadingTasks": "Loading scheduled tasks…",
    "settingsD.scheduledTasksSettings.couldNotUpdate": "Could not update scheduled task",
    "settingsD.scheduledTasksSettings.paused": "Paused",
    "settingsD.scheduledTasksSettings.listening": "Listening",
    "settingsD.scheduledTasksSettings.notScheduled": "Not scheduled",
    "settingsD.scheduledTasksSettings.enableTask": "Enable {title}",
    "settingsD.scheduledTasksSettings.actionsFor": "Actions for {title}",
    "settingsD.scheduledTasksSettings.edit": "Edit",
    "settingsD.scheduledTasksSettings.deliveries": "Deliveries",
    "settingsD.scheduledTasksSettings.runNow": "Run now",
    "settingsD.scheduledTasksSettings.delete": "Delete",
    "settingsD.scheduledTasksSettings.openThread": "Open thread",
    "settingsD.scheduledTasksSettings.deliveriesTitle": "Deliveries · {title}",
    "settingsD.scheduledTasksSettings.recentRequests":
      "Recent requests to this task's webhook URL.",
    "settingsD.scheduledTasksSettings.loadingDelivery": "Loading delivery…",
    "settingsD.scheduledTasksSettings.signatureVerified": "Signature verified",
    "settingsD.scheduledTasksSettings.scheduledRun": "Scheduled run",
    "settingsD.scheduledTasksSettings.promptSent": "Prompt sent to the agent",
    "settingsD.scheduledTasksSettings.runScheduledWindow":
      "Run scheduled when the window closes; no run started yet.",
    "settingsD.scheduledTasksSettings.noRunStarted": "No run was started for this request.",
    "settingsD.scheduledTasksSettings.emptyPlaceholders": "Empty placeholders: {fields}",
    "settingsD.scheduledTasksSettings.headers": "Headers",
    "settingsD.scheduledTasksSettings.query": "Query",
    "settingsD.scheduledTasksSettings.bodyTruncated": "Body (truncated)",
    "settingsD.scheduledTasksSettings.body": "Body",
    "settingsD.scheduledTasksSettings.emptyBody": "(empty)",
    "settingsD.scheduledTasksSettings.back": "Back",
    "settingsD.scheduledTasksSettings.refresh": "Refresh",
    "settingsD.scheduledTasksSettings.done": "Done",
    "settingsD.scheduledTasksSettings.noRequests": "No requests yet.",
    "settingsD.scheduledTasksSettings.loadingDeliveries": "Loading deliveries…",
    "settingsD.scheduledTasksSettings.urlAfterSave": "The URL appears after you save.",
    "settingsD.scheduledTasksSettings.rotateConfirmDialog":
      "Rotate this webhook URL?\nThe current URL stops working.",
    "settingsD.scheduledTasksSettings.rotateConfirm":
      "Rotate this webhook URL? The current URL stops working.",
    "settingsD.scheduledTasksSettings.couldNotRotate": "Could not rotate webhook URL",
    "settingsD.scheduledTasksSettings.webhookUrl": "Webhook URL",
    "settingsD.scheduledTasksSettings.copied": "Copied",
    "settingsD.scheduledTasksSettings.copy": "Copy",
    "settingsD.scheduledTasksSettings.rotate": "Rotate",
    "settingsD.scheduledTasksSettings.heldOffline":
      "Held for up to 24 hours while this environment is offline. ",
    "settingsD.scheduledTasksSettings.forwardedLive":
      "Forwarded live. Requests fail while this environment is offline. ",
    "settingsD.scheduledTasksSettings.changeInSharing": "Change in Sharing & access",
    "settingsD.scheduledTasksSettings.threadModeNew": "New thread each run",
    "settingsD.scheduledTasksSettings.threadModeContinue":
      "One thread, continuing the conversation",
    "settingsD.scheduledTasksSettings.threadModeFresh": "One thread, fresh session each run",
    "settingsD.scheduledTasksSettings.startedByFirstRun": "Started by the first run",
    "settingsD.scheduledTasksSettings.threadFallback": "Thread {id}",
    "settingsD.scheduledTasksSettings.detailNewThread":
      "Each run starts a new thread with the workspace and model below.",
    "settingsD.scheduledTasksSettings.detailContinueNoThread":
      "The first run starts a thread with the workspace and model below. Later runs continue that conversation.",
    "settingsD.scheduledTasksSettings.detailFreshNoThread":
      "The first run starts a thread with the workspace and model below. Later runs post there, each in a fresh session without earlier runs' context.",
    "settingsD.scheduledTasksSettings.detailContinueThread":
      "Each run continues this conversation, in its workspace and with its current model.",
    "settingsD.scheduledTasksSettings.detailFreshThread":
      "Each run starts a fresh session in this thread, without earlier runs' context.",
    "settingsD.scheduledTasksSettings.destination": "Destination",
    "settingsD.scheduledTasksSettings.destinationThread": "Destination thread",
    "settingsD.scheduledTasksSettings.searchThreads": "Search threads",
    "settingsD.scheduledTasksSettings.searchAllThreads": "Search all threads...",
    "settingsD.scheduledTasksSettings.noThreads": "No threads found.",
    "settingsD.scheduledTasksSettings.untitledThread": "Untitled thread",
    "settingsD.scheduledTasksSettings.deletingThreadDeletesTask":
      "Deleting the thread also deletes this task.",
    "settingsD.scheduledTasksSettings.incompleteTitle": "Scheduled task is incomplete",
    "settingsD.scheduledTasksSettings.incompleteDescription":
      "Add a title, prompt, project, and model.",
    "settingsD.scheduledTasksSettings.invalidFilter": "Invalid filter",
    "settingsD.scheduledTasksSettings.secretRequired": "Signing secret is required",
    "settingsD.scheduledTasksSettings.secretRequiredDescription":
      "Enter the signature header and secret.",
    "settingsD.scheduledTasksSettings.invalidInterval": "Invalid interval",
    "settingsD.scheduledTasksSettings.intervalTooShort":
      "Enter an interval of at least one minute.",
    "settingsD.scheduledTasksSettings.onceUnavailable": "Once is not available here",
    "settingsD.scheduledTasksSettings.onceUnavailableDescription":
      "This environment runs an older Gustaf. Update it to schedule a one-time task, or pick another schedule.",
    "settingsD.scheduledTasksSettings.checkoutRequired": "Checkout path is required",
    "settingsD.scheduledTasksSettings.checkoutRequiredDescription":
      "Enter the path of the checkout to run in.",
    "settingsD.scheduledTasksSettings.couldNotSave": "Could not save scheduled task",
    "settingsD.scheduledTasksSettings.editTask": "Edit task",
    "settingsD.scheduledTasksSettings.formDescription":
      "Run a prompt automatically on an interval, at a fixed time, once at a set date, or when a webhook is called.",
    "settingsD.scheduledTasksSettings.reconnectBeforeSaving":
      "Reconnect this environment before saving.",
    "settingsD.scheduledTasksSettings.runsOn": "Runs on",
    "settingsD.scheduledTasksSettings.unavailableEnvironment": "Unavailable environment",
    "settingsD.scheduledTasksSettings.taskNoLongerExists": "This scheduled task no longer exists.",
    "settingsD.scheduledTasksSettings.name": "Name",
    "settingsD.scheduledTasksSettings.namePlaceholder": "e.g. Check for Sentry issues",
    "settingsD.scheduledTasksSettings.project": "Project",
    "settingsD.scheduledTasksSettings.selectProject": "Select a project",
    "settingsD.scheduledTasksSettings.workspace": "Workspace",
    "settingsD.scheduledTasksSettings.baseBranch": "Base branch",
    "settingsD.scheduledTasksSettings.checkoutPath": "Checkout path",
    "settingsD.scheduledTasksSettings.prompt": "Prompt",
    "settingsD.scheduledTasksSettings.promptPlaceholder":
      "What should the agent do each time this runs?",
    "settingsD.scheduledTasksSettings.model": "Model",
    "settingsD.scheduledTasksSettings.legacyInterval":
      "This task uses a legacy interval below one minute. Saving updates it to at least one minute.",
    "settingsD.scheduledTasksSettings.schedule": "Schedule",
    "settingsD.scheduledTasksSettings.scheduleType": "Schedule type",
    "settingsD.scheduledTasksSettings.atATime": "At a time",
    "settingsD.scheduledTasksSettings.once": "Once",
    "settingsD.scheduledTasksSettings.everyInterval": "Every interval",
    "settingsD.scheduledTasksSettings.onWebhook": "On webhook",
    "settingsD.scheduledTasksSettings.webhookDenialSwitch":
      "{denial} Switch this task to a time or an interval, or turn it off, to save it.",
    "settingsD.scheduledTasksSettings.webhookPromptHint":
      "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent.",
    "settingsD.scheduledTasksSettings.skipOlder": "Skip requests older than",
    "settingsD.scheduledTasksSettings.minutesOptional": "minutes, optional",
    "settingsD.scheduledTasksSettings.runEveryRequest": "Run every request",
    "settingsD.scheduledTasksSettings.duplicateKey": "Duplicate request key",
    "settingsD.scheduledTasksSettings.templateOptional": "template, optional",
    "settingsD.scheduledTasksSettings.sameKeyOnce":
      "Requests with the same key run only once within 7 days.",
    "settingsD.scheduledTasksSettings.coalesceKey": "Coalesce key",
    "settingsD.scheduledTasksSettings.coalesceWindow": "Coalesce window",
    "settingsD.scheduledTasksSettings.coalesceWindowHint": "seconds, 10–3600",
    "settingsD.scheduledTasksSettings.coalesceHint":
      "Coalescing runs the latest payload once when the window from the first delivery closes. Empty keys run normally.",
    "settingsD.scheduledTasksSettings.requireSignature": "Require signature",
    "settingsD.scheduledTasksSettings.rejectUnsigned":
      "Reject requests without a valid HMAC-SHA256 signature of the body.",
    "settingsD.scheduledTasksSettings.header": "Header",
    "settingsD.scheduledTasksSettings.prefix": "Prefix",
    "settingsD.scheduledTasksSettings.encoding": "Encoding",
    "settingsD.scheduledTasksSettings.secret": "Secret",
    "settingsD.scheduledTasksSettings.none": "None",
    "settingsD.scheduledTasksSettings.unchanged": "Unchanged",
    "settingsD.scheduledTasksSettings.sharedSecret": "Shared secret",
    "settingsD.scheduledTasksSettings.runOnDate": "Run on",
    "settingsD.scheduledTasksSettings.runAt": "Run at",
    "settingsD.scheduledTasksSettings.onDays": "on",
    "settingsD.scheduledTasksSettings.daysToRun": "Days to run",
    "settingsD.scheduledTasksSettings.runEvery": "Run every",
    "settingsD.scheduledTasksSettings.minutes": "minutes",
    "settingsD.scheduledTasksSettings.enabled": "Enabled",
    "settingsD.scheduledTasksSettings.disabledTasks": "Disabled tasks stay saved but do not run.",
    "settingsD.scheduledTasksSettings.cancel": "Cancel",
    "settingsD.scheduledTasksSettings.saveTask": "Save task",
    "settingsD.scheduledTasksSettings.createTask": "Create task",
    "settingsD.scheduledTasksSettings.weekdayShortSun": "Su",
    "settingsD.scheduledTasksSettings.weekdayShortMon": "Mo",
    "settingsD.scheduledTasksSettings.weekdayShortTue": "Tu",
    "settingsD.scheduledTasksSettings.weekdayShortWed": "We",
    "settingsD.scheduledTasksSettings.weekdayShortThu": "Th",
    "settingsD.scheduledTasksSettings.weekdayShortFri": "Fr",
    "settingsD.scheduledTasksSettings.weekdayShortSat": "Sa",
    "settingsD.scheduledTasksSettings.weekdayLongSun": "Sun",
    "settingsD.scheduledTasksSettings.weekdayLongMon": "Mon",
    "settingsD.scheduledTasksSettings.weekdayLongTue": "Tue",
    "settingsD.scheduledTasksSettings.weekdayLongWed": "Wed",
    "settingsD.scheduledTasksSettings.weekdayLongThu": "Thu",
    "settingsD.scheduledTasksSettings.weekdayLongFri": "Fri",
    "settingsD.scheduledTasksSettings.weekdayLongSat": "Sat",
    "settingsD.storageSettings.worktreesLocationDescription":
      "Folder where new worktrees are created, on any drive, such as D:\\worktrees or ~/worktrees. Existing worktrees stay where they are. Leave empty to use the T3 home folder.",
    "settingsD.storageSettings.worktreeLocation": "Worktree location",
    "settingsD.storageSettings.mixed": "Mixed",
    "settingsD.storageSettings.default": "Default",
    "settingsD.storageSettings.off": "Off",
    "settingsD.storageSettings.decreaseRetention": "Decrease {label}",
    "settingsD.storageSettings.increaseRetention": "Increase {label}",
    "settingsD.storageSettings.retentionInDays": "{label} in days",
    "settingsD.storageSettings.days": "days",
    "settingsD.storageSettings.keepAnyLocalFiles": "Any local files",
    "settingsD.storageSettings.keepUncommitted": "Uncommitted changes",
    "settingsD.storageSettings.keepTracked": "Edited tracked files",
    "settingsD.storageSettings.worktrees": "Worktrees",
    "settingsD.storageSettings.rotatedLogs": "Rotated logs",
    "settingsD.storageSettings.browserArtifacts": "Browser artifacts",
    "settingsD.storageSettings.machine": "Machine",
    "settingsD.storageSettings.project": "Project",
    "settingsD.storageSettings.folder": "Folder",
    "settingsD.storageSettings.thread": "Thread",
    "settingsD.storageSettings.nothingNeededCleanup": "{label}: Nothing needed cleanup.",
    "settingsD.storageSettings.cleanup": "Cleanup",
    "settingsD.storageSettings.lastRun": "Last run",
    "settingsD.storageSettings.turnOnRule": "Turn on a cleanup rule to use this.",
    "settingsD.storageSettings.deleting": "Deleting…",
    "settingsD.storageSettings.deleteNow": "Delete now",
    "settingsD.storageSettings.couldNotLoadLastRun": "Could not load the last run.",
    "settingsD.storageSettings.loadingLastRun": "Loading last run…",
    "settingsD.storageSettings.cleanupNotRun": "Cleanup hasn't run yet.",
    "settingsD.storageSettings.cleanupFailedOn": "Cleanup failed on {label}",
    "settingsD.storageSettings.couldNotRunCleanup": "Could not run cleanup on {label}",
    "settingsD.storageSettings.countsSummary": "{removed} removed, {kept} kept",
    "settingsD.storageSettings.countsFailed": ", {failed} failed",
    "settingsD.storageSettings.updateCleanupScope":
      "Update the selected environments to use storage cleanup, or choose a machine that supports it.",
    "settingsD.storageSettings.updateMachines":
      "Update the selected machines to configure project worktree cleanup.",
    "settingsD.storageSettings.mixedAcrossMachines": "Mixed across selected machines",
    "settingsD.storageSettings.automaticWorktreeCleanup": "Automatic worktree cleanup",
    "settingsD.storageSettings.keepProjectWorktrees":
      "Keep this project's worktrees until you delete them manually.",
    "settingsD.storageSettings.useProjectRules": "Use these rules for this project.",
    "settingsD.storageSettings.useMachineSettings": "Use each machine's worktree cleanup settings.",
    "settingsD.storageSettings.inherit": "Inherit",
    "settingsD.storageSettings.custom": "Custom",
    "settingsD.storageSettings.deleteWorktreesDeletedThreads":
      "Delete worktrees with deleted threads",
    "settingsD.storageSettings.deleteWorktreesDeletedThreadsDescription":
      "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
    "settingsD.storageSettings.deleteMergedWorktrees": "Delete merged worktrees",
    "settingsD.storageSettings.deleteMergedWorktreesDescription":
      "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
    "settingsD.storageSettings.deleteInactiveWorktrees": "Delete inactive worktrees",
    "settingsD.storageSettings.deleteInactiveWorktreesDescription":
      "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
    "settingsD.storageSettings.deleteSettledWorktrees": "Delete settled worktrees",
    "settingsD.storageSettings.offlineMachinesNoSetting":
      "Offline machines will not get this setting",
    "settingsD.storageSettings.deleteSettledWorktreesDescription":
      "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
    "settingsD.storageSettings.deleteUnchangedWorktrees": "Delete unchanged worktrees",
    "settingsD.storageSettings.deleteUnchangedWorktreesDescription":
      "Remove worktrees with no commits beyond the default branch.",
    "settingsD.storageSettings.keepWhenIncludesIgnored":
      "Includes ignored files, except node_modules.",
    "settingsD.storageSettings.keepWhenTracked":
      "Deletes untracked and ignored files, including .env.",
    "settingsD.storageSettings.keepWhenDefault":
      "Keeps edits and untracked files. Deletes ignored files, including .env.",
    "settingsD.storageSettings.keepWorktreesLocalChanges": "Keep worktrees with local changes",
    "settingsD.storageSettings.artifactsAndLogs": "Artifacts and logs",
    "settingsD.storageSettings.deleteOldBrowserArtifacts": "Delete old browser artifacts",
    "settingsD.storageSettings.deleteOldBrowserArtifactsDescription":
      "Delete saved browser captures after this many days. Older capture links will no longer open.",
    "settingsD.storageSettings.deleteOldRotatedLogs": "Delete old rotated logs",
    "settingsD.storageSettings.deleteOldRotatedLogsDescription":
      "Delete inactive rotated log files after this many days. Current logs are kept.",
    "settingsD.savedEnvironmentRows.statusOff": "Off",
    "settingsD.savedEnvironmentRows.connected": "Connected",
    "settingsD.savedEnvironmentRows.connecting": "Connecting",
    "settingsD.savedEnvironmentRows.reconnecting": "Reconnecting",
    "settingsD.savedEnvironmentRows.reconnectingWithError": "Reconnecting: {error}",
    "settingsD.savedEnvironmentRows.clientNotSupported": "Client not supported",
    "settingsD.savedEnvironmentRows.connectionFailed": "Connection failed",
    "settingsD.savedEnvironmentRows.connectionFailedWithError": "Connection failed: {error}",
    "settingsD.savedEnvironmentRows.offline": "Offline",
    "settingsD.savedEnvironmentRows.notConnected": "Not connected",
    "settingsD.savedEnvironmentRows.traceIdCopied": "Trace ID copied",
    "settingsD.savedEnvironmentRows.couldNotCopyTraceId": "Could not copy trace ID",
    "settingsD.savedEnvironmentRows.mcpUrlCopied": "MCP URL copied",
    "settingsD.savedEnvironmentRows.mcpUrlHint":
      "Add it to an agent, e.g. claude mcp add --transport http t3 {url}",
    "settingsD.savedEnvironmentRows.couldNotCopyMcpUrl": "Could not copy MCP URL",
    "settingsD.savedEnvironmentRows.restarting": "Restarting",
    "settingsD.savedEnvironmentRows.switchedOff": "Switched off",
    "settingsD.savedEnvironmentRows.updateAvailable": "\nUpdate available: {server} → {client}",
    "settingsD.savedEnvironmentRows.permissions": "Permissions",
    "settingsD.savedEnvironmentRows.hideRoutes": "Hide routes",
    "settingsD.savedEnvironmentRows.routes": "Routes",
    "settingsD.savedEnvironmentRows.copyMcpUrl": "Copy MCP URL",
    "settingsD.savedEnvironmentRows.copyTraceId": "Copy trace ID",
    "settingsD.savedEnvironmentRows.removing": "Removing…",
    "settingsD.savedEnvironmentRows.removeFromDevice": "Remove from this device…",
    "settingsD.savedEnvironmentRows.retryUpdate": "Retry update",
    "settingsD.savedEnvironmentRows.update": "Update",
    "settingsD.savedEnvironmentRows.switchOff": "Switch off",
    "settingsD.savedEnvironmentRows.switchOn": "Switch on",
    "settingsD.savedEnvironmentRows.switchOffFor": "Switch off {label}",
    "settingsD.savedEnvironmentRows.switchOnFor": "Switch on {label}",
    "settingsD.savedEnvironmentRows.moreActionsFor": "More actions for {label}",
    "settingsD.savedEnvironmentRows.serverLabel": "{label} server",
    "settingsD.savedEnvironmentRows.getMoreTunnels": "Get more tunnels",
    "settingsD.savedEnvironmentRows.noConnectPermission":
      "Your session does not have permission to manage T3 Connect access.",
    "settingsD.savedEnvironmentRows.signIn": "Sign in",
    "settingsD.savedEnvironmentRows.fix": "Fix: {fix}",
    "settingsD.savedEnvironmentRows.moreInfo": "More info",
    "settingsD.savedEnvironmentRows.t3ConnectLinked": "T3 Connect linked",
    "settingsD.savedEnvironmentRows.t3ConnectTunnelDisabled": "T3 Connect tunnel disabled",
    "settingsD.savedEnvironmentRows.t3ConnectUnlinked": "T3 Connect unlinked",
    "settingsD.savedEnvironmentRows.linkedDescription":
      "This environment is available through T3 Connect.",
    "settingsD.savedEnvironmentRows.tunnelRemovedDescription":
      "The managed tunnel was removed. Agent activity publishing stays on.",
    "settingsD.savedEnvironmentRows.unlinkedDescription":
      "This environment is no longer available through T3 Connect.",
    "settingsD.savedEnvironmentRows.agentActivityEnabled": "Agent activity enabled",
    "settingsD.savedEnvironmentRows.agentActivityDisabled": "Agent activity disabled",
    "settingsD.savedEnvironmentRows.publishingDescription":
      "This environment publishes agent activity to your mobile clients.",
    "settingsD.savedEnvironmentRows.stopPublishingDescription":
      "This environment will stop publishing agent activity.",
    "settingsD.savedEnvironmentRows.webhooksHeld": "Webhooks held while offline",
    "settingsD.savedEnvironmentRows.webhooksNoLongerHeld": "Webhooks no longer held",
    "settingsD.savedEnvironmentRows.webhooksHeldDescription":
      "T3 Connect keeps webhook requests for up to 24 hours while this environment is offline.",
    "settingsD.savedEnvironmentRows.webhooksNotHeldDescription":
      "Requests to an offline environment now fail. Anything already held is still delivered.",
    "settingsD.savedEnvironmentRows.signInToMakeAvailable":
      "Sign in to make this environment available to your other devices through T3 Connect.",
    "settingsD.savedEnvironmentRows.removedFromConnect":
      "This environment was removed from T3 Connect. Turn it on to link it again.",
    "settingsD.savedEnvironmentRows.reachabilityUnreachable":
      "T3 Connect is on, but other devices cannot reach this environment.",
    "settingsD.savedEnvironmentRows.reachableDescription":
      "This environment is available to your other devices through T3 Connect.",
    "settingsD.savedEnvironmentRows.reachabilityNotChecked":
      "T3 Connect is on. Reachability has not been checked yet.",
    "settingsD.savedEnvironmentRows.outOfSyncDescription":
      "T3 Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn T3 Connect on to repair it.",
    "settingsD.savedEnvironmentRows.makeAvailableDescription":
      "Make this environment available to your other devices through T3 Connect.",
    "settingsD.savedEnvironmentRows.publishSignInDescription":
      "Sign in to send activity to mobile notifications and Live Activities.",
    "settingsD.savedEnvironmentRows.publishDescription":
      "Send activity to mobile notifications and Live Activities without T3 Connect.",
    "settingsD.savedEnvironmentRows.removedRunLinkCommand":
      "This environment was removed from T3 Connect. Run `t3 connect link` on the host to link it again.",
    "settingsD.savedEnvironmentRows.publishAriaLabel": "Publish agent activity to mobile clients",
    "settingsD.savedEnvironmentRows.holdAriaLabel":
      "Hold webhook requests while this environment is offline",
    "settingsD.savedEnvironmentRows.holdDescription":
      "Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: T3 Connect only forwards requests and stores nothing.",
    "settingsD.savedEnvironmentRows.editPermissionsDescription":
      "To edit these settings, pair this connection with both View relay and Manage relay permissions.",
    "settingsD.savedEnvironmentRows.enableT3Connect": "Enable T3 Connect",
    "settingsD.savedEnvironmentRows.noRemoteEnvironments": "No saved remote environments",
    "settingsD.savedEnvironmentRows.addEnvironmentCloud":
      "Click “Add environment” to pair another environment, or connect one from T3 Connect.",
    "settingsD.savedEnvironmentRows.addEnvironment":
      "Click “Add environment” to pair another environment.",
    "settingsD.snapShotSetupDialog.stepAccess": "Access",
    "settingsD.snapShotSetupDialog.stepShortcut": "Shortcut",
    "settingsD.snapShotSetupDialog.gnomeNotInstalledTitle": "Install the extension",
    "settingsD.snapShotSetupDialog.gnomeNotInstalledDescription":
      "The Gustaf GNOME extension lets you capture other windows and bring them into your draft. Sign out once after installing.",
    "settingsD.snapShotSetupDialog.gnomeRestartTitle": "Extension installed",
    "settingsD.snapShotSetupDialog.gnomeRestartDescription":
      "Save your work, then sign out and back in. Your setup will be waiting here.",
    "settingsD.snapShotSetupDialog.gnomeUpdateTitle": "Update the extension",
    "settingsD.snapShotSetupDialog.gnomeUpdateDescription":
      "Install the update, then sign out and back in.",
    "settingsD.snapShotSetupDialog.gnomeExtensionsDisabledTitle": "Allow GNOME extensions",
    "settingsD.snapShotSetupDialog.gnomeExtensionsDisabledDescription":
      "Open GNOME Extensions and turn on extensions, then check again.",
    "settingsD.snapShotSetupDialog.gnomeDisabledTitle": "Enable the extension",
    "settingsD.snapShotSetupDialog.gnomeDisabledDescription":
      "Enable Gustaf SnapShots to start capturing windows.",
    "settingsD.snapShotSetupDialog.readyTitle": "Capture is ready",
    "settingsD.snapShotSetupDialog.readyDescription": "Next, choose your shortcut.",
    "settingsD.snapShotSetupDialog.unsupportedTitle": "Automatic capture isn't available",
    "settingsD.snapShotSetupDialog.unsupportedDescription":
      "Use Take snapshot from the command palette to choose a window.",
    "settingsD.snapShotSetupDialog.gnomeErrorTitle": "Couldn't set up the extension",
    "settingsD.snapShotSetupDialog.gnomeErrorDescription":
      "Check Gustaf SnapShots in GNOME Extensions, then try again.",
    "settingsD.snapShotSetupDialog.tryAgainTitle": "Let's try that again",
    "settingsD.snapShotSetupDialog.tryAgainDescription":
      "Couldn't check snapshots. Try again to continue.",
    "settingsD.snapShotSetupDialog.checkAccessTitle": "Check capture access",
    "settingsD.snapShotSetupDialog.checkAccessDescription":
      "The extension isn't ready yet. Try again in a moment.",
    "settingsD.snapShotSetupDialog.fixAccessTitle": "Let's fix capture access",
    "settingsD.snapShotSetupDialog.fixAccessDescription":
      "Try reinstalling the capture helper, then check again.",
    "settingsD.snapShotSetupDialog.updateHelperTitle": "Update the capture helper",
    "settingsD.snapShotSetupDialog.allowSnapshotsTitle": "Allow snapshots",
    "settingsD.snapShotSetupDialog.helperDescription":
      "Gustaf's capture helper lets you capture other apps and return to your draft. It's included with Gustaf.",
    "settingsD.snapShotSetupDialog.pickerTitle": "Choose a window each time",
    "settingsD.snapShotSetupDialog.pickerDescription":
      "Your desktop doesn't support automatic capture. You'll choose the window to capture instead.",
    "settingsD.snapShotSetupDialog.portalDescription":
      "Your desktop may ask for permission when you first capture.",
    "settingsD.snapShotSetupDialog.macReadyDescription":
      "Test a snapshot of the current window. If macOS asks to bypass its window picker, choose Allow. The test image is discarded.",
    "settingsD.snapShotSetupDialog.macAllowEachDescription":
      "Allow each permission, then continue.",
    "settingsD.snapShotSetupDialog.allowWhenPromptedDescription":
      "Allow access when prompted to start capturing windows.",
    "settingsD.snapShotSetupDialog.chooseShortcutTitle": "Choose your shortcut",
    "settingsD.snapShotSetupDialog.clickShortcutDescription":
      "Click the shortcut, then press the keys you want.",
    "settingsD.snapShotSetupDialog.chooseKeysDescription":
      "Choose your keys, then approve the permission prompt if asked.",
    "settingsD.snapShotSetupDialog.shiftKeysDescription":
      "Use both Shift keys, or record a different shortcut.",
    "settingsD.snapShotSetupDialog.setupTitle": "Set up snapshots",
    "settingsD.snapShotSetupDialog.setupDesktopTitle": "Set up snapshots for {desktop}",
    "settingsD.snapShotSetupDialog.screenRecording": "Screen Recording",
    "settingsD.snapShotSetupDialog.screenRecordingDescription": "Capture the window you're using.",
    "settingsD.snapShotSetupDialog.accessibility": "Accessibility",
    "settingsD.snapShotSetupDialog.accessibilityDescription":
      "Include text and controls from the captured app.",
    "settingsD.snapShotSetupDialog.accessibilityOptionalDescription":
      "Optional. Include text and controls from the captured app.",
    "settingsD.snapShotSetupDialog.reinstallHelper": "Reinstall helper",
    "settingsD.snapShotSetupDialog.shortcutPermissions": "Shortcut permissions",
    "settingsD.snapShotSetupDialog.tryAgain": "Try again",
    "settingsD.snapShotSetupDialog.needsAttention":
      "Capture needs attention. Go back to check access.",
    "settingsD.snapShotSetupDialog.couldNotFinish":
      "Couldn't finish this step. Try again or check Advanced for help.",
    "settingsD.snapShotSetupDialog.advanced": "Advanced",
    "settingsD.snapShotSetupDialog.includedNoDownload": "Included with Gustaf. No download needed.",
    "settingsD.snapShotSetupDialog.disableExtension": "Disable extension",
    "settingsD.snapShotSetupDialog.removeCaptureHelper": "Remove capture helper",
    "settingsD.snapShotSetupDialog.back": "Back",
    "settingsD.snapShotSetupDialog.close": "Close",
    "settingsD.snapShotSetupDialog.finishLater": "Finish later",
    "settingsD.snapShotSetupDialog.checking": "Checking…",
    "settingsD.snapShotSetupDialog.installing": "Installing…",
    "settingsD.snapShotSetupDialog.checkAgain": "Check again",
    "settingsD.snapShotSetupDialog.updateHelper": "Update helper",
    "settingsD.snapShotSetupDialog.installHelper": "Install helper",
    "settingsD.snapShotSetupDialog.updateExtension": "Update extension",
    "settingsD.snapShotSetupDialog.installExtension": "Install extension",
    "settingsD.snapShotSetupDialog.enableExtension": "Enable extension",
    "settingsD.snapShotSetupDialog.enabling": "Enabling…",
    "settingsD.snapShotSetupDialog.working": "Working…",
    "settingsD.snapShotSetupDialog.testCaptureContinue": "Test capture and continue",
    "settingsD.snapShotSetupDialog.allowCapture": "Allow capture",
    "settingsD.snapShotSetupDialog.continue": "Continue",
    "settingsD.snapShotSetupDialog.saving": "Saving…",
    "settingsD.snapShotSetupDialog.saveAndFinish": "Save and finish",
    "settingsD.snapShotSetupDialog.done": "Done",
    "settingsD.snapShotSettings.couldNotCheckCaptureSetup": "Couldn't check capture setup",
    "settingsD.snapShotSettings.couldNotOpenShortcutPermissions":
      "Couldn't open shortcut permissions",
    "settingsD.snapShotSettings.couldNotCompleteCaptureSetup": "Couldn't complete capture setup",
    "settingsD.snapShotSettings.couldNotSaveCaptureSettings": "Couldn't save capture settings",
    "settingsD.snapShotSettings.couldNotAllowAppText": "Couldn't allow app text capture",
    "settingsD.snapShotSettings.couldNotCheckShortcut": "Could not check this shortcut.",
    "settingsD.snapShotSettings.couldNotVerifyAccess": "Couldn't verify capture access",
    "settingsD.snapShotSettings.couldNotCloseSetup": "Couldn't close capture setup",
    "settingsD.snapShotSettings.pressShortcut": "Press your shortcut. Esc cancels.",
    "settingsD.snapShotSettings.alreadyUses": 'Gustaf already uses this for "{command}".',
    "settingsD.snapShotSettings.checkingShortcut": "Checking shortcut…",
    "settingsD.snapShotSettings.readyToSave": "Ready to save.",
    "settingsD.snapShotSettings.tryShortcutExample": "Try a shortcut such as Ctrl+Shift+2.",
    "settingsD.snapShotSettings.updatingSettings": "Updating capture settings…",
    "settingsD.snapShotSettings.enableSnapshots": "Enable snapshots",
    "settingsD.snapShotSettings.accessibilityDescription":
      "Include text and controls when the app makes them available.",
    "settingsD.snapShotSettings.includeAppText": "Include app text in snapshots",
    "settingsD.snapShotSettings.pickerShortcutDescription":
      "Choose a window to capture from any app.",
    "settingsD.snapShotSettings.shortcutDescription":
      "Capture the window you're using without switching apps.",
    "settingsD.snapShotSettings.changeShortcut": "Change shortcut",
    "settingsD.snapShotSettings.saving": "Saving…",
    "settingsD.snapShotSettings.save": "Save",
    "settingsD.snapShotSettings.cancel": "Cancel",
    "settingsD.snapShotSettings.shortcutPermissions": "Shortcut permissions",
    "settingsD.snapShotSettings.soundDescription": "Choose the sound played when capture starts.",
    "settingsD.snapShotSettings.soundAria": "Snapshot sound: {sound}",
    "settingsD.snapShotSettings.soundOff": "Off",
    "settingsD.snapShotSettings.soundWhooshDefault": "Whoosh (Default)",
    "settingsD.snapShotSettings.soundClick": "Click",
    "settingsD.snapShotSettings.playWhoosh": "Play Whoosh",
    "settingsD.snapShotSettings.playClick": "Play Click",
    "settingsD.snapShotSettings.flashDescription": "Show a gentle cue on the captured window.",
    "settingsD.snapShotSettings.flashAria": "Flash captured window",
    "settingsD.snapShotSettings.animationsDescription": "Animate captured windows into your draft.",
    "settingsD.snapShotSettings.animationsAria": "Animate snapshots",
    "settingsD.settingsScopeSentence.noMatches": "No matches found.",
    "settingsD.settingsScopeSentence.environmentScope": "Environment scope",
    "settingsD.settingsScopeSentence.unavailableEnvironment": "Unavailable environment",
    "settingsD.settingsScopeSentence.noEnvironments": "No environments",
    "settingsD.settingsScopeSentence.allEnvironments": "All environments",
    "settingsD.settingsScopeSentence.searchEnvironments": "Search environments",
    "settingsD.settingsScopeSentence.projectScope": "Project scope",
    "settingsD.settingsScopeSentence.unavailableProject": "Unavailable project",
    "settingsD.settingsScopeSentence.allProjects": "All projects",
    "settingsD.settingsScopeSentence.searchProjects": "Search projects",
    "settingsD.settingsScopeSentence.archived": "Archived",
    "settingsD.simlockDeviceHostEditor.invalidSecretReference": "Enter a valid secret reference.",
    "settingsD.simlockDeviceHostEditor.addHost": "Add Simlock host",
    "settingsD.simlockDeviceHostEditor.editHost": "Edit Simlock host",
    "settingsD.simlockDeviceHostEditor.multiEnvironmentDescription":
      "Each selected environment's server leases devices from your Simlock gateway with its own agent token, and releases them when they close.",
    "settingsD.simlockDeviceHostEditor.singleEnvironmentDescription":
      "The environment's server leases devices from your Simlock gateway and releases them when they close.",
    "settingsD.simlockDeviceHostEditor.name": "Name",
    "settingsD.simlockDeviceHostEditor.gatewayUrl": "Gateway URL",
    "settingsD.simlockDeviceHostEditor.agentTokenFor": "Agent token · {label}",
    "settingsD.simlockDeviceHostEditor.agentToken": "Agent token",
    "settingsD.simlockDeviceHostEditor.devicesAtOnce": "Devices at once",
    "settingsD.simlockDeviceHostEditor.leaseMinutes": "Lease minutes",
    "settingsD.simlockDeviceHostEditor.leaseEndsNote":
      "A lease ends after the lease minutes even while in use.",
    "settingsD.simlockDeviceHostEditor.savingRestarts":
      " Saving restarts this host, which releases its devices.",
    "settingsD.simlockDeviceHostEditor.cancel": "Cancel",
    "settingsD.simlockDeviceHostEditor.saveHost": "Save host",
    "settingsD.simlockDeviceHostEditor.checking": "Checking…",
    "settingsD.simlockDeviceHostEditor.usingDeviceToken":
      "Using this machine's agent-device token ({signedInAs}).",
    "settingsD.simlockDeviceHostEditor.acceptedAs": "Accepted as {signedInAs}.",
    "settingsD.simlockDeviceHostEditor.clearAgentToken": "Clear agent token",
    "settingsD.snoozePresetsSettings.description":
      "Choices in every snooze menu, listed soonest first. Weekdays mean the next one after today.",
    "settingsD.snoozePresetsSettings.whenAfter": "In",
    "settingsD.snoozePresetsSettings.whenToday": "Today",
    "settingsD.snoozePresetsSettings.whenTomorrow": "Tomorrow",
    "settingsD.snoozePresetsSettings.whenMonday": "Monday",
    "settingsD.snoozePresetsSettings.whenTuesday": "Tuesday",
    "settingsD.snoozePresetsSettings.whenWednesday": "Wednesday",
    "settingsD.snoozePresetsSettings.whenThursday": "Thursday",
    "settingsD.snoozePresetsSettings.whenFriday": "Friday",
    "settingsD.snoozePresetsSettings.whenSaturday": "Saturday",
    "settingsD.snoozePresetsSettings.whenSunday": "Sunday",
    "settingsD.snoozePresetsSettings.passedToday": "Passed for today",
    "settingsD.snoozePresetsSettings.duplicateOption": "Duplicate of an option above",
    "settingsD.snoozePresetsSettings.sameTimeOption": "Same time as an option above",
    "settingsD.snoozePresetsSettings.optionAria": "Snooze option {index}",
    "settingsD.snoozePresetsSettings.removeOptionAria": "Remove snooze option {index}",
    "settingsD.snoozePresetsSettings.menusOnlyCustom": "Menus offer only Custom…",
    "settingsD.snoozePresetsSettings.menuNow": "Menu now: {options}",
    "settingsD.snoozePresetsSettings.addOption": "Add option",
    "settingsD.snoozePresetsSettings.upToOptions": "Up to {max} options",
    "settingsD.snoozePresetsSettings.time": "Time",
    "settingsD.snoozePresetsSettings.decrease": "Decrease",
    "settingsD.snoozePresetsSettings.amount": "Amount",
    "settingsD.snoozePresetsSettings.increase": "Increase",
    "settingsD.snoozePresetsSettings.when": "When",
    "settingsD.snoozePresetsSettings.unit": "Unit",
    "settingsD.snoozePresetsSettings.atTime": "at",
    "settingsD.snoozePresetsSettings.unitMinutes": "minutes",
    "settingsD.snoozePresetsSettings.unitHours": "hours",
    "settingsD.snoozePresetsSettings.unitDays": "days",
    "settingsD.snoozePresetsSettings.unitMinute": "minute",
    "settingsD.snoozePresetsSettings.unitHour": "hour",
    "settingsD.snoozePresetsSettings.unitDay": "day",
    "settingsD.settingsScopeSentence.applyingFor": "Applying settings for",
    "settingsD.settingsScopeSentence.on": "on",
    "settingsD.settingsScopeSentence.across": "across",
    "settingsD.settingsScopeSentence.offline": "Offline",
    "settingsD.typographySettings.systemDefault": "System default",
    "settingsD.typographySettings.systemMonospace": "System monospace",
    "settingsD.typographySettings.interfaceFontSize": "Interface font size",
    "settingsD.typographySettings.promptFontSize": "Prompt font size",
    "settingsD.typographySettings.codeFontSize": "Code font size",
    "settingsD.typographySettings.terminalFontSize": "Terminal font size",
    "settingsD.typographySettings.wrapCodeAria": "Wrap code, diffs, and file previews by default",
    "settingsD.typographySettings.separateFontsAria": "Separate fonts",
    "settingsD.typographySettings.resetFontSmoothing": "font smoothing",
    "settingsD.typographySettings.resetWordWrap": "word wrapping",
    "settingsD.sourceControlAccountSettings.hiddenAccount": "Hidden account",
    "settingsD.sourceControlAccountSettings.signedInAs": "Signed in as",
    "settingsD.sourceControlAccountSettings.account": "Account",
    "settingsD.sourceControlAccountSettings.activeAccount": "Active {cli} account",
    "settingsD.sourceControlAccountSettings.accountNumber": "Account {index}",
    "settingsD.sourceControlAccountSettings.useActiveLogin": "Use active login",
    "settingsD.sourceControlAccountSettings.staleLogin":
      "The chosen login is no longer signed in, so the active {cli} login is used.",
    "settingsD.sourceControlAccountSettings.cantBeUsed": "can't be used: {error}",
    "settingsD.sourceControlAccountSettings.invalidLogin": "{cli} reports this login as invalid.",
    "settingsD.sourceControlAccountSettings.envOverrides":
      "{var} is set on the server, so it overrides the account chosen here until it is unset.",
    "settingsD.sourceControlAccountSettings.hideAccountsAria": "Hide {label} accounts",
    "settingsD.sourceControlAccountSettings.revealAccountsAria": "Reveal {label} accounts",
    "settingsD.sourceControlAccountSettings.useOnHostAria": "Use {label} on {host}",
    "settingsD.sourceControlAccountSettings.accountForHostAria": "{label} account for {host}",
    "settingsD.sourceControlTokenSettings.host": "Host",
    "settingsD.sourceControlTokenSettings.token": "Token",
    "settingsD.sourceControlTokenSettings.remove": "Remove",
    "settingsD.sourceControlTokenSettings.save": "Save",
    "settingsD.sourceControlTokenSettings.createToken": "Create a token",
    "settingsD.sourceControlTokenSettings.noTokenSaved":
      "No token saved; the server uses {envVar} or the {cli} login.",
    "settingsD.sourceControlTokenSettings.savedFor": "Saved for {hosts}.",
    "settingsD.settingsBreadcrumb.settings": "Settings",
    "settingsD.settingsBreadcrumb.ariaLabel": "Settings breadcrumb",
    "settingsD.settingsSidebarNav.sectionsAria": "Settings sections",
    "settingsD.settingsSidebarNav.search": "Search",
    "settingsD.settingsSidebarNav.searchSettings": "Search settings",
    "settingsD.settingsSidebarNav.clearSearch": "Clear settings search",
    "settingsD.settingsSidebarNav.noSettingsFound": "No settings found",
    "settingsD.settingsSidebarNav.searchResults": "Settings search results",
    "settingsD.settingsPanels.streamingTurn": "Wait for the full response",
    "settingsD.settingsPanels.streamingParagraph": "Show finished paragraphs",
    "settingsD.settingsPanels.streamingTurnDescription":
      "Text appears once the agent finishes its turn.",
    "settingsD.settingsPanels.streamingParagraphDescription":
      "Each paragraph or code block appears as soon as it is complete.",
    "settingsD.settingsPanels.updateDownloadFailed": "Could not download update",
    "settingsD.settingsPanels.downloadFailed": "Download failed.",
    "settingsD.settingsPanels.updateConfirmFailed": "Could not confirm update",
    "settingsD.settingsPanels.updateConfirmFailedDescription": "Update confirmation failed.",
    "settingsD.settingsPanels.installFailed": "Could not install update",
    "settingsD.settingsPanels.installFailedDescription": "Install failed.",
    "settingsD.settingsPanels.checkUpdatesFailed": "Could not check for updates",
    "settingsD.settingsPanels.checkUpdatesFailedDescription": "Update check failed.",
    "settingsD.settingsPanels.download": "Download",
    "settingsD.settingsPanels.install": "Install",
    "settingsD.settingsPanels.checking": "Checking…",
    "settingsD.settingsPanels.downloading": "Downloading…",
    "settingsD.settingsPanels.upToDate": "Up to Date",
    "settingsD.settingsPanels.checkForUpdates": "Check for Updates",
    "settingsD.settingsPanels.updateAvailable": "Update available.",
    "settingsD.settingsPanels.updateTrack": "Update track",
    "settingsD.settingsPanels.updateTrackDescription": "Switches the hosted app release channel.",
    "settingsD.settingsPanels.couldNotRestoreTheme": "Couldn’t restore theme settings",
    "settingsD.settingsPanels.tryAgain": "Try again.",
    "settingsD.settingsPanels.autoSettleInactivityAria": "Days of inactivity before auto-settle",
    "settingsD.settingsPanels.compactIdleThreads": "Compact idle threads",
    "settingsD.settingsPanels.compactIdleDescription":
      "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.",
    "settingsD.settingsPanels.newProjects": "New projects",
    "settingsD.settingsPanels.addProjectBaseDirectory": "Add project base directory",
    "settingsD.settingsPanels.cloneDescription":
      "Clones go to github.com/owner/repo under the folder above, like ghq.",
    "settingsD.settingsPanels.cloneIntoHostFolders": "Clone into host folders",
    "settingsD.settingsPanels.snooze": "Snooze",
    "settingsD.settingsPanels.usageLimits": "Usage limits",
    "settingsD.settingsPanels.autoResumeDescription":
      "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
    "settingsD.settingsPanels.resumeAfterLimits": "Resume after usage limits",
    "settingsD.settingsPanels.snoozeUntilLimitsDescription":
      "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
    "settingsD.settingsPanels.snoozeUntilLimits": "Snooze until limits reset",
    "settingsD.settingsPanels.autoSettle": "Auto-settle",
    "settingsD.settingsPanels.autoSettleMergedDescription":
      "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
    "settingsD.settingsPanels.autoSettleMerged": "Auto-settle merged threads",
    "settingsD.settingsPanels.autoSettleInactiveDescription":
      "Sidebar threads with no activity for this long settle automatically.",
    "settingsD.settingsPanels.autoSettleInactive": "Auto-settle inactive threads",
    "settingsD.settingsPanels.newActivityDescription":
      "Any new activity un-settles a thread automatically.",
    "settingsD.settingsPanels.keepThreadsWithPr": "Keep threads with a PR",
    "settingsD.settingsPanels.keepThreadsWithPrDescription":
      "Inactivity does not settle threads with a pull request. Merge and close still do.",
    "settingsD.settingsPanels.textGeneration": "Text generation",
    "settingsD.settingsPanels.textGenerationDescription":
      "For thread titles and other generated text. Source control has its own setting. Text generators from Providers also appear here.",
    "settingsD.settingsPanels.textGenerationModelNotSaved": "Text generation model not saved",
    "settingsD.settingsPanels.mixed": "Mixed",
    "settingsD.settingsPanels.differentStreamingModes":
      "The selected targets use different streaming modes.",
    "settingsD.settingsPanels.responseStreaming": "Response streaming",
    "settingsD.settingsPanels.updates": "Updates",
    "settingsD.settingsPanels.providerUpdatesDescription":
      "Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear.",
    "settingsD.settingsPanels.checkProviderVersions": "Check provider versions",
    "settingsD.settingsPanels.keepAwake": "Keep computer awake",
    "settingsD.settingsPanels.keepAwakeOff": "Off",
    "settingsD.settingsPanels.keepAwakeWhileWorking": "While agents work",
    "settingsD.settingsPanels.keepAwakeAlways": "Always",
    "settingsD.settingsPanels.keepAwakeOffDescription":
      "The computer sleeps as usual, which pauses running agents.",
    "settingsD.settingsPanels.keepAwakeWhileWorkingDescription":
      "Keeps the computer awake while agents work and lets it sleep a minute after they finish. Closing a laptop lid still puts it to sleep.",
    "settingsD.settingsPanels.keepAwakeAlwaysDescription":
      "Keeps the computer awake as long as Gustaf runs, for example to reach it from your phone. Closing a laptop lid still puts it to sleep.",
    "settingsD.settingsPanels.differentKeepAwakeModes":
      "Environments use different settings. Choose one to apply it to all.",
    "settingsD.settingsPanels.continueAfterRestartsDescription":
      "Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments.",
    "settingsD.settingsPanels.restartContinuationRequired":
      "All selected connected environments must support restart continuation.",
    "settingsD.settingsPanels.continueAfterRestarts": "Continue threads after restarts",
    "settingsD.settingsPanels.backgroundActivity": "Background activity",
    "settingsD.settingsPanels.diagnostics": "Diagnostics",
    "settingsD.settingsPanels.inspectThisEnvironment":
      "Inspect processes, resource use, and logs on this environment.",
    "settingsD.settingsPanels.inspectOneEnvironment":
      "Inspect processes, resource use, and logs on one environment at a time.",
    "settingsD.settingsPanels.app": "App",
    "settingsD.settingsPanels.organization": "Organization",
    "settingsD.settingsPanels.currentVersion": "Current version of the application.",
    "settingsD.settingsPanels.legal": "Legal",
    "settingsD.settingsPanels.legalDescription":
      "How we handle your data, including the anonymous usage data Gustaf collects.",
    "settingsD.settingsPanels.licensesDescription":
      "Notices for dependencies, assets, and optional tools used by Gustaf.",
    "settingsD.sourceControlWritingSettings.repoConventions": "Repository conventions",
    "settingsD.sourceControlWritingSettings.repoConventionsDescription":
      "In each project, matches recent change descriptions and change request titles.",
    "settingsD.sourceControlWritingSettings.conventionalCommits": "Conventional Commits",
    "settingsD.sourceControlWritingSettings.conventionalCommitsDescription":
      "Use Conventional Commit prefixes and keep change request text concise.",
    "settingsD.sourceControlWritingSettings.customInstructions": "Custom instructions",
    "settingsD.sourceControlWritingSettings.customInstructionsDescription":
      "Use your instructions for change descriptions and change requests in every project.",
    "settingsD.sourceControlWritingSettings.writingReview": "Writing & review",
    "settingsD.sourceControlWritingSettings.writingStyleAria": "Source control writing style",
    "settingsD.sourceControlWritingSettings.mixed": "Mixed",
    "settingsD.sourceControlWritingSettings.customAllAria":
      "Custom source control instructions for all selected environments",
    "settingsD.sourceControlWritingSettings.customAllPlaceholder":
      "Write the instructions each selected environment should use.",
    "settingsD.sourceControlWritingSettings.applyToAll": "Apply instructions to all",
    "settingsD.sourceControlWritingSettings.writeForAll": "Write custom instructions for all",
    "settingsD.sourceControlWritingSettings.writingPlaceholder":
      "Keep titles concise. Use short bullet points in descriptions.",
    "settingsD.sourceControlWritingSettings.writingAria":
      "Custom source control writing instructions",
    "settingsD.sourceControlWritingSettings.reviewGuidesDescription":
      "Add a Guide tab to pull requests. An agent explains the changes and points out decisions that need review.",
    "settingsD.sourceControlWritingSettings.reviewGuidesAria": "Review guides",
    "settingsD.sourceControlWritingSettings.reviewGuideModelDescription":
      "Must be a coding agent: it reads the pull request over many steps. Off uses the writer model, or Codex or Claude if that model is a text generator.",
    "settingsD.sourceControlWritingSettings.connectForReviewGuide":
      "Connect an environment to choose its review guide model.",
    "settingsD.sourceControlWritingSettings.reviewGuideModelAria": "Review guide model",
    "settingsD.sourceControlWritingSettings.reviewGuideModelNotSaved":
      "Review guide model not saved",
    "settingsD.sourceControlWritingSettings.separateReviewGuideModel":
      "Use a separate review guide model",
    "settingsD.sourceControlWritingSettings.reviewGuideInstructionsDescription":
      "Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same.",
    "settingsD.sourceControlWritingSettings.reviewGuideInstructionsAria":
      "Review guide instructions",
    "settingsD.sourceControlWritingSettings.mixedReviewGuidePlaceholder":
      "Mixed. Enter instructions to apply to all selected targets.",
    "settingsD.sourceControlWritingSettings.reviewGuidePlaceholder":
      "Show service interfaces before implementations. Skip test files unless they change behavior. Keep summaries to two sentences.",
    "settingsD.sourceControlWritingSettings.templatesDescription":
      "Use the repository's template for change request descriptions when available.",
    "settingsD.sourceControlWritingSettings.followTemplatesAria": "Follow change request templates",
    "settingsD.sourceControlWritingSettings.writerModelDescription":
      "Model for source control text and branch or bookmark names. When disabled, use the text generation model configured for this environment.",
    "settingsD.sourceControlWritingSettings.connectForWriterModel":
      "Connect an environment to choose its source control writer model.",
    "settingsD.sourceControlWritingSettings.noTextGenProviders":
      "No text generation providers available.",
    "settingsD.sourceControlWritingSettings.writerModelAria": "Source control writer model",
    "settingsD.sourceControlWritingSettings.writerModelNotSaved":
      "Source control writer model not saved",
    "settingsD.sourceControlWritingSettings.separateWriterModel":
      "Use a separate source control writer model",
    "settingsD.sourceControlSettings.authenticated": "Authenticated",
    "settingsD.sourceControlSettings.notAuthenticated": "Not authenticated",
    "settingsD.sourceControlSettings.statusUnknown": "Status unknown",
    "settingsD.sourceControlSettings.asAccount": "as",
    "settingsD.sourceControlSettings.everyHostOff": "Every {label} host is turned off.",
    "settingsD.sourceControlSettings.available": "Available",
    "settingsD.sourceControlSettings.comingSoon": "Support for {label} is coming soon.",
    "settingsD.sourceControlSettings.notAvailableOnServer": "Not available on this server: {hint}",
    "settingsD.sourceControlSettings.availableWithHint": "Available. {hint}",
    "settingsD.sourceControlSettings.couldNotVerify": "Could not verify {label}. {detail}",
    "settingsD.sourceControlSettings.comingSoonBadge": "Coming Soon",
    "settingsD.sourceControlSettings.toggleDetails": "Toggle {label} details",
    "settingsD.sourceControlSettings.toggleAccountVisibility":
      "Toggle source control account visibility",
    "settingsD.sourceControlSettings.revealAccount": "Click to reveal account",
    "settingsD.sourceControlSettings.hideAccount": "Click to hide account",
    "settingsD.sourceControlSettings.serverEnvironment": "Server environment",
    "settingsD.sourceControlSettings.scanFailed": "Could not scan the server environment",
    "settingsD.sourceControlSettings.nothingDetected": "Nothing detected yet",
    "settingsD.sourceControlSettings.installGitHint":
      "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan.",
    "settingsD.sourceControlSettings.scan": "Scan",
    "settingsD.sourceControlSettings.orUseCredentials": "Or use your own credentials",
    "settingsD.sourceControlSettings.rescanAria": "Rescan server environment",
    "settingsD.sourceControlSettings.rescanTooltip": "Rescan Git and hosting integrations",
    "settingsD.sourceControlSettings.connectToInspect":
      "Connect an environment to inspect its version control tools and hosting integrations.",
    "settingsD.sourceControlSettings.versionControl": "Version Control",
    "settingsD.sourceControlSettings.providers": "Source control providers",
    "settingsD.sourceControlAppSignIn.signedInAs": "Signed in as",
    "settingsD.sourceControlAppSignIn.accountAria": "Signed-in GitHub account",
    "settingsD.sourceControlAppSignIn.showAccount": "Show account",
    "settingsD.sourceControlAppSignIn.hideAccount": "Hide account",
    "settingsD.sourceControlAppSignIn.signedInWithSavedToken":
      "Signed in, but the token saved below is used while it can be read.",
    "settingsD.sourceControlAppSignIn.signedIn": "Signed in",
    "settingsD.sourceControlAppSignIn.signOut": "Sign out",
    "settingsD.sourceControlAppSignIn.approveApp":
      "Approve the app on GitHub to finish signing in.",
    "settingsD.sourceControlAppSignIn.cancel": "Cancel",
    "settingsD.sourceControlAppSignIn.tryAgain": "Try again",
    "settingsD.sourceControlAppSignIn.signInWithGitHub": "Sign in with GitHub",
    "settingsD.sourceControlAppSignIn.copyCodeAria": "Copy code",
    "settingsD.sourceControlAppSignIn.copyCodeAndOpen": "Copy code & open GitHub",
    "settingsD.sourceControlAppSignIn.reachesRepositories":
      "Reaches repositories in accounts and organizations that installed the app.",
    "settingsD.sourceControlAppSignIn.installOnOrganization": "Install on an organization",
    "settingsD.sourceControlAppSignIn.manageOnGitHub": "Manage on GitHub",
    "settingsD.settingInheritance.environment": "Environment",
    "settingsD.settingInheritance.sameOnAllMachines": "Same on all machines",
    "settingsD.settingInheritance.overriddenBy": "Overridden by",
    "settingsD.speechLanguageSelect.autoDetect": "Auto-detect",
    "settingsD.speechLanguageSelect.unavailable": "{language} unavailable",
    "settingsD.speechLanguageSelect.autoWithLabel": "Auto ({label})",
    "settingsD.speechLanguageSelect.transcriptionLanguage": "Transcription language",
    "settingsD.speechLanguageSelect.auto": "Auto",
    "settingsD.secretInput.storedReplace": "Stored secret, enter a new value to replace",
    "settingsD.secretInput.notSet": "Not set",
    "settingsD.sessionPermissions.routePermissions":
      "These permissions apply to your active route. Other routes may have different permissions.",
    "settingsD.sessionPermissions.connectionPermissions":
      "These permissions apply to this client’s current connection.",
    "settingsD.sessionPermissions.allowed": "Allowed",
    "settingsD.sessionPermissions.notGranted": "Not granted",
    "settingsD.account.title": "Account",
    "settingsD.account.loading": "Loading…",
    "settingsD.account.notSignedIn": "Not signed in",
    "settingsD.account.signedOutDescription":
      "Sign in to your Gustaf account to see and manage the devices linked to it.",
    "settingsD.account.expired": "Your session has expired. Sign in again.",
    "settingsD.account.finishInBrowser": "Finish signing in in your browser.",
    "settingsD.account.signIn": "Sign in with GitHub",
    "settingsD.account.cancel": "Cancel",
    "settingsD.account.signOut": "Sign out",
    "settingsD.account.unnamed": "GitHub account",
    "settingsD.account.devices": "Devices",
    "settingsD.account.devicesDescription": "Computers and phones linked to this account.",
    "settingsD.account.noDevices": "No devices are linked to this account yet.",
    "settingsD.account.thisComputer": "This computer",
    "settingsD.account.registerThisComputer": "Register this computer",
    "settingsD.account.revoke": "Revoke",
    "settingsD.account.revokeConfirm": "Revoke “{name}”? It will lose access to this account.",
    "settingsD.account.signInFailed": "Could not sign in",
    "settingsD.account.actionFailed": "Account action failed",
    "settingsD.account.devicesFailed": "Could not load devices",
  },
  ru: {
    "settingsD.scheduledTasksSettings.workspaceModeWorktree": "Создать новый worktree",
    "settingsD.scheduledTasksSettings.workspaceModeRoot": "Использовать рабочую копию проекта",
    "settingsD.scheduledTasksSettings.workspaceModeExisting":
      "Использовать конкретную рабочую копию",
    "settingsD.scheduledTasksSettings.filters": "Фильтры",
    "settingsD.scheduledTasksSettings.filtersHint":
      "Запускается, только если совпадают все фильтры. Остальные запросы записываются как отфильтрованные. Значения для «is one of» разделяйте запятыми; значение не может содержать запятую.",
    "settingsD.scheduledTasksSettings.addFilter": "Добавить фильтр",
    "settingsD.scheduledTasksSettings.filterPath": "Путь фильтра {index}",
    "settingsD.scheduledTasksSettings.removeFilter": "Удалить фильтр {index}",
    "settingsD.scheduledTasksSettings.filterOperator": "Оператор фильтра {index}",
    "settingsD.scheduledTasksSettings.filterValue": "Значение фильтра {index}",
    "settingsD.scheduledTasksSettings.title": "Запланированные задачи",
    "settingsD.scheduledTasksSettings.newTask": "Новая задача",
    "settingsD.scheduledTasksSettings.unavailableSelection": "Выбор недоступен",
    "settingsD.scheduledTasksSettings.noEnvironments": "Нет доступных окружений",
    "settingsD.scheduledTasksSettings.connectEnvironment":
      "Подключите окружение, чтобы управлять запланированными задачами.",
    "settingsD.scheduledTasksSettings.summaryNotConnected": "Не подключено:",
    "settingsD.scheduledTasksSettings.summaryLoading": "Загрузка запланированных задач на",
    "settingsD.scheduledTasksSettings.summaryCouldNotLoad":
      "Не удалось загрузить запланированные задачи:",
    "settingsD.scheduledTasksSettings.summaryNoTasks": "Нет задач на",
    "settingsD.scheduledTasksSettings.taskUnavailable": "Задача недоступна",
    "settingsD.scheduledTasksSettings.taskUnavailableHint":
      "Эта задача удалена или относится к другому проекту. Проверьте фильтр проектов.",
    "settingsD.scheduledTasksSettings.noScheduledTasks": "Нет запланированных задач",
    "settingsD.scheduledTasksSettings.noTasksMatch":
      "Нет задач, подходящих под выбранные окружение и проект.",
    "settingsD.scheduledTasksSettings.environmentDisconnected": "Окружение отключено",
    "settingsD.scheduledTasksSettings.reconnect":
      "Переподключите {label}, чтобы посмотреть его запланированные задачи.",
    "settingsD.scheduledTasksSettings.couldNotLoad": "Не удалось загрузить запланированные задачи",
    "settingsD.scheduledTasksSettings.loadingTasks": "Загрузка запланированных задач…",
    "settingsD.scheduledTasksSettings.couldNotUpdate": "Не удалось обновить запланированную задачу",
    "settingsD.scheduledTasksSettings.paused": "Приостановлено",
    "settingsD.scheduledTasksSettings.listening": "Принимает запросы",
    "settingsD.scheduledTasksSettings.notScheduled": "Не запланировано",
    "settingsD.scheduledTasksSettings.enableTask": "Включить {title}",
    "settingsD.scheduledTasksSettings.actionsFor": "Действия для {title}",
    "settingsD.scheduledTasksSettings.edit": "Изменить",
    "settingsD.scheduledTasksSettings.deliveries": "Доставки",
    "settingsD.scheduledTasksSettings.runNow": "Запустить сейчас",
    "settingsD.scheduledTasksSettings.delete": "Удалить",
    "settingsD.scheduledTasksSettings.openThread": "Открыть тред",
    "settingsD.scheduledTasksSettings.deliveriesTitle": "Доставки · {title}",
    "settingsD.scheduledTasksSettings.recentRequests":
      "Последние запросы к webhook-адресу этой задачи.",
    "settingsD.scheduledTasksSettings.loadingDelivery": "Загрузка доставки…",
    "settingsD.scheduledTasksSettings.signatureVerified": "Подпись проверена",
    "settingsD.scheduledTasksSettings.scheduledRun": "Запланированный запуск",
    "settingsD.scheduledTasksSettings.promptSent": "Промпт, отправленный агенту",
    "settingsD.scheduledTasksSettings.runScheduledWindow":
      "Запуск запланирован на закрытие окна; запуск ещё не начат.",
    "settingsD.scheduledTasksSettings.noRunStarted": "Для этого запроса запуск не был начат.",
    "settingsD.scheduledTasksSettings.emptyPlaceholders": "Пустые плейсхолдеры: {fields}",
    "settingsD.scheduledTasksSettings.headers": "Заголовки",
    "settingsD.scheduledTasksSettings.query": "Строка запроса",
    "settingsD.scheduledTasksSettings.bodyTruncated": "Тело (обрезано)",
    "settingsD.scheduledTasksSettings.body": "Тело",
    "settingsD.scheduledTasksSettings.emptyBody": "(пусто)",
    "settingsD.scheduledTasksSettings.back": "Назад",
    "settingsD.scheduledTasksSettings.refresh": "Обновить",
    "settingsD.scheduledTasksSettings.done": "Готово",
    "settingsD.scheduledTasksSettings.noRequests": "Запросов пока нет.",
    "settingsD.scheduledTasksSettings.loadingDeliveries": "Загрузка доставок…",
    "settingsD.scheduledTasksSettings.urlAfterSave": "URL появится после сохранения.",
    "settingsD.scheduledTasksSettings.rotateConfirmDialog":
      "Перевыпустить этот webhook-адрес?\nТекущий адрес перестанет работать.",
    "settingsD.scheduledTasksSettings.rotateConfirm":
      "Перевыпустить этот webhook-адрес? Текущий адрес перестанет работать.",
    "settingsD.scheduledTasksSettings.couldNotRotate": "Не удалось перевыпустить webhook-адрес",
    "settingsD.scheduledTasksSettings.webhookUrl": "Webhook-адрес",
    "settingsD.scheduledTasksSettings.copied": "Скопировано",
    "settingsD.scheduledTasksSettings.copy": "Копировать",
    "settingsD.scheduledTasksSettings.rotate": "Перевыпустить",
    "settingsD.scheduledTasksSettings.heldOffline":
      "Удерживаются до 24 часов, пока окружение офлайн. ",
    "settingsD.scheduledTasksSettings.forwardedLive":
      "Передаются сразу. Запросы завершаются ошибкой, пока окружение офлайн. ",
    "settingsD.scheduledTasksSettings.changeInSharing": "Изменить в разделе «Общий доступ»",
    "settingsD.scheduledTasksSettings.threadModeNew": "Новый тред при каждом запуске",
    "settingsD.scheduledTasksSettings.threadModeContinue": "Один тред, продолжающий разговор",
    "settingsD.scheduledTasksSettings.threadModeFresh":
      "Один тред, новая сессия при каждом запуске",
    "settingsD.scheduledTasksSettings.startedByFirstRun": "Создан первым запуском",
    "settingsD.scheduledTasksSettings.threadFallback": "Тред {id}",
    "settingsD.scheduledTasksSettings.detailNewThread":
      "Каждый запуск создаёт новый тред с рабочей копией и моделью ниже.",
    "settingsD.scheduledTasksSettings.detailContinueNoThread":
      "Первый запуск создаёт тред с рабочей копией и моделью ниже. Последующие запуски продолжают этот разговор.",
    "settingsD.scheduledTasksSettings.detailFreshNoThread":
      "Первый запуск создаёт тред с рабочей копией и моделью ниже. Последующие запуски пишут туда, каждый в новой сессии без контекста предыдущих запусков.",
    "settingsD.scheduledTasksSettings.detailContinueThread":
      "Каждый запуск продолжает этот разговор в его рабочей копии и с текущей моделью.",
    "settingsD.scheduledTasksSettings.detailFreshThread":
      "Каждый запуск начинает новую сессию в этом треде, без контекста предыдущих запусков.",
    "settingsD.scheduledTasksSettings.destination": "Назначение",
    "settingsD.scheduledTasksSettings.destinationThread": "Тред назначения",
    "settingsD.scheduledTasksSettings.searchThreads": "Поиск тредов",
    "settingsD.scheduledTasksSettings.searchAllThreads": "Поиск по всем тредам...",
    "settingsD.scheduledTasksSettings.noThreads": "Треды не найдены.",
    "settingsD.scheduledTasksSettings.untitledThread": "Тред без названия",
    "settingsD.scheduledTasksSettings.deletingThreadDeletesTask":
      "Удаление треда также удалит эту задачу.",
    "settingsD.scheduledTasksSettings.incompleteTitle": "Задача заполнена не полностью",
    "settingsD.scheduledTasksSettings.incompleteDescription":
      "Добавьте название, промпт, проект и модель.",
    "settingsD.scheduledTasksSettings.invalidFilter": "Некорректный фильтр",
    "settingsD.scheduledTasksSettings.secretRequired": "Нужен секрет для подписи",
    "settingsD.scheduledTasksSettings.secretRequiredDescription":
      "Введите заголовок подписи и секрет.",
    "settingsD.scheduledTasksSettings.invalidInterval": "Некорректный интервал",
    "settingsD.scheduledTasksSettings.intervalTooShort": "Введите интервал не меньше одной минуты.",
    "settingsD.scheduledTasksSettings.onceUnavailable": "Однократный запуск здесь недоступен",
    "settingsD.scheduledTasksSettings.onceUnavailableDescription":
      "Это окружение работает на старой версии Gustaf. Обновите его, чтобы запланировать однократную задачу, или выберите другое расписание.",
    "settingsD.scheduledTasksSettings.checkoutRequired": "Нужен путь к рабочей копии",
    "settingsD.scheduledTasksSettings.checkoutRequiredDescription":
      "Введите путь к рабочей копии, в которой будет запускаться задача.",
    "settingsD.scheduledTasksSettings.couldNotSave": "Не удалось сохранить запланированную задачу",
    "settingsD.scheduledTasksSettings.editTask": "Изменить задачу",
    "settingsD.scheduledTasksSettings.formDescription":
      "Запускайте промпт автоматически с интервалом, в заданное время, однократно на указанную дату или при вызове webhook.",
    "settingsD.scheduledTasksSettings.reconnectBeforeSaving":
      "Переподключите это окружение перед сохранением.",
    "settingsD.scheduledTasksSettings.runsOn": "Запускается на",
    "settingsD.scheduledTasksSettings.unavailableEnvironment": "Окружение недоступно",
    "settingsD.scheduledTasksSettings.taskNoLongerExists":
      "Эта запланированная задача больше не существует.",
    "settingsD.scheduledTasksSettings.name": "Название",
    "settingsD.scheduledTasksSettings.namePlaceholder": "Например: проверить новые ошибки в Sentry",
    "settingsD.scheduledTasksSettings.project": "Проект",
    "settingsD.scheduledTasksSettings.selectProject": "Выберите проект",
    "settingsD.scheduledTasksSettings.workspace": "Рабочая область",
    "settingsD.scheduledTasksSettings.baseBranch": "Базовая ветка",
    "settingsD.scheduledTasksSettings.checkoutPath": "Путь к рабочей копии",
    "settingsD.scheduledTasksSettings.prompt": "Промпт",
    "settingsD.scheduledTasksSettings.promptPlaceholder":
      "Что агент должен делать при каждом запуске?",
    "settingsD.scheduledTasksSettings.model": "Модель",
    "settingsD.scheduledTasksSettings.legacyInterval":
      "Эта задача использует устаревший интервал меньше минуты. При сохранении интервал станет не меньше минуты.",
    "settingsD.scheduledTasksSettings.schedule": "Расписание",
    "settingsD.scheduledTasksSettings.scheduleType": "Тип расписания",
    "settingsD.scheduledTasksSettings.atATime": "В указанное время",
    "settingsD.scheduledTasksSettings.once": "Однократно",
    "settingsD.scheduledTasksSettings.everyInterval": "По интервалу",
    "settingsD.scheduledTasksSettings.onWebhook": "По webhook",
    "settingsD.scheduledTasksSettings.webhookDenialSwitch":
      "{denial} Переключите задачу на время или интервал либо выключите её, чтобы сохранить.",
    "settingsD.scheduledTasksSettings.webhookPromptHint":
      "Каждый запрос запускает промпт. Используйте в промпте {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} или {{request}}; агент получит только то, что указано.",
    "settingsD.scheduledTasksSettings.skipOlder": "Пропускать запросы старше",
    "settingsD.scheduledTasksSettings.minutesOptional": "минут, необязательно",
    "settingsD.scheduledTasksSettings.runEveryRequest": "Запускать на каждый запрос",
    "settingsD.scheduledTasksSettings.duplicateKey": "Ключ повторных запросов",
    "settingsD.scheduledTasksSettings.templateOptional": "шаблон, необязательно",
    "settingsD.scheduledTasksSettings.sameKeyOnce":
      "Запросы с одинаковым ключом выполняются только один раз в течение 7 дней.",
    "settingsD.scheduledTasksSettings.coalesceKey": "Ключ объединения",
    "settingsD.scheduledTasksSettings.coalesceWindow": "Окно объединения",
    "settingsD.scheduledTasksSettings.coalesceWindowHint": "секунд, 10–3600",
    "settingsD.scheduledTasksSettings.coalesceHint":
      "Объединение запускает последний payload один раз, когда закрывается окно, начатое с первой доставки. Пустые ключи выполняются обычным образом.",
    "settingsD.scheduledTasksSettings.requireSignature": "Требовать подпись",
    "settingsD.scheduledTasksSettings.rejectUnsigned":
      "Отклонять запросы без действительной подписи тела HMAC-SHA256.",
    "settingsD.scheduledTasksSettings.header": "Заголовок",
    "settingsD.scheduledTasksSettings.prefix": "Префикс",
    "settingsD.scheduledTasksSettings.encoding": "Кодировка",
    "settingsD.scheduledTasksSettings.secret": "Секрет",
    "settingsD.scheduledTasksSettings.none": "Нет",
    "settingsD.scheduledTasksSettings.unchanged": "Без изменений",
    "settingsD.scheduledTasksSettings.sharedSecret": "Общий секрет",
    "settingsD.scheduledTasksSettings.runOnDate": "Запустить в",
    "settingsD.scheduledTasksSettings.runAt": "Запускать в",
    "settingsD.scheduledTasksSettings.onDays": "по",
    "settingsD.scheduledTasksSettings.daysToRun": "Дни запуска",
    "settingsD.scheduledTasksSettings.runEvery": "Запускать каждые",
    "settingsD.scheduledTasksSettings.minutes": "минут",
    "settingsD.scheduledTasksSettings.enabled": "Включено",
    "settingsD.scheduledTasksSettings.disabledTasks":
      "Выключенные задачи сохраняются, но не запускаются.",
    "settingsD.scheduledTasksSettings.cancel": "Отмена",
    "settingsD.scheduledTasksSettings.saveTask": "Сохранить задачу",
    "settingsD.scheduledTasksSettings.createTask": "Создать задачу",
    "settingsD.scheduledTasksSettings.weekdayShortSun": "Вс",
    "settingsD.scheduledTasksSettings.weekdayShortMon": "Пн",
    "settingsD.scheduledTasksSettings.weekdayShortTue": "Вт",
    "settingsD.scheduledTasksSettings.weekdayShortWed": "Ср",
    "settingsD.scheduledTasksSettings.weekdayShortThu": "Чт",
    "settingsD.scheduledTasksSettings.weekdayShortFri": "Пт",
    "settingsD.scheduledTasksSettings.weekdayShortSat": "Сб",
    "settingsD.scheduledTasksSettings.weekdayLongSun": "Воскресенье",
    "settingsD.scheduledTasksSettings.weekdayLongMon": "Понедельник",
    "settingsD.scheduledTasksSettings.weekdayLongTue": "Вторник",
    "settingsD.scheduledTasksSettings.weekdayLongWed": "Среда",
    "settingsD.scheduledTasksSettings.weekdayLongThu": "Четверг",
    "settingsD.scheduledTasksSettings.weekdayLongFri": "Пятница",
    "settingsD.scheduledTasksSettings.weekdayLongSat": "Суббота",
    "settingsD.storageSettings.worktreesLocationDescription":
      "Папка, где создаются новые worktree, на любом диске, например D:\\worktrees или ~/worktrees. Существующие worktree остаются на месте. Оставьте поле пустым, чтобы использовать домашнюю папку T3.",
    "settingsD.storageSettings.worktreeLocation": "Расположение worktree",
    "settingsD.storageSettings.mixed": "Разные",
    "settingsD.storageSettings.default": "По умолчанию",
    "settingsD.storageSettings.off": "Выкл.",
    "settingsD.storageSettings.decreaseRetention": "Уменьшить: {label}",
    "settingsD.storageSettings.increaseRetention": "Увеличить: {label}",
    "settingsD.storageSettings.retentionInDays": "{label}, в днях",
    "settingsD.storageSettings.days": "дн.",
    "settingsD.storageSettings.keepAnyLocalFiles": "Любые локальные файлы",
    "settingsD.storageSettings.keepUncommitted": "Незакоммиченные изменения",
    "settingsD.storageSettings.keepTracked": "Изменённые отслеживаемые файлы",
    "settingsD.storageSettings.worktrees": "Worktrees",
    "settingsD.storageSettings.rotatedLogs": "Ротированные логи",
    "settingsD.storageSettings.browserArtifacts": "Артефакты браузера",
    "settingsD.storageSettings.machine": "Машина",
    "settingsD.storageSettings.project": "Проект",
    "settingsD.storageSettings.folder": "Папка",
    "settingsD.storageSettings.thread": "Тред",
    "settingsD.storageSettings.nothingNeededCleanup": "{label}: очистка не требуется.",
    "settingsD.storageSettings.cleanup": "Очистка",
    "settingsD.storageSettings.lastRun": "Последний запуск",
    "settingsD.storageSettings.turnOnRule": "Включите правило очистки, чтобы использовать это.",
    "settingsD.storageSettings.deleting": "Удаление…",
    "settingsD.storageSettings.deleteNow": "Удалить сейчас",
    "settingsD.storageSettings.couldNotLoadLastRun": "Не удалось загрузить последний запуск.",
    "settingsD.storageSettings.loadingLastRun": "Загрузка последнего запуска…",
    "settingsD.storageSettings.cleanupNotRun": "Очистка ещё не запускалась.",
    "settingsD.storageSettings.cleanupFailedOn": "Очистка не удалась на {label}",
    "settingsD.storageSettings.couldNotRunCleanup": "Не удалось запустить очистку на {label}",
    "settingsD.storageSettings.countsSummary": "удалено: {removed}, сохранено: {kept}",
    "settingsD.storageSettings.countsFailed": ", ошибок: {failed}",
    "settingsD.storageSettings.updateCleanupScope":
      "Обновите выбранные окружения, чтобы использовать очистку хранилища, или выберите машину, которая её поддерживает.",
    "settingsD.storageSettings.updateMachines":
      "Обновите выбранные машины, чтобы настроить очистку worktree проекта.",
    "settingsD.storageSettings.mixedAcrossMachines": "Разные значения на выбранных машинах",
    "settingsD.storageSettings.automaticWorktreeCleanup": "Автоматическая очистка worktree",
    "settingsD.storageSettings.keepProjectWorktrees":
      "Сохранять worktree этого проекта, пока вы не удалите их вручную.",
    "settingsD.storageSettings.useProjectRules": "Использовать эти правила для этого проекта.",
    "settingsD.storageSettings.useMachineSettings":
      "Использовать настройки очистки worktree каждой машины.",
    "settingsD.storageSettings.inherit": "Наследовать",
    "settingsD.storageSettings.custom": "Свои",
    "settingsD.storageSettings.deleteWorktreesDeletedThreads": "Удалять worktree удалённых тредов",
    "settingsD.storageSettings.deleteWorktreesDeletedThreadsDescription":
      "Удалять неиспользуемые worktree при удалении активных или архивных тредов. Worktree с локальными изменениями сохраняются.",
    "settingsD.storageSettings.deleteMergedWorktrees": "Удалять слитые worktree",
    "settingsD.storageSettings.deleteMergedWorktreesDescription":
      "Удалять worktree, пул-реквест которых слит, а коммиты входят в ветку по умолчанию.",
    "settingsD.storageSettings.deleteInactiveWorktrees": "Удалять неактивные worktree",
    "settingsD.storageSettings.deleteInactiveWorktreesDescription":
      "Удалять worktree, если их треды неактивны столько дней. Ветки и история тредов сохраняются.",
    "settingsD.storageSettings.deleteSettledWorktrees": "Удалять завершённые worktree",
    "settingsD.storageSettings.offlineMachinesNoSetting": "Офлайн-машины не получат эту настройку",
    "settingsD.storageSettings.deleteSettledWorktreesDescription":
      "Удалять worktree через столько дней после завершения их треда. При 0 днях они удаляются при следующей очистке. Ветки и история тредов сохраняются.",
    "settingsD.storageSettings.deleteUnchangedWorktrees": "Удалять неизменённые worktree",
    "settingsD.storageSettings.deleteUnchangedWorktreesDescription":
      "Удалять worktree без коммитов сверх ветки по умолчанию.",
    "settingsD.storageSettings.keepWhenIncludesIgnored":
      "Включает игнорируемые файлы, кроме node_modules.",
    "settingsD.storageSettings.keepWhenTracked":
      "Удаляет неотслеживаемые и игнорируемые файлы, включая .env.",
    "settingsD.storageSettings.keepWhenDefault":
      "Сохраняет правки и неотслеживаемые файлы. Удаляет игнорируемые файлы, включая .env.",
    "settingsD.storageSettings.keepWorktreesLocalChanges":
      "Сохранять worktree с локальными изменениями",
    "settingsD.storageSettings.artifactsAndLogs": "Артефакты и логи",
    "settingsD.storageSettings.deleteOldBrowserArtifacts": "Удалять старые артефакты браузера",
    "settingsD.storageSettings.deleteOldBrowserArtifactsDescription":
      "Удалять сохранённые снимки браузера через столько дней. Ссылки на старые снимки перестанут открываться.",
    "settingsD.storageSettings.deleteOldRotatedLogs": "Удалять старые ротированные логи",
    "settingsD.storageSettings.deleteOldRotatedLogsDescription":
      "Удалять неактивные ротированные файлы логов через столько дней. Текущие логи сохраняются.",
    "settingsD.savedEnvironmentRows.statusOff": "Выкл.",
    "settingsD.savedEnvironmentRows.connected": "Подключено",
    "settingsD.savedEnvironmentRows.connecting": "Подключение",
    "settingsD.savedEnvironmentRows.reconnecting": "Переподключение",
    "settingsD.savedEnvironmentRows.reconnectingWithError": "Переподключение: {error}",
    "settingsD.savedEnvironmentRows.clientNotSupported": "Клиент не поддерживается",
    "settingsD.savedEnvironmentRows.connectionFailed": "Ошибка подключения",
    "settingsD.savedEnvironmentRows.connectionFailedWithError": "Ошибка подключения: {error}",
    "settingsD.savedEnvironmentRows.offline": "Офлайн",
    "settingsD.savedEnvironmentRows.notConnected": "Не подключено",
    "settingsD.savedEnvironmentRows.traceIdCopied": "Trace ID скопирован",
    "settingsD.savedEnvironmentRows.couldNotCopyTraceId": "Не удалось скопировать trace ID",
    "settingsD.savedEnvironmentRows.mcpUrlCopied": "MCP URL скопирован",
    "settingsD.savedEnvironmentRows.mcpUrlHint":
      "Добавьте его в агент, например: claude mcp add --transport http t3 {url}",
    "settingsD.savedEnvironmentRows.couldNotCopyMcpUrl": "Не удалось скопировать MCP URL",
    "settingsD.savedEnvironmentRows.restarting": "Перезапуск",
    "settingsD.savedEnvironmentRows.switchedOff": "Выключено",
    "settingsD.savedEnvironmentRows.updateAvailable": "\nДоступно обновление: {server} → {client}",
    "settingsD.savedEnvironmentRows.permissions": "Разрешения",
    "settingsD.savedEnvironmentRows.hideRoutes": "Скрыть маршруты",
    "settingsD.savedEnvironmentRows.routes": "Маршруты",
    "settingsD.savedEnvironmentRows.copyMcpUrl": "Копировать MCP URL",
    "settingsD.savedEnvironmentRows.copyTraceId": "Копировать trace ID",
    "settingsD.savedEnvironmentRows.removing": "Удаление…",
    "settingsD.savedEnvironmentRows.removeFromDevice": "Удалить с этого устройства…",
    "settingsD.savedEnvironmentRows.retryUpdate": "Повторить обновление",
    "settingsD.savedEnvironmentRows.update": "Обновить",
    "settingsD.savedEnvironmentRows.switchOff": "Выключить",
    "settingsD.savedEnvironmentRows.switchOn": "Включить",
    "settingsD.savedEnvironmentRows.switchOffFor": "Выключить {label}",
    "settingsD.savedEnvironmentRows.switchOnFor": "Включить {label}",
    "settingsD.savedEnvironmentRows.moreActionsFor": "Другие действия для {label}",
    "settingsD.savedEnvironmentRows.serverLabel": "Сервер {label}",
    "settingsD.savedEnvironmentRows.getMoreTunnels": "Получить больше туннелей",
    "settingsD.savedEnvironmentRows.noConnectPermission":
      "У вашей сессии нет разрешения управлять доступом к T3 Connect.",
    "settingsD.savedEnvironmentRows.signIn": "Войти",
    "settingsD.savedEnvironmentRows.fix": "Исправить: {fix}",
    "settingsD.savedEnvironmentRows.moreInfo": "Подробнее",
    "settingsD.savedEnvironmentRows.t3ConnectLinked": "T3 Connect подключён",
    "settingsD.savedEnvironmentRows.t3ConnectTunnelDisabled": "Туннель T3 Connect отключён",
    "settingsD.savedEnvironmentRows.t3ConnectUnlinked": "T3 Connect отвязан",
    "settingsD.savedEnvironmentRows.linkedDescription": "Это окружение доступно через T3 Connect.",
    "settingsD.savedEnvironmentRows.tunnelRemovedDescription":
      "Управляемый туннель удалён. Публикация активности агента остаётся включённой.",
    "settingsD.savedEnvironmentRows.unlinkedDescription":
      "Это окружение больше не доступно через T3 Connect.",
    "settingsD.savedEnvironmentRows.agentActivityEnabled": "Активность агента включена",
    "settingsD.savedEnvironmentRows.agentActivityDisabled": "Активность агента выключена",
    "settingsD.savedEnvironmentRows.publishingDescription":
      "Это окружение публикует активность агента в ваших мобильных клиентах.",
    "settingsD.savedEnvironmentRows.stopPublishingDescription":
      "Это окружение перестанет публиковать активность агента.",
    "settingsD.savedEnvironmentRows.webhooksHeld": "Webhook-запросы удерживаются, пока офлайн",
    "settingsD.savedEnvironmentRows.webhooksNoLongerHeld": "Webhook-запросы больше не удерживаются",
    "settingsD.savedEnvironmentRows.webhooksHeldDescription":
      "T3 Connect хранит webhook-запросы до 24 часов, пока это окружение офлайн.",
    "settingsD.savedEnvironmentRows.webhooksNotHeldDescription":
      "Запросы к офлайн-окружению теперь завершаются ошибкой. Всё, что уже удерживалось, всё равно доставляется.",
    "settingsD.savedEnvironmentRows.signInToMakeAvailable":
      "Войдите, чтобы сделать это окружение доступным на других ваших устройствах через T3 Connect.",
    "settingsD.savedEnvironmentRows.removedFromConnect":
      "Это окружение удалено из T3 Connect. Включите, чтобы привязать его снова.",
    "settingsD.savedEnvironmentRows.reachabilityUnreachable":
      "T3 Connect включён, но другие устройства не могут подключиться к этому окружению.",
    "settingsD.savedEnvironmentRows.reachableDescription":
      "Это окружение доступно на других ваших устройствах через T3 Connect.",
    "settingsD.savedEnvironmentRows.reachabilityNotChecked":
      "T3 Connect включён. Доступность ещё не проверялась.",
    "settingsD.savedEnvironmentRows.outOfSyncDescription":
      "T3 Connect не синхронизирован. Окружение привязано только для публикации активности агента, поэтому другие устройства не могут подключиться. Включите T3 Connect, чтобы исправить это.",
    "settingsD.savedEnvironmentRows.makeAvailableDescription":
      "Сделайте это окружение доступным на других ваших устройствах через T3 Connect.",
    "settingsD.savedEnvironmentRows.publishSignInDescription":
      "Войдите, чтобы отправлять активность в мобильные уведомления и Live Activities.",
    "settingsD.savedEnvironmentRows.publishDescription":
      "Отправляйте активность в мобильные уведомления и Live Activities без T3 Connect.",
    "settingsD.savedEnvironmentRows.removedRunLinkCommand":
      "Это окружение удалено из T3 Connect. Выполните `t3 connect link` на хосте, чтобы привязать его снова.",
    "settingsD.savedEnvironmentRows.publishAriaLabel":
      "Публиковать активность агента в мобильных клиентах",
    "settingsD.savedEnvironmentRows.holdAriaLabel":
      "Удерживать webhook-запросы, пока это окружение офлайн",
    "settingsD.savedEnvironmentRows.holdDescription":
      "Хранить webhook-запросы до 24 часов, пока окружение офлайн, а затем доставлять их. Выкл.: T3 Connect только пересылает запросы и ничего не сохраняет.",
    "settingsD.savedEnvironmentRows.editPermissionsDescription":
      "Чтобы изменить эти настройки, свяжите подключение с разрешениями «Просмотр relay» и «Управление relay».",
    "settingsD.savedEnvironmentRows.enableT3Connect": "Включить T3 Connect",
    "settingsD.savedEnvironmentRows.noRemoteEnvironments": "Нет сохранённых удалённых окружений",
    "settingsD.savedEnvironmentRows.addEnvironmentCloud":
      "Нажмите «Добавить окружение», чтобы связать другое окружение, или подключите одно из T3 Connect.",
    "settingsD.savedEnvironmentRows.addEnvironment":
      "Нажмите «Добавить окружение», чтобы связать другое окружение.",
    "settingsD.snapShotSetupDialog.stepAccess": "Доступ",
    "settingsD.snapShotSetupDialog.stepShortcut": "Сочетание клавиш",
    "settingsD.snapShotSetupDialog.gnomeNotInstalledTitle": "Установите расширение",
    "settingsD.snapShotSetupDialog.gnomeNotInstalledDescription":
      "Расширение Gustaf для GNOME позволяет захватывать другие окна и добавлять их в черновик. После установки выйдите из системы один раз.",
    "settingsD.snapShotSetupDialog.gnomeRestartTitle": "Расширение установлено",
    "settingsD.snapShotSetupDialog.gnomeRestartDescription":
      "Сохраните работу, затем выйдите из системы и войдите снова. Ваши настройки будут ждать здесь.",
    "settingsD.snapShotSetupDialog.gnomeUpdateTitle": "Обновите расширение",
    "settingsD.snapShotSetupDialog.gnomeUpdateDescription":
      "Установите обновление, затем выйдите из системы и войдите снова.",
    "settingsD.snapShotSetupDialog.gnomeExtensionsDisabledTitle": "Разрешите расширения GNOME",
    "settingsD.snapShotSetupDialog.gnomeExtensionsDisabledDescription":
      "Откройте GNOME Extensions, включите расширения и проверьте снова.",
    "settingsD.snapShotSetupDialog.gnomeDisabledTitle": "Включите расширение",
    "settingsD.snapShotSetupDialog.gnomeDisabledDescription":
      "Включите Gustaf SnapShots, чтобы начать захват окон.",
    "settingsD.snapShotSetupDialog.readyTitle": "Захват готов",
    "settingsD.snapShotSetupDialog.readyDescription": "Далее выберите сочетание клавиш.",
    "settingsD.snapShotSetupDialog.unsupportedTitle": "Автоматический захват недоступен",
    "settingsD.snapShotSetupDialog.unsupportedDescription":
      "Используйте «Сделать снимок» в палитре команд, чтобы выбрать окно.",
    "settingsD.snapShotSetupDialog.gnomeErrorTitle": "Не удалось настроить расширение",
    "settingsD.snapShotSetupDialog.gnomeErrorDescription":
      "Проверьте Gustaf SnapShots в GNOME Extensions и попробуйте снова.",
    "settingsD.snapShotSetupDialog.tryAgainTitle": "Попробуем ещё раз",
    "settingsD.snapShotSetupDialog.tryAgainDescription":
      "Не удалось проверить снимки. Попробуйте снова, чтобы продолжить.",
    "settingsD.snapShotSetupDialog.checkAccessTitle": "Проверьте доступ к захвату",
    "settingsD.snapShotSetupDialog.checkAccessDescription":
      "Расширение ещё не готово. Попробуйте через минуту.",
    "settingsD.snapShotSetupDialog.fixAccessTitle": "Исправим доступ к захвату",
    "settingsD.snapShotSetupDialog.fixAccessDescription":
      "Попробуйте переустановить помощник захвата и проверьте снова.",
    "settingsD.snapShotSetupDialog.updateHelperTitle": "Обновите помощник захвата",
    "settingsD.snapShotSetupDialog.allowSnapshotsTitle": "Разрешите снимки",
    "settingsD.snapShotSetupDialog.helperDescription":
      "Помощник захвата Gustaf позволяет снимать другие приложения и возвращаться к черновику. Он входит в состав Gustaf.",
    "settingsD.snapShotSetupDialog.pickerTitle": "Выбирайте окно каждый раз",
    "settingsD.snapShotSetupDialog.pickerDescription":
      "Ваш рабочий стол не поддерживает автоматический захват. Вместо этого вы будете выбирать окно для захвата.",
    "settingsD.snapShotSetupDialog.portalDescription":
      "Рабочий стол может запросить разрешение при первом захвате.",
    "settingsD.snapShotSetupDialog.macReadyDescription":
      "Сделайте тестовый снимок текущего окна. Если macOS попросит обойти выбор окна, выберите «Разрешить». Тестовое изображение будет удалено.",
    "settingsD.snapShotSetupDialog.macAllowEachDescription": "Разрешите каждое право и продолжите.",
    "settingsD.snapShotSetupDialog.allowWhenPromptedDescription":
      "Разрешите доступ, когда система запросит его, чтобы начать захват окон.",
    "settingsD.snapShotSetupDialog.chooseShortcutTitle": "Выберите сочетание клавиш",
    "settingsD.snapShotSetupDialog.clickShortcutDescription":
      "Нажмите на сочетание клавиш, затем нажмите нужные клавиши.",
    "settingsD.snapShotSetupDialog.chooseKeysDescription":
      "Выберите клавиши и подтвердите запрос разрешения, если он появится.",
    "settingsD.snapShotSetupDialog.shiftKeysDescription":
      "Используйте обе клавиши Shift или запишите другое сочетание.",
    "settingsD.snapShotSetupDialog.setupTitle": "Настройка снимков",
    "settingsD.snapShotSetupDialog.setupDesktopTitle": "Настройка снимков для {desktop}",
    "settingsD.snapShotSetupDialog.screenRecording": "Запись экрана",
    "settingsD.snapShotSetupDialog.screenRecordingDescription":
      "Захват окна, которое вы используете.",
    "settingsD.snapShotSetupDialog.accessibility": "Универсальный доступ",
    "settingsD.snapShotSetupDialog.accessibilityDescription":
      "Включать текст и элементы управления из захваченного приложения.",
    "settingsD.snapShotSetupDialog.accessibilityOptionalDescription":
      "Необязательно. Включать текст и элементы управления из захваченного приложения.",
    "settingsD.snapShotSetupDialog.reinstallHelper": "Переустановить помощник",
    "settingsD.snapShotSetupDialog.shortcutPermissions": "Разрешения для сочетания клавиш",
    "settingsD.snapShotSetupDialog.tryAgain": "Повторить",
    "settingsD.snapShotSetupDialog.needsAttention":
      "Захват требует внимания. Вернитесь, чтобы проверить доступ.",
    "settingsD.snapShotSetupDialog.couldNotFinish":
      "Не удалось завершить этот шаг. Попробуйте снова или посмотрите помощь в разделе «Дополнительно».",
    "settingsD.snapShotSetupDialog.advanced": "Дополнительно",
    "settingsD.snapShotSetupDialog.includedNoDownload":
      "Входит в состав Gustaf. Загрузка не нужна.",
    "settingsD.snapShotSetupDialog.disableExtension": "Отключить расширение",
    "settingsD.snapShotSetupDialog.removeCaptureHelper": "Удалить помощник захвата",
    "settingsD.snapShotSetupDialog.back": "Назад",
    "settingsD.snapShotSetupDialog.close": "Закрыть",
    "settingsD.snapShotSetupDialog.finishLater": "Завершить позже",
    "settingsD.snapShotSetupDialog.checking": "Проверка…",
    "settingsD.snapShotSetupDialog.installing": "Установка…",
    "settingsD.snapShotSetupDialog.checkAgain": "Проверить снова",
    "settingsD.snapShotSetupDialog.updateHelper": "Обновить помощник",
    "settingsD.snapShotSetupDialog.installHelper": "Установить помощник",
    "settingsD.snapShotSetupDialog.updateExtension": "Обновить расширение",
    "settingsD.snapShotSetupDialog.installExtension": "Установить расширение",
    "settingsD.snapShotSetupDialog.enableExtension": "Включить расширение",
    "settingsD.snapShotSetupDialog.enabling": "Включение…",
    "settingsD.snapShotSetupDialog.working": "Работа…",
    "settingsD.snapShotSetupDialog.testCaptureContinue": "Проверить захват и продолжить",
    "settingsD.snapShotSetupDialog.allowCapture": "Разрешить захват",
    "settingsD.snapShotSetupDialog.continue": "Продолжить",
    "settingsD.snapShotSetupDialog.saving": "Сохранение…",
    "settingsD.snapShotSetupDialog.saveAndFinish": "Сохранить и завершить",
    "settingsD.snapShotSetupDialog.done": "Готово",
    "settingsD.snapShotSettings.couldNotCheckCaptureSetup":
      "Не удалось проверить настройку захвата",
    "settingsD.snapShotSettings.couldNotOpenShortcutPermissions":
      "Не удалось открыть разрешения для сочетания клавиш",
    "settingsD.snapShotSettings.couldNotCompleteCaptureSetup":
      "Не удалось завершить настройку захвата",
    "settingsD.snapShotSettings.couldNotSaveCaptureSettings":
      "Не удалось сохранить настройки захвата",
    "settingsD.snapShotSettings.couldNotAllowAppText":
      "Не удалось разрешить захват текста приложений",
    "settingsD.snapShotSettings.couldNotCheckShortcut":
      "Не удалось проверить это сочетание клавиш.",
    "settingsD.snapShotSettings.couldNotVerifyAccess": "Не удалось проверить доступ к захвату",
    "settingsD.snapShotSettings.couldNotCloseSetup": "Не удалось закрыть настройку захвата",
    "settingsD.snapShotSettings.pressShortcut": "Нажмите сочетание клавиш. Esc отменяет.",
    "settingsD.snapShotSettings.alreadyUses":
      "Gustaf уже использует это сочетание для «{command}».",
    "settingsD.snapShotSettings.checkingShortcut": "Проверка сочетания клавиш…",
    "settingsD.snapShotSettings.readyToSave": "Готово к сохранению.",
    "settingsD.snapShotSettings.tryShortcutExample": "Попробуйте сочетание, например Ctrl+Shift+2.",
    "settingsD.snapShotSettings.updatingSettings": "Обновление настроек захвата…",
    "settingsD.snapShotSettings.enableSnapshots": "Включить снимки",
    "settingsD.snapShotSettings.accessibilityDescription":
      "Включать текст и элементы управления, когда приложение их предоставляет.",
    "settingsD.snapShotSettings.includeAppText": "Включать текст приложения в снимки",
    "settingsD.snapShotSettings.pickerShortcutDescription":
      "Выберите окно для захвата из любого приложения.",
    "settingsD.snapShotSettings.shortcutDescription":
      "Захватывать окно, которое вы используете, без переключения приложений.",
    "settingsD.snapShotSettings.changeShortcut": "Изменить сочетание клавиш",
    "settingsD.snapShotSettings.saving": "Сохранение…",
    "settingsD.snapShotSettings.save": "Сохранить",
    "settingsD.snapShotSettings.cancel": "Отмена",
    "settingsD.snapShotSettings.shortcutPermissions": "Разрешения для сочетания клавиш",
    "settingsD.snapShotSettings.soundDescription":
      "Выберите звук, который воспроизводится при начале захвата.",
    "settingsD.snapShotSettings.soundAria": "Звук снимка: {sound}",
    "settingsD.snapShotSettings.soundOff": "Выкл.",
    "settingsD.snapShotSettings.soundWhooshDefault": "Whoosh (по умолчанию)",
    "settingsD.snapShotSettings.soundClick": "Щелчок",
    "settingsD.snapShotSettings.playWhoosh": "Воспроизвести Whoosh",
    "settingsD.snapShotSettings.playClick": "Воспроизвести «Щелчок»",
    "settingsD.snapShotSettings.flashDescription": "Показывать мягкий сигнал в захваченном окне.",
    "settingsD.snapShotSettings.flashAria": "Подсвечивать захваченное окно",
    "settingsD.snapShotSettings.animationsDescription":
      "Анимировать захваченные окна при переносе в черновик.",
    "settingsD.snapShotSettings.animationsAria": "Анимировать снимки",
    "settingsD.settingsScopeSentence.noMatches": "Ничего не найдено.",
    "settingsD.settingsScopeSentence.environmentScope": "Окружение",
    "settingsD.settingsScopeSentence.unavailableEnvironment": "Окружение недоступно",
    "settingsD.settingsScopeSentence.noEnvironments": "Нет окружений",
    "settingsD.settingsScopeSentence.allEnvironments": "Все окружения",
    "settingsD.settingsScopeSentence.searchEnvironments": "Поиск окружений",
    "settingsD.settingsScopeSentence.projectScope": "Проект",
    "settingsD.settingsScopeSentence.unavailableProject": "Проект недоступен",
    "settingsD.settingsScopeSentence.allProjects": "Все проекты",
    "settingsD.settingsScopeSentence.searchProjects": "Поиск проектов",
    "settingsD.settingsScopeSentence.archived": "В архиве",
    "settingsD.simlockDeviceHostEditor.invalidSecretReference":
      "Введите корректную ссылку на секрет.",
    "settingsD.simlockDeviceHostEditor.addHost": "Добавить хост Simlock",
    "settingsD.simlockDeviceHostEditor.editHost": "Изменить хост Simlock",
    "settingsD.simlockDeviceHostEditor.multiEnvironmentDescription":
      "Сервер каждого выбранного окружения арендует устройства у вашего шлюза Simlock со своим агентским токеном и освобождает их при закрытии.",
    "settingsD.simlockDeviceHostEditor.singleEnvironmentDescription":
      "Сервер окружения арендует устройства у вашего шлюза Simlock и освобождает их при закрытии.",
    "settingsD.simlockDeviceHostEditor.name": "Название",
    "settingsD.simlockDeviceHostEditor.gatewayUrl": "URL шлюза",
    "settingsD.simlockDeviceHostEditor.agentTokenFor": "Агентский токен · {label}",
    "settingsD.simlockDeviceHostEditor.agentToken": "Агентский токен",
    "settingsD.simlockDeviceHostEditor.devicesAtOnce": "Устройств одновременно",
    "settingsD.simlockDeviceHostEditor.leaseMinutes": "Минуты аренды",
    "settingsD.simlockDeviceHostEditor.leaseEndsNote":
      "Аренда заканчивается по истечении минут аренды, даже если устройство используется.",
    "settingsD.simlockDeviceHostEditor.savingRestarts":
      " Сохранение перезапустит этот хост, и он освободит свои устройства.",
    "settingsD.simlockDeviceHostEditor.cancel": "Отмена",
    "settingsD.simlockDeviceHostEditor.saveHost": "Сохранить хост",
    "settingsD.simlockDeviceHostEditor.checking": "Проверка…",
    "settingsD.simlockDeviceHostEditor.usingDeviceToken":
      "Используется агентский токен устройства этой машины ({signedInAs}).",
    "settingsD.simlockDeviceHostEditor.acceptedAs": "Принято как {signedInAs}.",
    "settingsD.simlockDeviceHostEditor.clearAgentToken": "Очистить агентский токен",
    "settingsD.snoozePresetsSettings.description":
      "Варианты в каждом меню отсрочки, от ближайшего к дальнему. Дни недели означают ближайший после сегодняшнего.",
    "settingsD.snoozePresetsSettings.whenAfter": "Через",
    "settingsD.snoozePresetsSettings.whenToday": "Сегодня",
    "settingsD.snoozePresetsSettings.whenTomorrow": "Завтра",
    "settingsD.snoozePresetsSettings.whenMonday": "Понедельник",
    "settingsD.snoozePresetsSettings.whenTuesday": "Вторник",
    "settingsD.snoozePresetsSettings.whenWednesday": "Среда",
    "settingsD.snoozePresetsSettings.whenThursday": "Четверг",
    "settingsD.snoozePresetsSettings.whenFriday": "Пятница",
    "settingsD.snoozePresetsSettings.whenSaturday": "Суббота",
    "settingsD.snoozePresetsSettings.whenSunday": "Воскресенье",
    "settingsD.snoozePresetsSettings.passedToday": "На сегодня уже прошло",
    "settingsD.snoozePresetsSettings.duplicateOption": "Дубликат варианта выше",
    "settingsD.snoozePresetsSettings.sameTimeOption": "То же время, что у варианта выше",
    "settingsD.snoozePresetsSettings.optionAria": "Вариант отсрочки {index}",
    "settingsD.snoozePresetsSettings.removeOptionAria": "Удалить вариант отсрочки {index}",
    "settingsD.snoozePresetsSettings.menusOnlyCustom": "В меню только «Свой вариант»…",
    "settingsD.snoozePresetsSettings.menuNow": "Сейчас в меню: {options}",
    "settingsD.snoozePresetsSettings.addOption": "Добавить вариант",
    "settingsD.snoozePresetsSettings.upToOptions": "Не больше {max} вариантов",
    "settingsD.snoozePresetsSettings.time": "Время",
    "settingsD.snoozePresetsSettings.decrease": "Уменьшить",
    "settingsD.snoozePresetsSettings.amount": "Количество",
    "settingsD.snoozePresetsSettings.increase": "Увеличить",
    "settingsD.snoozePresetsSettings.when": "Когда",
    "settingsD.snoozePresetsSettings.unit": "Единица",
    "settingsD.snoozePresetsSettings.atTime": "в",
    "settingsD.snoozePresetsSettings.unitMinutes": "минут",
    "settingsD.snoozePresetsSettings.unitHours": "часов",
    "settingsD.snoozePresetsSettings.unitDays": "дней",
    "settingsD.snoozePresetsSettings.unitMinute": "минута",
    "settingsD.snoozePresetsSettings.unitHour": "час",
    "settingsD.snoozePresetsSettings.unitDay": "день",
    "settingsD.settingsScopeSentence.applyingFor": "Настройки применяются для",
    "settingsD.settingsScopeSentence.on": "на",
    "settingsD.settingsScopeSentence.across": "на всех",
    "settingsD.settingsScopeSentence.offline": "Не в сети",
    "settingsD.typographySettings.systemDefault": "Как в системе",
    "settingsD.typographySettings.systemMonospace": "Системный моноширинный",
    "settingsD.typographySettings.interfaceFontSize": "Размер шрифта интерфейса",
    "settingsD.typographySettings.promptFontSize": "Размер шрифта промпта",
    "settingsD.typographySettings.codeFontSize": "Размер шрифта кода",
    "settingsD.typographySettings.terminalFontSize": "Размер шрифта терминала",
    "settingsD.typographySettings.wrapCodeAria":
      "По умолчанию переносить код, диффы и предпросмотры файлов",
    "settingsD.typographySettings.separateFontsAria": "Раздельные шрифты",
    "settingsD.typographySettings.resetFontSmoothing": "сглаживание шрифта",
    "settingsD.typographySettings.resetWordWrap": "перенос строк",
    "settingsD.sourceControlAccountSettings.hiddenAccount": "Скрытый аккаунт",
    "settingsD.sourceControlAccountSettings.signedInAs": "Вход выполнен как",
    "settingsD.sourceControlAccountSettings.account": "Аккаунт",
    "settingsD.sourceControlAccountSettings.activeAccount": "Активный аккаунт {cli}",
    "settingsD.sourceControlAccountSettings.accountNumber": "Аккаунт {index}",
    "settingsD.sourceControlAccountSettings.useActiveLogin": "Использовать активный вход",
    "settingsD.sourceControlAccountSettings.staleLogin":
      "Выбранный вход больше не активен, поэтому используется текущий вход {cli}.",
    "settingsD.sourceControlAccountSettings.cantBeUsed": "нельзя использовать: {error}",
    "settingsD.sourceControlAccountSettings.invalidLogin":
      "{cli} сообщает, что этот вход недействителен.",
    "settingsD.sourceControlAccountSettings.envOverrides":
      "На сервере задано {var}, поэтому оно переопределяет выбранный здесь аккаунт, пока переменная не сброшена.",
    "settingsD.sourceControlAccountSettings.hideAccountsAria": "Скрыть аккаунты {label}",
    "settingsD.sourceControlAccountSettings.revealAccountsAria": "Показать аккаунты {label}",
    "settingsD.sourceControlAccountSettings.useOnHostAria": "Использовать {label} на {host}",
    "settingsD.sourceControlAccountSettings.accountForHostAria": "Аккаунт {label} для {host}",
    "settingsD.sourceControlTokenSettings.host": "Хост",
    "settingsD.sourceControlTokenSettings.token": "Токен",
    "settingsD.sourceControlTokenSettings.remove": "Удалить",
    "settingsD.sourceControlTokenSettings.save": "Сохранить",
    "settingsD.sourceControlTokenSettings.createToken": "Создать токен",
    "settingsD.sourceControlTokenSettings.noTokenSaved":
      "Токен не сохранён; сервер использует {envVar} или вход {cli}.",
    "settingsD.sourceControlTokenSettings.savedFor": "Сохранено для {hosts}.",
    "settingsD.settingsBreadcrumb.settings": "Настройки",
    "settingsD.settingsBreadcrumb.ariaLabel": "Навигация по настройкам",
    "settingsD.settingsSidebarNav.sectionsAria": "Разделы настроек",
    "settingsD.settingsSidebarNav.search": "Поиск",
    "settingsD.settingsSidebarNav.searchSettings": "Поиск по настройкам",
    "settingsD.settingsSidebarNav.clearSearch": "Очистить поиск по настройкам",
    "settingsD.settingsSidebarNav.noSettingsFound": "Настройки не найдены",
    "settingsD.settingsSidebarNav.searchResults": "Результаты поиска по настройкам",
    "settingsD.settingsPanels.streamingTurn": "Ждать полного ответа",
    "settingsD.settingsPanels.streamingParagraph": "Показывать готовые абзацы",
    "settingsD.settingsPanels.streamingTurnDescription":
      "Текст появится, когда агент завершит ход.",
    "settingsD.settingsPanels.streamingParagraphDescription":
      "Каждый абзац или блок кода появляется, как только он готов.",
    "settingsD.settingsPanels.updateDownloadFailed": "Не удалось загрузить обновление",
    "settingsD.settingsPanels.downloadFailed": "Загрузка не удалась.",
    "settingsD.settingsPanels.updateConfirmFailed": "Не удалось подтвердить обновление",
    "settingsD.settingsPanels.updateConfirmFailedDescription":
      "Подтверждение обновления не удалось.",
    "settingsD.settingsPanels.installFailed": "Не удалось установить обновление",
    "settingsD.settingsPanels.installFailedDescription": "Установка не удалась.",
    "settingsD.settingsPanels.checkUpdatesFailed": "Не удалось проверить обновления",
    "settingsD.settingsPanels.checkUpdatesFailedDescription": "Проверка обновлений не удалась.",
    "settingsD.settingsPanels.download": "Загрузить",
    "settingsD.settingsPanels.install": "Установить",
    "settingsD.settingsPanels.checking": "Проверка…",
    "settingsD.settingsPanels.downloading": "Загрузка…",
    "settingsD.settingsPanels.upToDate": "Актуальная версия",
    "settingsD.settingsPanels.checkForUpdates": "Проверить обновления",
    "settingsD.settingsPanels.updateAvailable": "Доступно обновление.",
    "settingsD.settingsPanels.updateTrack": "Канал обновлений",
    "settingsD.settingsPanels.updateTrackDescription":
      "Переключает канал выпусков размещённого приложения.",
    "settingsD.settingsPanels.couldNotRestoreTheme": "Не удалось восстановить настройки темы",
    "settingsD.settingsPanels.tryAgain": "Попробуйте снова.",
    "settingsD.settingsPanels.autoSettleInactivityAria": "Дней бездействия до автозавершения",
    "settingsD.settingsPanels.compactIdleThreads": "Сжимать простаивающие треды",
    "settingsD.settingsPanels.compactIdleDescription":
      "Когда сжимать простаивающий тред Claude длиннее 200 000 токенов: после возврата к нему, непосредственно перед истечением кэша промпта или никогда. Каждый провайдер Claude может переопределить это.",
    "settingsD.settingsPanels.newProjects": "Новые проекты",
    "settingsD.settingsPanels.addProjectBaseDirectory": "Базовая папка для добавления проектов",
    "settingsD.settingsPanels.cloneDescription":
      "Клоны попадают в github.com/owner/repo внутри папки выше, как в ghq.",
    "settingsD.settingsPanels.cloneIntoHostFolders": "Клонировать в папки хоста",
    "settingsD.settingsPanels.snooze": "Отложить",
    "settingsD.settingsPanels.usageLimits": "Лимиты использования",
    "settingsD.settingsPanels.autoResumeDescription":
      "Автоматически возобновлять треды, когда сбрасываются их лимиты использования. Автовозобновление можно отменить в каждом треде.",
    "settingsD.settingsPanels.resumeAfterLimits": "Возобновлять после лимитов использования",
    "settingsD.settingsPanels.snoozeUntilLimitsDescription":
      "Откладывать треды до сброса их лимитов использования. Включите автовозобновление, чтобы продолжить работу агента после сброса.",
    "settingsD.settingsPanels.snoozeUntilLimits": "Откладывать до сброса лимитов",
    "settingsD.settingsPanels.autoSettle": "Автозавершение",
    "settingsD.settingsPanels.autoSettleMergedDescription":
      "Завершать тред, когда его пул-реквест слит. Закрытые пул-реквесты всё равно завершаются автоматически.",
    "settingsD.settingsPanels.autoSettleMerged": "Автозавершать слитые треды",
    "settingsD.settingsPanels.autoSettleInactiveDescription":
      "Треды на боковой панели без активности в течение этого времени завершаются автоматически.",
    "settingsD.settingsPanels.autoSettleInactive": "Автозавершать неактивные треды",
    "settingsD.settingsPanels.newActivityDescription":
      "Любая новая активность автоматически возвращает тред в работу.",
    "settingsD.settingsPanels.keepThreadsWithPr": "Сохранять треды с PR",
    "settingsD.settingsPanels.keepThreadsWithPrDescription":
      "Бездействие не завершает треды с пул-реквестом. Слияние и закрытие по-прежнему их завершают.",
    "settingsD.settingsPanels.textGeneration": "Генерация текста",
    "settingsD.settingsPanels.textGenerationDescription":
      "Для названий тредов и другого сгенерированного текста. У контроля версий своя настройка. Генераторы текста из провайдеров тоже появляются здесь.",
    "settingsD.settingsPanels.textGenerationModelNotSaved": "Модель генерации текста не сохранена",
    "settingsD.settingsPanels.mixed": "Разные",
    "settingsD.settingsPanels.differentStreamingModes":
      "Выбранные цели используют разные режимы потоковой передачи.",
    "settingsD.settingsPanels.responseStreaming": "Потоковая передача ответа",
    "settingsD.settingsPanels.updates": "Обновления",
    "settingsD.settingsPanels.providerUpdatesDescription":
      "Проверять установленные CLI провайдеров на наличие новых версий и загружать обновления каталога моделей. Если выключено, новые модели могут не появиться.",
    "settingsD.settingsPanels.checkProviderVersions": "Проверять версии провайдеров",
    "settingsD.settingsPanels.keepAwake": "Не давать компьютеру засыпать",
    "settingsD.settingsPanels.keepAwakeOff": "Выключено",
    "settingsD.settingsPanels.keepAwakeWhileWorking": "Пока работают агенты",
    "settingsD.settingsPanels.keepAwakeAlways": "Всегда",
    "settingsD.settingsPanels.keepAwakeOffDescription":
      "Компьютер засыпает как обычно, и работающие агенты приостанавливаются.",
    "settingsD.settingsPanels.keepAwakeWhileWorkingDescription":
      "Компьютер не засыпает, пока работают агенты, и может уснуть через минуту после их завершения. Закрытая крышка ноутбука всё равно усыпляет его.",
    "settingsD.settingsPanels.keepAwakeAlwaysDescription":
      "Компьютер не засыпает, пока запущен Gustaf, например чтобы подключаться к нему с телефона. Закрытая крышка ноутбука всё равно усыпляет его.",
    "settingsD.settingsPanels.differentKeepAwakeModes":
      "В окружениях разные настройки. Выберите вариант, чтобы применить его ко всем.",
    "settingsD.settingsPanels.continueAfterRestartsDescription":
      "Автоматически возобновлять прерванные треды после обновления, сбоя или перезапуска машины в выбранных окружениях.",
    "settingsD.settingsPanels.restartContinuationRequired":
      "Все выбранные подключённые окружения должны поддерживать продолжение после перезапуска.",
    "settingsD.settingsPanels.continueAfterRestarts": "Продолжать треды после перезапусков",
    "settingsD.settingsPanels.backgroundActivity": "Фоновая активность",
    "settingsD.settingsPanels.diagnostics": "Диагностика",
    "settingsD.settingsPanels.inspectThisEnvironment":
      "Просматривайте процессы, использование ресурсов и логи в этом окружении.",
    "settingsD.settingsPanels.inspectOneEnvironment":
      "Просматривайте процессы, использование ресурсов и логи по одному окружению за раз.",
    "settingsD.settingsPanels.app": "Приложение",
    "settingsD.settingsPanels.organization": "Организация",
    "settingsD.settingsPanels.currentVersion": "Текущая версия приложения.",
    "settingsD.settingsPanels.legal": "Юридическая информация",
    "settingsD.settingsPanels.legalDescription":
      "Как мы обрабатываем ваши данные, включая анонимные данные об использовании, которые собирает Gustaf.",
    "settingsD.settingsPanels.licensesDescription":
      "Уведомления о зависимостях, ресурсах и необязательных инструментах, которые использует Gustaf.",
    "settingsD.sourceControlWritingSettings.repoConventions": "Соглашения репозитория",
    "settingsD.sourceControlWritingSettings.repoConventionsDescription":
      "В каждом проекте подстраивается под недавние описания изменений и заголовки запросов на изменение.",
    "settingsD.sourceControlWritingSettings.conventionalCommits": "Conventional Commits",
    "settingsD.sourceControlWritingSettings.conventionalCommitsDescription":
      "Использовать префиксы Conventional Commits и держать текст запросов на изменение коротким.",
    "settingsD.sourceControlWritingSettings.customInstructions": "Свои инструкции",
    "settingsD.sourceControlWritingSettings.customInstructionsDescription":
      "Использовать ваши инструкции для описаний изменений и запросов на изменение во всех проектах.",
    "settingsD.sourceControlWritingSettings.writingReview": "Написание и ревью",
    "settingsD.sourceControlWritingSettings.writingStyleAria":
      "Стиль написания для контроля версий",
    "settingsD.sourceControlWritingSettings.mixed": "Разные",
    "settingsD.sourceControlWritingSettings.customAllAria":
      "Свои инструкции контроля версий для всех выбранных окружений",
    "settingsD.sourceControlWritingSettings.customAllPlaceholder":
      "Напишите инструкции, которые должно использовать каждое выбранное окружение.",
    "settingsD.sourceControlWritingSettings.applyToAll": "Применить инструкции ко всем",
    "settingsD.sourceControlWritingSettings.writeForAll": "Написать свои инструкции для всех",
    "settingsD.sourceControlWritingSettings.writingPlaceholder":
      "Делайте заголовки короткими. Используйте короткие маркированные списки в описаниях.",
    "settingsD.sourceControlWritingSettings.writingAria":
      "Свои инструкции по написанию для контроля версий",
    "settingsD.sourceControlWritingSettings.reviewGuidesDescription":
      "Добавляет вкладку «Гид» к пул-реквестам. Агент объясняет изменения и отмечает решения, которые нужно проверить.",
    "settingsD.sourceControlWritingSettings.reviewGuidesAria": "Гиды для ревью",
    "settingsD.sourceControlWritingSettings.reviewGuideModelDescription":
      "Должен быть агент для кода: он читает пул-реквест в несколько шагов. «Выкл.» использует модель написания, а если она генератор текста, то Codex или Claude.",
    "settingsD.sourceControlWritingSettings.connectForReviewGuide":
      "Подключите окружение, чтобы выбрать модель для гида ревью.",
    "settingsD.sourceControlWritingSettings.reviewGuideModelAria": "Модель гида ревью",
    "settingsD.sourceControlWritingSettings.reviewGuideModelNotSaved":
      "Модель гида ревью не сохранена",
    "settingsD.sourceControlWritingSettings.separateReviewGuideModel":
      "Использовать отдельную модель для гида ревью",
    "settingsD.sourceControlWritingSettings.reviewGuideInstructionsDescription":
      "Ваши предпочтения для гидов ревью: что показывать первым, на чём задерживаться или что пропускать. Формат и охват гида не меняются.",
    "settingsD.sourceControlWritingSettings.reviewGuideInstructionsAria":
      "Инструкции для гида ревью",
    "settingsD.sourceControlWritingSettings.mixedReviewGuidePlaceholder":
      "Разные. Введите инструкции, которые применятся ко всем выбранным целям.",
    "settingsD.sourceControlWritingSettings.reviewGuidePlaceholder":
      "Сначала показывать интерфейсы сервисов, затем реализации. Пропускать тестовые файлы, если они не меняют поведение. Держать резюме в двух предложениях.",
    "settingsD.sourceControlWritingSettings.templatesDescription":
      "Использовать шаблон репозитория для описаний запросов на изменение, если он есть.",
    "settingsD.sourceControlWritingSettings.followTemplatesAria":
      "Следовать шаблонам запросов на изменение",
    "settingsD.sourceControlWritingSettings.writerModelDescription":
      "Модель для текста контроля версий и имён веток или закладок. Если выключено, используется модель генерации текста, настроенная для этого окружения.",
    "settingsD.sourceControlWritingSettings.connectForWriterModel":
      "Подключите окружение, чтобы выбрать модель написания для контроля версий.",
    "settingsD.sourceControlWritingSettings.noTextGenProviders":
      "Нет доступных провайдеров генерации текста.",
    "settingsD.sourceControlWritingSettings.writerModelAria":
      "Модель написания для контроля версий",
    "settingsD.sourceControlWritingSettings.writerModelNotSaved":
      "Модель написания для контроля версий не сохранена",
    "settingsD.sourceControlWritingSettings.separateWriterModel":
      "Использовать отдельную модель написания для контроля версий",
    "settingsD.sourceControlSettings.authenticated": "Авторизован",
    "settingsD.sourceControlSettings.notAuthenticated": "Не авторизован",
    "settingsD.sourceControlSettings.statusUnknown": "Статус неизвестен",
    "settingsD.sourceControlSettings.asAccount": "как",
    "settingsD.sourceControlSettings.everyHostOff": "Все хосты {label} выключены.",
    "settingsD.sourceControlSettings.available": "Доступно",
    "settingsD.sourceControlSettings.comingSoon": "Поддержка {label} скоро появится.",
    "settingsD.sourceControlSettings.notAvailableOnServer": "Недоступно на этом сервере: {hint}",
    "settingsD.sourceControlSettings.availableWithHint": "Доступно. {hint}",
    "settingsD.sourceControlSettings.couldNotVerify": "Не удалось проверить {label}. {detail}",
    "settingsD.sourceControlSettings.comingSoonBadge": "Скоро",
    "settingsD.sourceControlSettings.toggleDetails": "Переключить детали: {label}",
    "settingsD.sourceControlSettings.toggleAccountVisibility":
      "Переключить видимость аккаунта контроля версий",
    "settingsD.sourceControlSettings.revealAccount": "Нажмите, чтобы показать аккаунт",
    "settingsD.sourceControlSettings.hideAccount": "Нажмите, чтобы скрыть аккаунт",
    "settingsD.sourceControlSettings.serverEnvironment": "Окружение сервера",
    "settingsD.sourceControlSettings.scanFailed": "Не удалось проверить окружение сервера",
    "settingsD.sourceControlSettings.nothingDetected": "Пока ничего не обнаружено",
    "settingsD.sourceControlSettings.installGitHint":
      "Установите Git на сервере, добавьте необязательные интеграции с хостингом или учётные данные, которые нужны вашему рабочему пространству, и затем повторите проверку.",
    "settingsD.sourceControlSettings.scan": "Сканировать",
    "settingsD.sourceControlSettings.orUseCredentials": "Или используйте свои учётные данные",
    "settingsD.sourceControlSettings.rescanAria": "Повторно проверить окружение сервера",
    "settingsD.sourceControlSettings.rescanTooltip":
      "Повторно проверить Git и интеграции с хостингом",
    "settingsD.sourceControlSettings.connectToInspect":
      "Подключите окружение, чтобы проверить его инструменты контроля версий и интеграции с хостингом.",
    "settingsD.sourceControlSettings.versionControl": "Контроль версий",
    "settingsD.sourceControlSettings.providers": "Провайдеры контроля версий",
    "settingsD.sourceControlAppSignIn.signedInAs": "Вход выполнен как",
    "settingsD.sourceControlAppSignIn.accountAria": "Аккаунт GitHub, с которым выполнен вход",
    "settingsD.sourceControlAppSignIn.showAccount": "Показать аккаунт",
    "settingsD.sourceControlAppSignIn.hideAccount": "Скрыть аккаунт",
    "settingsD.sourceControlAppSignIn.signedInWithSavedToken":
      "Вход выполнен, но сохранённый ниже токен используется, пока он доступен для чтения.",
    "settingsD.sourceControlAppSignIn.signedIn": "Вход выполнен",
    "settingsD.sourceControlAppSignIn.signOut": "Выйти",
    "settingsD.sourceControlAppSignIn.approveApp":
      "Подтвердите приложение на GitHub, чтобы завершить вход.",
    "settingsD.sourceControlAppSignIn.cancel": "Отмена",
    "settingsD.sourceControlAppSignIn.tryAgain": "Повторить",
    "settingsD.sourceControlAppSignIn.signInWithGitHub": "Войти через GitHub",
    "settingsD.sourceControlAppSignIn.copyCodeAria": "Копировать код",
    "settingsD.sourceControlAppSignIn.copyCodeAndOpen": "Копировать код и открыть GitHub",
    "settingsD.sourceControlAppSignIn.reachesRepositories":
      "Доступ к репозиториям в аккаунтах и организациях, где установлено приложение.",
    "settingsD.sourceControlAppSignIn.installOnOrganization": "Установить в организации",
    "settingsD.sourceControlAppSignIn.manageOnGitHub": "Управлять на GitHub",
    "settingsD.settingInheritance.environment": "Окружение",
    "settingsD.settingInheritance.sameOnAllMachines": "Одинаково на всех машинах",
    "settingsD.settingInheritance.overriddenBy": "Переопределено",
    "settingsD.speechLanguageSelect.autoDetect": "Автоопределение",
    "settingsD.speechLanguageSelect.unavailable": "{language} недоступен",
    "settingsD.speechLanguageSelect.autoWithLabel": "Авто ({label})",
    "settingsD.speechLanguageSelect.transcriptionLanguage": "Язык транскрипции",
    "settingsD.speechLanguageSelect.auto": "Авто",
    "settingsD.secretInput.storedReplace": "Сохранённый секрет, введите новое значение для замены",
    "settingsD.secretInput.notSet": "Не задано",
    "settingsD.sessionPermissions.routePermissions":
      "Эти разрешения действуют для вашего активного маршрута. Другие маршруты могут иметь другие разрешения.",
    "settingsD.sessionPermissions.connectionPermissions":
      "Эти разрешения действуют для текущего подключения этого клиента.",
    "settingsD.sessionPermissions.allowed": "Разрешено",
    "settingsD.sessionPermissions.notGranted": "Не предоставлено",
    "settingsD.account.title": "Аккаунт",
    "settingsD.account.loading": "Загрузка…",
    "settingsD.account.notSignedIn": "Вход не выполнен",
    "settingsD.account.signedOutDescription":
      "Войдите в аккаунт Gustaf, чтобы видеть привязанные к нему устройства и управлять ими.",
    "settingsD.account.expired": "Сессия истекла. Войдите снова.",
    "settingsD.account.finishInBrowser": "Завершите вход в браузере.",
    "settingsD.account.signIn": "Войти через GitHub",
    "settingsD.account.cancel": "Отмена",
    "settingsD.account.signOut": "Выйти",
    "settingsD.account.unnamed": "Аккаунт GitHub",
    "settingsD.account.devices": "Устройства",
    "settingsD.account.devicesDescription": "Компьютеры и телефоны, привязанные к этому аккаунту.",
    "settingsD.account.noDevices": "К этому аккаунту пока не привязано ни одного устройства.",
    "settingsD.account.thisComputer": "Этот компьютер",
    "settingsD.account.registerThisComputer": "Зарегистрировать этот компьютер",
    "settingsD.account.revoke": "Отозвать",
    "settingsD.account.revokeConfirm":
      "Отозвать «{name}»? Устройство потеряет доступ к этому аккаунту.",
    "settingsD.account.signInFailed": "Не удалось войти",
    "settingsD.account.actionFailed": "Не удалось выполнить действие с аккаунтом",
    "settingsD.account.devicesFailed": "Не удалось загрузить устройства",
  },
} as const satisfies Record<UiLanguage, Record<string, string>>;
