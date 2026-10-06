import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ActionLog } from "../../src/components/ActionLog";
import { HooksSettings } from "../../src/components/HooksSettings";
import { makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

/** A settings table in memory behind the db_select / db_execute commands. */
function settingsDb(initial: Record<string, unknown>) {
  const settings: Record<string, string> = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  mockInvoke({
    db_select: ({ sql, params }: any) => (/from settings where key/.test(sql) && settings[params[0]] !== undefined ? [{ value: settings[params[0]] }] : []),
    db_execute: ({ params }: any) => {
      settings[params[0]] = params[1];
      return [1, 1];
    },
  });
  return settings;
}

const file = JSON.stringify({ hooks: [{ event: "post_edit", matcher: "edit_file|write_file", command: "npm test" }, { event: "bogus", command: "x" }, { event: "stop", command: "echo done", timeoutMs: 999999 }] });

it("lists effective hooks with their source and the skipped entries; project hooks are off by default with a warning", async () => {
  settingsDb({ hooks: { hooks: [{ event: "pre_tool", matcher: "run_command", command: "guard.sh" }] } });
  mockInvoke({ fs_read: file });
  renderApp(<HooksSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  expect(await screen.findByText("guard.sh")).toBeInTheDocument();
  expect(screen.getByText(/global · timeout 10000 ms/)).toBeInTheDocument();
  expect(screen.queryByText("npm test")).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /\.gustaf\/hooks\.json/ })).not.toBeChecked();
  expect(screen.getByRole("note")).toHaveTextContent(/run shell commands/);
  expect(screen.getByText("The project file exists but its hooks are off and will not run.")).toBeInTheDocument();
  const skipped = screen.getByRole("alert");
  expect(skipped).toHaveTextContent(/#2: "event" must be one of/);
  expect(skipped).toHaveTextContent(/#3: "timeoutMs" must be a whole number/);
});

it("enabling project hooks stores the switch and shows the project's hooks marked as coming from the project file", async () => {
  const settings = settingsDb({});
  mockInvoke({ fs_read: file });
  renderApp(<HooksSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  await userEvent.click(await screen.findByRole("checkbox", { name: /\.gustaf\/hooks\.json/ }));
  expect(await screen.findByText("npm test")).toBeInTheDocument();
  expect(screen.getByText(/project file · timeout 10000 ms/)).toBeInTheDocument();
  expect(JSON.parse(settings.hooksProjects)).toEqual(["/work/alpha"]);
});

it("saving the global hooks editor validates the JSON", async () => {
  const settings = settingsDb({});
  mockInvoke({ fs_read: () => { throw new Error("no such file"); } });
  renderApp(<HooksSettings />, makeApp({ projects: [project({ path: "/work/alpha" })] }));
  const box = await screen.findByLabelText("Global hooks (JSON)");
  await userEvent.click(box);
  await userEvent.paste("{ broken");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
  expect(settings.hooks).toBeUndefined();
  await userEvent.clear(box);
  await userEvent.click(box);
  await userEvent.paste('{"hooks":[{"event":"stop","command":"say done"}]}');
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("say done")).toBeInTheDocument();
  expect(JSON.parse(settings.hooks).hooks[0].command).toBe("say done");
  expect(callsOf("run_hook")).toHaveLength(0);
});

it("the action log shows hook runs with event, exit code and output", async () => {
  settingsDb({ actionLog: [{ id: "h1", at: 1_700_000_000_000, tool: "hook", summary: "pre_tool: guard.sh", status: "success", source: "hook", hook: { event: "pre_tool", command: "guard.sh", exitCode: 2, scope: "project" }, detail: "no rm here" }] });
  renderApp(<ActionLog />);
  expect(await screen.findByText("pre_tool: guard.sh")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/pre_tool · project · exit 2/)).toBeInTheDocument());
  expect(screen.getByText("no rm here")).toBeInTheDocument();
  expect(screen.getByText("Hook")).toBeInTheDocument();
});
