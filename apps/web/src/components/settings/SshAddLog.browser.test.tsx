import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { SshAddLogEntry } from "~/connection/sshAddLog";
import { render } from "../../../test/render";
import { SshAddLog } from "./SshAddLog";

// A start that has not happened yet, so no time has elapsed whatever the runner's clock says.
const NOW = Number.MAX_SAFE_INTEGER;

const running: SshAddLogEntry = {
  step: "runtime-download",
  status: "running",
  detail: "v0.23.0 · github.com",
  startedAt: NOW,
};

it("renders nothing before the first step", async () => {
  await using _screen = await render(<SshAddLog entries={[]} />);
  await expect.element(page.getByText("Progress")).not.toBeInTheDocument();
});

it("shows a running step with its detail and no elapsed time yet", async () => {
  await using screen = await render(<SshAddLog entries={[running]} />);
  await expect.element(screen.getByText("Downloading Gustaf")).toBeVisible();
  await expect.element(screen.getByText("v0.23.0 · github.com")).toBeVisible();
  await expect.element(screen.getByText("In progress")).toBeInTheDocument();
  await expect.element(screen.getByText(/^\d+s$/)).not.toBeInTheDocument();
});

it("shows finished steps in order with the elapsed time of a slow one", async () => {
  await using screen = await render(
    <SshAddLog
      entries={[
        { step: "resolve-host", status: "done", startedAt: 0, endedAt: 300 },
        { step: "runtime-download", status: "done", startedAt: 300, endedAt: 12_300 },
        { step: "tunnel", status: "running", detail: "localhost:41773", startedAt: NOW },
      ]}
    />,
  );
  const items = screen.getByRole("listitem");
  await expect.element(items.nth(0).getByText("Resolving the SSH host")).toBeVisible();
  await expect.element(items.nth(1).getByText("Downloading Gustaf")).toBeVisible();
  await expect.element(items.nth(1).getByText("12s")).toBeVisible();
  await expect.element(items.nth(0).getByText(/^\d+s$/)).not.toBeInTheDocument();
  await expect.element(items.nth(2).getByText("Opening the SSH tunnel")).toBeVisible();
});

it("keeps the failed step and its cause visible", async () => {
  await using screen = await render(
    <SshAddLog
      entries={[
        { step: "connect", status: "done", startedAt: 0, endedAt: 100 },
        {
          step: "runtime-download",
          status: "failed",
          detail: "Could not download t3 0.23.0 from https://github.com/x/SHA256SUMS",
          startedAt: 100,
          endedAt: 4_100,
        },
      ]}
    />,
  );
  await expect.element(screen.getByText("Failed")).toBeInTheDocument();
  await expect
    .element(screen.getByText("Could not download t3 0.23.0 from https://github.com/x/SHA256SUMS"))
    .toBeVisible();
  await expect.element(screen.getByText("4s")).toBeVisible();
});

it("copies the log as plain English lines", async () => {
  await using screen = await render(
    <SshAddLog
      entries={[
        { step: "connect", status: "done", startedAt: 1_000, endedAt: 1_500 },
        { step: "tunnel", status: "failed", detail: "refused", startedAt: 1_500, endedAt: 1_900 },
      ]}
    />,
  );
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  await screen.getByRole("button", { name: "Copy log" }).click();

  expect(write).toHaveBeenCalledWith(
    "+0.0s connect done (0.5s)\n+0.5s tunnel failed (0.4s) - refused",
  );
});
