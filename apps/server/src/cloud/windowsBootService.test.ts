import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { makeWindowsBootService } from "./windowsBootService.ts";
import { expect, it } from "@effect/vitest";
import {
  encodeWindowsTask,
  parseWindowsTaskState,
  renderWindowsTask,
} from "./windowsBootService.ts";

it("renders a hidden per-user logon task through the stable Unicode shim", () => {
  const xml = renderWindowsTask({
    userId: "S-1-5-21-123",
    homeDir: "C:\\Users\\Максим & Co",
    shim: "C:\\Users\\Максим & Co\\.local\\bin\\gustaf.cmd",
    baseDir: "C:\\Users\\Максим & Co\\.t3",
    logPath: "C:\\Users\\Максим & Co\\.t3\\userdata\\logs\\boot-service.log",
    powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });
  expect(xml).toContain("<Description>C:\\Users\\Максим &amp; Co\\.t3</Description>");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  expect(xml).toContain("<RestartOnFailure>");
  const encoded = /-EncodedCommand ([^< ]+)/.exec(xml)![1]!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  expect(script).toContain(
    'chcp 65001 >nul & "C:\\Users\\Максим & Co\\.local\\bin\\gustaf.cmd" __windows-service',
  );
  expect(script).toContain("exit $LASTEXITCODE");
  const bytes = encodeWindowsTask(xml);
  expect([...bytes.subarray(0, 2)]).toEqual([255, 254]);
  expect(bytes.subarray(2).toString("utf16le")).toBe(xml);
});

it.each([
  ["0", "unknown"],
  ["1\r\n", "disabled"],
  ["2", "queued"],
  ["3", "ready"],
  ["4", "running"],
])("parses locale-independent scheduler state %s", (input, expected) => {
  expect(parseWindowsTaskState(input!)).toBe(expected);
});

it("rejects malformed scheduler output", () => {
  expect(() => parseWindowsTaskState("Running")).toThrow();
  expect(() => parseWindowsTaskState("9")).toThrow();
});

it.effect("installs, restarts and removes only this home's task through its recorded shim", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const entry = path.join(baseDir, "runtime", "versions", "1.2.3", "gustaf.exe");
    const shim = path.join(baseDir, "gustaf.cmd");
    yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
    yield* fs.writeFileString(shim, `@echo off\r\n"${entry}" %*`);
    yield* fs.writeFileString(path.join(baseDir, "runtime", "launchers"), `${shim}\r\n`);
    let installed = false;
    let taskState = 3;
    let taskHome = baseDir;
    const scripts: string[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: Effect.fn("test.windows_task.run")((input) =>
        Effect.sync(() => {
          const script = Buffer.from(input.args.at(-1)!, "base64").toString("utf16le");
          scripts.push(script);
          if (script.includes("/Create")) installed = true;
          if (script.includes("Start-ScheduledTask")) taskState = 4;
          if (script.includes("Stop-ScheduledTask")) taskState = 3;
          if (script.includes("Unregister-ScheduledTask")) installed = false;
          return {
            code: ChildProcessSpawner.ExitCode(0),
            stdout: script.includes("WindowsIdentity")
              ? "S-1-5-21-123"
              : script.includes("Get-ScheduledTask") && installed
                ? `${taskState}\r\n${taskHome}`
                : "",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
      ),
    });
    const service = yield* makeWindowsBootService({
      baseDir,
      logsDir: path.join(baseDir, "logs"),
      cliVersion: "1.2.3",
      execPath: entry,
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Environment, {}),
    );
    expect((yield* service.status).installed).toBe(false);
    const plan = yield* service.install();
    expect((yield* service.status).taskState).toBe("running");
    const xmlBytes = yield* fs.readFile(plan.unitPath);
    expect(Buffer.from(xmlBytes).toString("utf16le")).toContain(
      `<Description>${baseDir}</Description>`,
    );
    expect(yield* service.restart).toBe("restarted");
    const nextEntry = path.join(baseDir, "runtime", "versions", "2.0.0", "gustaf.exe");
    yield* fs.writeFileString(shim, `@echo off\r\n"${nextEntry}" %*`);
    const updated = yield* makeWindowsBootService({
      baseDir,
      logsDir: path.join(baseDir, "logs"),
      cliVersion: "2.0.0",
      execPath: entry,
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Environment, {}),
    );
    const stops = scripts.filter((script) => script.includes("Stop-ScheduledTask")).length;
    yield* updated.install({ start: false });
    expect(scripts.filter((script) => script.includes("Stop-ScheduledTask")).length).toBe(stops);
    expect((yield* updated.status).taskState).toBe("running");
    taskHome = path.join(baseDir, "other");
    const before = scripts.filter((script) => script.includes("Stop-ScheduledTask")).length;
    const refused = yield* service.uninstall.pipe(Effect.flip);
    expect(refused._tag).toBe("BootServiceOtherBaseDirError");
    expect(scripts.filter((script) => script.includes("Stop-ScheduledTask")).length).toBe(before);
    taskHome = baseDir;
    expect(yield* service.uninstall).toBe(true);
    expect((yield* service.status).installed).toBe(false);
    expect(yield* fs.exists(plan.unitPath)).toBe(false);
    const missingShimService = yield* makeWindowsBootService({
      baseDir,
      logsDir: path.join(baseDir, "logs"),
      cliVersion: "1.2.3",
      execPath: "/desktop/gustaf.exe",
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Environment, {}),
    );
    expect((yield* missingShimService.install().pipe(Effect.flip))._tag).toBe(
      "BootServiceCommandError",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
