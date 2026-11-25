import type { RelayHostStatus } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  createOffer: vi.fn(),
  decide: vi.fn(),
  revokeDevice: vi.fn(),
  setTrust: vi.fn(),
}));

// The section only needs these modules; the real ones pull in the whole connection runtime.
vi.mock(import("../../state/relayHost"), async () => ({
  relayHostEnvironment: mocks as never,
}));
vi.mock(import("../../state/use-atom-command"), async () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/environments"), async () => ({
  usePrimaryEnvironmentId: (() => "environment-1") as never,
}));
// The real layout reads sessions and settings scopes; the rows are all this section draws.
vi.mock(import("./settingsLayout"), async () => ({
  SettingsSection: (({ children }: { children?: ReactNode }) => (
    <section>{children}</section>
  )) as never,
  SettingsRow: (({
    title,
    description,
    control,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      <div>{control}</div>
    </div>
  )) as never,
}));
vi.mock(import("../../shellAccount"), async () => ({ shellAccount: (() => ({})) as never }));
vi.mock(import("../../i18n/I18nProvider"), async () => ({
  useFormattingLocale: (() => "en-US") as never,
}));
vi.mock(import("../auth/ConnectAgentSurface"), async () => ({ accessConfig: {} as never }));

import { RelayHostSettingsSection } from "./RelayHostSettings";

const phone = {
  key: "phone-key",
  name: "Maksim's phone",
  approvedAt: "2026-11-01T10:00:00.000Z",
  safetyCode: "1111-2222",
  lastSeenAt: "2026-11-20T08:30:00.000Z",
  trusted: true,
};

const online = (overrides: Partial<RelayHostStatus> = {}): RelayHostStatus => ({
  connection: "online",
  devices: [phone],
  pending: [],
  trustOtherDevices: false,
  ...overrides,
});

const ok = (value: RelayHostStatus) => ({ _tag: "Success", value });

function setup(status: RelayHostStatus) {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.status.mockResolvedValue(ok(status));
}

describe("RelayHostSettingsSection trust", () => {
  it("keeps trust off until the user turns it on, and shows who it covers", async () => {
    setup(online());
    mocks.setTrust.mockResolvedValue(ok(online({ trustOtherDevices: true })));
    await using screen = await render(<RelayHostSettingsSection />);

    const toggle = screen.getByRole("switch", { name: "Trust my other devices" });
    await expect.element(toggle).not.toBeChecked();
    // Off: the device is listed with when it last connected, but not marked trusted.
    await expect.element(screen.getByText(/Last seen/)).toBeInTheDocument();
    await expect.element(screen.getByText("Trusted")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    await expect.element(toggle).toBeChecked();
    expect(mocks.setTrust).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { enabled: true },
    });
    await expect.element(screen.getByText("Trusted")).toBeInTheDocument();
  });

  it("shows an account request with its safety code and revokes a device on demand", async () => {
    setup(
      online({
        trustOtherDevices: true,
        pending: [
          {
            id: "pending-1",
            name: "Pixel",
            requestedAt: "2026-11-25T09:00:00.000Z",
            safetyCode: "4821-7730",
            viaAccount: true,
          },
        ],
      }),
    );
    mocks.decide.mockResolvedValue(ok(online({ trustOtherDevices: true })));
    mocks.revokeDevice.mockResolvedValue(ok(online({ devices: [], trustOtherDevices: true })));
    await using screen = await render(<RelayHostSettingsSection />);

    await expect
      .element(screen.getByText("Allow “Pixel” to connect from your account?"))
      .toBeInTheDocument();
    await expect.element(screen.getByText(/Safety code 4821-7730/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow device" }));
    expect(mocks.decide).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { id: "pending-1", approve: true },
    });

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(mocks.revokeDevice).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { key: "phone-key" },
    });
    await expect.element(screen.getByText("Maksim's phone")).not.toBeInTheDocument();
  });
});
