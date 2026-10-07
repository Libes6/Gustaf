import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ActionLog } from "../../src/components/ActionLog";
import { TurnView } from "../../src/components/chat/TurnView";
import { VerificationCard, isVerificationPart } from "../../src/components/VerificationCard";
import { VerificationSettings } from "../../src/components/VerificationSettings";
import {
  GATE_ACTIVITY,
  OPEN_MODEL_PICKER_EVENT,
  reportText,
  type CheckResult,
  type GateReport,
} from "../../src/agent/verificationCore";
import { makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const result = (over: Partial<CheckResult>): CheckResult => ({
  name: "tests",
  command: "npm test",
  status: "passed",
  exitCode: 0,
  durationMs: 1500,
  output: "",
  ...over,
});
const part = (report: GateReport) => ({
  type: "activity" as const,
  id: "g1",
  name: GATE_ACTIVITY,
  args: { report },
  status: "success" as const,
  output: reportText(report),
});
const passed: GateReport = {
  attempt: 1,
  maxFixAttempts: 2,
  outcome: "passed",
  results: [result({}), result({ name: "lint", command: "npm run lint", durationMs: 250 })],
};

it("shows 'Checks passed (N)' collapsed, then one row per check with a tick, the duration and expandable output", async () => {
  const withOutput: GateReport = { ...passed, results: [result({ output: "42 tests passed" }), passed.results[1]] };
  renderApp(<VerificationCard part={part(withOutput)} />);
  expect(screen.getByText("Verification")).toBeInTheDocument();
  expect(screen.getByText("Checks passed (2)")).toBeInTheDocument();
  expect(screen.queryByText("tests")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Verification/ }));
  expect(screen.getByText("tests")).toBeInTheDocument();
  expect(screen.getByText("1.5 s")).toBeInTheDocument();
  expect(screen.getByText("250 ms")).toBeInTheDocument();
  expect(screen.getAllByText("passed")).toHaveLength(2);
  expect(screen.queryByText("42 tests passed")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /tests/ }));
  expect(screen.getByText("42 tests passed")).toBeInTheDocument();
  expect(screen.getByText("npm test")).toBeInTheDocument();
});

it("a failed run is open by default: failing check, its output, the reason and no model button", () => {
  const failed: GateReport = {
    attempt: 3,
    maxFixAttempts: 2,
    outcome: "failed",
    reason: "max_attempts",
    results: [
      result({ status: "failed", exitCode: 1, output: "FAIL a.test.ts" }),
      result({ name: "lint", command: "npm run lint", status: "skipped", exitCode: null, durationMs: 0 }),
    ],
  };
  renderApp(<VerificationCard part={part(failed)} />);
  expect(screen.getByText("Failed verification")).toBeInTheDocument();
  expect(screen.getByText("failed")).toBeInTheDocument();
  expect(screen.getByText("not run")).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("still fail after the allowed fix attempts");
  expect(screen.queryByRole("button", { name: "Try another model" })).not.toBeInTheDocument();
});

it("a failure sent back to the agent says which fix attempt it is", () => {
  const retry: GateReport = {
    attempt: 1,
    maxFixAttempts: 2,
    outcome: "retry",
    results: [result({ status: "timeout", exitCode: null })],
  };
  renderApp(<VerificationCard part={part(retry)} />);
  expect(screen.getByText("Check failed, sent back to the agent (fix attempt 1 of 2)")).toBeInTheDocument();
});

it("a running gate shows progress", () => {
  renderApp(
    <VerificationCard
      part={part({
        attempt: 1,
        maxFixAttempts: 2,
        outcome: "running",
        results: [result({ status: "running", exitCode: null, durationMs: 0 })],
      })}
    />,
  );
  expect(screen.getByText("Running checks…")).toBeInTheDocument();
});

it("the repeated-failure card offers 'Try another model', which only opens the model picker", async () => {
  const seen = vi.fn();
  addEventListener(OPEN_MODEL_PICKER_EVENT, seen);
  const repeated: GateReport = {
    attempt: 3,
    maxFixAttempts: 5,
    outcome: "failed",
    reason: "repeated",
    suggestion: "another_model",
    results: [result({ status: "failed", exitCode: 1, output: "FAIL" })],
  };
  renderApp(<VerificationCard part={part(repeated)} />);
  expect(screen.getByRole("note")).toHaveTextContent("same failure repeated three times");
  await userEvent.click(screen.getByRole("button", { name: "Try another model" }));
  expect(seen).toHaveBeenCalledTimes(1);
  expect(callsOf("run_command")).toHaveLength(0);
  removeEventListener(OPEN_MODEL_PICKER_EVENT, seen);
});

it("only valid verification activity parts are recognised", () => {
  expect(isVerificationPart(part(passed))).toBe(true);
  expect(isVerificationPart({ type: "activity", id: "x", name: "verification", args: {}, status: "success" })).toBe(
    false,
  );
  expect(
    isVerificationPart({ type: "activity", id: "x", name: "other", args: { report: passed }, status: "success" }),
  ).toBe(false);
  expect(isVerificationPart({ type: "text", text: "hi" })).toBe(false);
});

it("is localised", () => {
  renderApp(<VerificationCard part={part(passed)} />, makeApp({ locale: "ru" }), "ru");
  expect(screen.getByText("Верификация")).toBeInTheDocument();
  expect(screen.getByText("Проверки пройдены (2)")).toBeInTheDocument();
});

it("a turn renders the stored verification part as the Verification card next to the final text, other activities stay tool cards", () => {
  const handlers = {
    onEdit: vi.fn(),
    onRegenerate: vi.fn(),
    onDelete: vi.fn(),
    onBranch: vi.fn(),
    onApprovePlan: vi.fn(),
    onRejectPlan: vi.fn(),
  };
  const msg = (id: number, role: string, parts: unknown[]) => ({ id, chat_id: 1, created_at: id, role, parts });
  const turn = {
    user: msg(1, "user", [{ type: "text", text: "do it" }]),
    steps: [msg(2, "assistant", [{ type: "text", text: "All done" }, part(passed)])],
  } as any;
  renderApp(<TurnView turn={turn} live={false} liveResults={[]} busy={false} isLastTurn handlers={handlers} />);
  expect(screen.getByText("All done")).toBeInTheDocument();
  expect(screen.getByText("Checks passed (2)")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Verification" })).toHaveClass("tool-card");
});

// ---------- settings editor ----------

function settingsDb(initial: Record<string, unknown>) {
  const settings: Record<string, string> = Object.fromEntries(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  mockInvoke({
    db_select: ({ sql, params }: any) =>
      /from settings where key/.test(sql) && settings[params[0]] !== undefined ? [{ value: settings[params[0]] }] : [],
    db_execute: ({ params }: any) => {
      settings[params[0]] = params[1];
      return [1, 1];
    },
  });
  return settings;
}
const key = "verification:/work/alpha";
const files = (done: unknown) => ({
  fs_read: ({ path }: any) => {
    if (path === "package.json")
      return JSON.stringify({ scripts: { lint: "eslint .", test: "vitest" }, devDependencies: { typescript: "5" } });
    if (path === ".gustaf/done.json" && done) return JSON.stringify(done);
    throw new Error("no such file");
  },
});

it("starts empty, suggestions only fill the rows (nothing runs), and Save stores the checks per project", async () => {
  const settings = settingsDb({});
  mockInvoke(files(null));
  renderApp(<VerificationSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  expect(await screen.findByText("No checks: runs finish without verification.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Suggest checks" }));
  const commands = await screen.findAllByLabelText("Command");
  expect(commands.map((c) => (c as HTMLInputElement).value)).toEqual(["npm run lint", "npm test"]);
  expect(callsOf("run_command")).toHaveLength(0);
  expect(settings[key]).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved")).toBeInTheDocument();
  const stored = JSON.parse(settings[key]);
  expect(stored.checks.map((c: any) => [c.name, c.command, c.timeoutMs])).toEqual([
    ["lint", "npm run lint", 120000],
    ["test", "npm test", 300000],
  ]);
  expect(stored.maxFixAttempts).toBe(2);
  expect(stored.useProjectFile).toBe(false);
  expect(callsOf("run_command")).toHaveLength(0);
});

it("a check without a command is refused; rows can be added, edited and removed", async () => {
  const settings = settingsDb({
    [key]: {
      checks: [{ name: "tests", command: "npm test", timeoutMs: 60000 }],
      maxFixAttempts: 1,
      useProjectFile: false,
    },
  });
  mockInvoke(files(null));
  renderApp(<VerificationSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  expect(await screen.findByDisplayValue("npm test")).toBeInTheDocument();
  expect(screen.getByLabelText("Fix attempts after a failed check")).toHaveValue("1");
  await userEvent.click(screen.getByRole("button", { name: "Add check" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Every check needs a command.");
  await userEvent.click(screen.getAllByRole("button", { name: /Remove check/ })[1]);
  const timeout = screen.getByLabelText("Timeout, seconds");
  expect(timeout).toHaveValue(60);
  fireEvent.change(timeout, { target: { value: "90" } });
  await userEvent.selectOptions(screen.getByLabelText("Fix attempts after a failed check"), "3");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(JSON.parse(settings[key])).toMatchObject({
    checks: [{ command: "npm test", timeoutMs: 90000 }],
    maxFixAttempts: 3,
  });
});

it("the project file is listed but off by default, with a warning that it runs shell commands; the switch is stored on Save", async () => {
  const settings = settingsDb({});
  mockInvoke(files({ checks: [{ name: "build", command: "npm run build" }, { command: "" }], maxFixAttempts: 9 }));
  renderApp(<VerificationSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  const sw = await screen.findByRole("checkbox", { name: /\.gustaf\/done\.json/ });
  expect(sw).not.toBeChecked();
  expect(screen.getByRole("note")).toHaveTextContent(/run shell commands/);
  expect(await screen.findByText("npm run build")).toBeInTheDocument();
  expect(screen.getByText("The project file exists but is off; its checks will not run.")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(/#2: "command" must be a non-empty string/);
  expect(screen.getByRole("alert")).toHaveTextContent(/maxFixAttempts/);
  await userEvent.click(sw);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(JSON.parse(settings[key]).useProjectFile).toBe(true);
});

it("says so when the project has no done.json", async () => {
  settingsDb({});
  mockInvoke(files(null));
  renderApp(<VerificationSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  expect(await screen.findByText("This project has no .gustaf/done.json.")).toBeInTheDocument();
});

it("asks for a project first when there is none", () => {
  renderApp(<VerificationSettings />, makeApp({ projects: [] }));
  expect(screen.getByText("Add a project first.")).toBeInTheDocument();
});

// ---------- action log ----------

it("the action log shows gate runs with exit code, duration and output", async () => {
  settingsDb({
    actionLog: [
      {
        id: "g1",
        at: 1_700_000_000_000,
        tool: "gate",
        summary: "tests: npm test",
        status: "error",
        source: "gate",
        durationMs: 2300,
        gate: { check: "tests", command: "npm test", exitCode: 1, attempt: 1 },
        detail: "FAIL a.test.ts",
      },
    ],
  });
  renderApp(<ActionLog />);
  expect(await screen.findByText("tests: npm test")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/exit 1 · .*2\.3 s/)).toBeInTheDocument());
  expect(screen.getByText("FAIL a.test.ts")).toBeInTheDocument();
  expect(screen.getByText("Check")).toBeInTheDocument();
});
