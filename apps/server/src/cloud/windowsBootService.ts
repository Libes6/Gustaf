// @effect-diagnostics nodeBuiltinImport:off - Task Scheduler consumes UTF-16LE XML and PowerShell commands.
import * as NodeBuffer from "node:buffer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { generatedWindowsShimTarget, launcherOwnsVersionsDir } from "./pinnedRuntime.ts";

const isOtherBaseDirError = Schema.is(BootService.BootServiceOtherBaseDirError);
const isCommandError = Schema.is(BootService.BootServiceCommandError);

const psWord = (value: string) => `'${value.replaceAll("'", "''")}'`;
const xmlText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const powershellArguments = (script: string) => [
  "-NoProfile",
  "-NonInteractive",
  "-WindowStyle",
  "Hidden",
  "-EncodedCommand",
  NodeBuffer.Buffer.from(script, "utf16le").toString("base64"),
];

export function renderWindowsTask(input: {
  readonly userId: string;
  readonly shim: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly powershell: string;
  readonly homeDir: string;
}) {
  // cmd needs UTF-8 to read the installer's UTF-8 shim under non-ASCII home paths.
  const command = `chcp 65001 >nul & "${input.shim}" __windows-service "${input.baseDir}" "${input.logPath}"`;
  const script = `& $env:ComSpec /d /s /c ${psWord(`"${command}"`)}; exit $LASTEXITCODE`;
  const args = powershellArguments(script).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlText(input.baseDir)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlText(input.userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="User"><UserId>${xmlText(input.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
  <Actions Context="User"><Exec><Command>${xmlText(input.powershell)}</Command><Arguments>${xmlText(args)}</Arguments><WorkingDirectory>${xmlText(input.homeDir)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

export const encodeWindowsTask = (xml: string) => NodeBuffer.Buffer.from(`\uFEFF${xml}`, "utf16le");

export function parseWindowsTaskState(output: string) {
  const value = /^\d+$/.test(output.trim()) ? Number(output.trim()) : -1;
  switch (value) {
    case 0:
      return "unknown";
    case 1:
      return "disabled";
    case 2:
      return "queued";
    case 3:
      return "ready";
    case 4:
      return "running";
    default:
      throw new Error("Invalid Task Scheduler state");
  }
}

export const makeWindowsBootService = Effect.fn("cloud.windows_boot_service.make")(
  function* (input: {
    readonly baseDir: string;
    readonly logsDir: string;
    readonly cliVersion: string;
    readonly execPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const env = yield* HostProcess.Environment;
    const homeDir = yield* HostProcess.HomeDirectory;
    const powershell = path.join(
      env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const run = Effect.fn("cloud.windows_boot_service.run")(function* (script: string) {
      const result = yield* runner
        .run({
          command: powershell,
          args: powershellArguments(
            `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${script}`,
          ),
          timeout: Duration.seconds(30),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new BootService.BootServiceCommandError({
                step: "managing the Windows scheduled task",
                cause,
              }),
          ),
        );
      if (result.code !== 0)
        return yield* new BootService.BootServiceCommandError({
          step: "managing the Windows scheduled task",
          exitCode: Number(result.code),
        });
      return result.stdout.trim();
    });
    const sid = yield* run("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    const taskName = `Gustaf-${sid}`;
    const task = `$task = Get-ScheduledTask -TaskName ${psWord(taskName)} -ErrorAction SilentlyContinue; `;
    const unitPath = path.join(input.baseDir, "runtime", "windows-service.xml");
    const logPath = path.join(input.logsDir, BootService.BOOT_SERVICE_LOG_FILE);
    const runtimeStatePath = path.join(input.baseDir, "userdata", "server-runtime.json");
    const readRuntime = readPersistedServerRuntimeState(runtimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const taskHome = `$taskHome = if ($task) { $task.Description }; `;
    const read = Effect.fn("cloud.windows_boot_service.read")(function* () {
      const output = yield* run(
        `${task}${taskHome}if ($task) { [Console]::WriteLine([int]$task.State); [Console]::Write($taskHome) }`,
      );
      if (!output) return undefined;
      const [state, ...home] = output.split(/\r?\n/);
      return { taskState: parseWindowsTaskState(state ?? ""), baseDir: home.join("\n") };
    });
    const guard = Effect.fn("cloud.windows_boot_service.guard")(function* () {
      const existing = yield* read();
      if (
        existing &&
        path.resolve(existing.baseDir).toLowerCase() !== path.resolve(input.baseDir).toLowerCase()
      ) {
        return yield* new BootService.BootServiceOtherBaseDirError({
          installedBaseDir: existing.baseDir,
          baseDir: input.baseDir,
        });
      }
      return existing;
    });
    const stop = run(`Stop-ScheduledTask -TaskName ${psWord(taskName)}`);
    const start = run(`Start-ScheduledTask -TaskName ${psWord(taskName)}`);
    const shimPath = yield* fs
      .readFileString(path.join(input.baseDir, "runtime", "launchers"))
      .pipe(Effect.orElseSucceed(() => ""));
    let shim: string | undefined;
    for (const candidate of shimPath.split(/\r?\n/).filter(Boolean)) {
      const contents = yield* fs.readFileString(candidate).pipe(Effect.option);
      const target = Option.isSome(contents)
        ? generatedWindowsShimTarget(contents.value)
        : undefined;
      if (
        target &&
        path.basename(candidate).toLowerCase() === "gustaf.cmd" &&
        launcherOwnsVersionsDir(path, path.join(input.baseDir, "runtime", "versions"), target) &&
        (path.resolve(target).toLowerCase() === path.resolve(input.execPath).toLowerCase() ||
          (launcherOwnsVersionsDir(
            path,
            path.join(input.baseDir, "runtime", "versions"),
            input.execPath,
          ) &&
            path.basename(path.dirname(target)) === input.cliVersion))
      ) {
        shim = candidate;
        break;
      }
    }
    const plan = {
      program: shim ? [shim, "serve"] : [],
      baseDir: input.baseDir,
      logPath,
      unitPath,
    };
    const mapIo = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isOtherBaseDirError(cause) || isCommandError(cause)
            ? cause
            : new BootService.BootServiceInstallError({ cause }),
        ),
      );
    return BootService.BootService.of({
      status: mapIo(
        Effect.gen(function* () {
          const existing = yield* read();
          if (!existing)
            return { supported: true, installed: false, current: false, unitPath, logPath };
          const other =
            path.resolve(existing.baseDir).toLowerCase() !==
            path.resolve(input.baseDir).toLowerCase();
          const runtime = yield* readRuntime;
          const version =
            !other && Option.isSome(runtime) && isProcessAlive(runtime.value.pid)
              ? runtime.value.serverVersion
              : undefined;
          return {
            supported: true,
            installed: true,
            ...(version === undefined ? {} : { installedVersion: version }),
            current: !other && existing.taskState === "running" && version === input.cliVersion,
            installedBaseDir: existing.baseDir,
            ...(other ? { otherBaseDir: existing.baseDir } : {}),
            taskState: existing.taskState,
            unitPath,
            logPath,
          };
        }),
      ),
      install: (options) =>
        mapIo(
          Effect.gen(function* () {
            const existing = yield* guard();
            const runtime = yield* readRuntime;
            const running = Option.isSome(runtime) && isProcessAlive(runtime.value.pid);
            const parentCommand = running
              ? yield* run(
                  `$child = Get-CimInstance Win32_Process -Filter "ProcessId=${runtime.value.pid}"; if ($child) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ParentProcessId)").CommandLine }`,
                )
              : "";
            if (
              running &&
              (existing?.taskState !== "running" || !/__windows-service/.test(parentCommand))
            )
              return yield* new BootService.BootServiceCommandError({
                step: "refusing to install while a desktop or manually started server owns this T3 home; stop it first, then run the installer-owned gustaf command",
              });
            if (!shim || /[%!\r\n"]/.test(shim + input.baseDir + logPath))
              return yield* new BootService.BootServiceCommandError({
                step: "locating the installer-owned gustaf.cmd shim; install with scripts/install.ps1 and run gustaf from that installation (paths containing %, !, quotes or newlines are unsupported)",
              });
            if (env.T3_BOOT_SERVICE_UNIT)
              return yield* new BootService.BootServiceCommandError({
                step: "refusing to replace the task from inside its own server; run gustaf service install in a separate terminal",
              });
            yield* fs.makeDirectory(input.logsDir, { recursive: true });
            yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
            const xml = renderWindowsTask({
              userId: sid,
              shim,
              baseDir: input.baseDir,
              logPath,
              powershell,
              homeDir,
            });
            yield* fs.writeFile(unitPath, encodeWindowsTask(xml));
            if (existing && options?.start !== false) yield* stop;
            yield* run(
              `& schtasks.exe /Create /TN ${psWord(taskName)} /XML ${psWord(unitPath)} /F; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
            );
            if (options?.start !== false) yield* start;
            return plan;
          }),
        ),
      restart: mapIo(
        Effect.gen(function* () {
          if (!(yield* guard())) return "skipped" as const;
          if (env.T3_BOOT_SERVICE_UNIT)
            return yield* new BootService.BootServiceCommandError({
              step: "refusing to restart the task from its own server; run gustaf service restart in a separate terminal",
            });
          yield* stop;
          yield* start;
          return "restarted" as const;
        }),
      ),
      uninstall: mapIo(
        Effect.gen(function* () {
          if (!(yield* guard())) return false;
          if (env.T3_BOOT_SERVICE_UNIT)
            return yield* new BootService.BootServiceCommandError({
              step: "refusing to uninstall the task from its own server; run gustaf service uninstall in a separate terminal",
            });
          yield* stop;
          yield* run(`Unregister-ScheduledTask -TaskName ${psWord(taskName)} -Confirm:$false`);
          yield* fs.remove(unitPath, { force: true });
          return true;
        }),
      ),
      withStopped: Effect.fn("cloud.windows_boot_service.with_stopped")(function* <A, E, R>(
        operation: Effect.Effect<A, E, R>,
      ): Effect.fn.Return<A, E | BootService.BootServiceError, R> {
        const existing = yield* guard();
        if (!existing) return yield* operation;
        if (env.T3_BOOT_SERVICE_UNIT)
          return yield* new BootService.BootServiceCommandError({
            step: "refusing to stop this server for maintenance; run gustaf doctor in a separate terminal",
          });
        return yield* Effect.acquireUseRelease(
          stop,
          () => operation,
          () => (existing.taskState === "running" ? start.pipe(Effect.asVoid) : Effect.void),
        );
      }),
    });
  },
);
