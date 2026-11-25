import { AsyncResult } from "effect/reactivity";
import { RelayTunnelClientError } from "@t3tools/shared/relayTunnelClient";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  relay: {
    computers: vi.fn(),
    pairWithComputer: vi.fn(),
    pair: vi.fn(),
  },
  connectPairing: vi.fn(),
}));

// The panel only needs these three modules; the real ones pull in the whole connection runtime.
vi.mock(import("../../relay/desktopRelay"), async () => ({ desktopRelay: mocks.relay as never }));
vi.mock(import("../../state/use-atom-command"), async () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async () => ({
  connectPairing: mocks.connectPairing as never,
}));

import { RelayPairingPanel } from "./RelayPairingPanel";

const laptop = { deviceId: "laptop", name: "Laptop", online: true };
const desktop = { deviceId: "desktop", name: "Old desktop", online: false };

function setup(result: unknown) {
  mocks.relay.computers.mockReset().mockResolvedValue(result);
  mocks.relay.pairWithComputer.mockReset();
  mocks.relay.pair.mockReset();
  mocks.connectPairing.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return { onPaired: vi.fn() };
}

const panel = (onPaired: () => void) => (
  <RelayPairingPanel routeTarget={null} savedEnvironments={[]} onPaired={onPaired} />
);

describe("RelayPairingPanel", () => {
  it("offers the account's computers first and keeps the relay link as a fallback", async () => {
    const { onPaired } = setup({ computers: [desktop, laptop] });
    await using screen = await render(panel(onPaired));

    await expect.element(screen.getByText("Laptop")).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Connect to Laptop" })).toBeEnabled();
    // An offline computer cannot be reached, so its button stays off.
    await expect
      .element(screen.getByRole("button", { name: "Connect to Old desktop" }))
      .toBeDisabled();
    await expect.element(screen.getByPlaceholder("gustaf://relay-pair?…")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Paste a relay link instead" }));
    await expect.element(screen.getByPlaceholder("gustaf://relay-pair?…")).toBeInTheDocument();
  });

  it("shows the safety code while the computer waits for its user, and cancel ends it", async () => {
    const { onPaired } = setup({ computers: [laptop] });
    const asked = Promise.withResolvers<void>();
    mocks.relay.pairWithComputer.mockImplementation(
      (_computer: unknown, onPending: (code: string) => void, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          onPending("4821-7730");
          asked.resolve();
          signal.addEventListener("abort", () =>
            reject(new RelayTunnelClientError("closed", "cancelled")),
          );
        }),
    );
    await using screen = await render(panel(onPaired));

    await userEvent.click(screen.getByRole("button", { name: "Connect to Laptop" }));
    await asked.promise;
    await expect.element(screen.getByText("4821-7730", { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Connect to Laptop" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect.element(screen.getByText("4821-7730", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Connect to Laptop" })).toBeEnabled();
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("pairs through the computer's relay address once its user allowed it", async () => {
    const { onPaired } = setup({ computers: [laptop] });
    mocks.relay.pairWithComputer.mockResolvedValue(
      "https://laptop.relay.gustaf.invalid/pair#token=T",
    );
    await using screen = await render(panel(onPaired));

    await userEvent.click(screen.getByRole("button", { name: "Connect to Laptop" }));
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(mocks.connectPairing).toHaveBeenCalledWith({
      pairingUrl: "https://laptop.relay.gustaf.invalid/pair#token=T",
    });
  });

  it("says why a computer refused, in words naming it", async () => {
    const { onPaired } = setup({ computers: [laptop] });
    mocks.relay.pairWithComputer.mockRejectedValue(
      new RelayTunnelClientError("unknown_device", "raw"),
    );
    await using screen = await render(panel(onPaired));

    await userEvent.click(screen.getByRole("button", { name: "Connect to Laptop" }));
    await expect
      .element(screen.getByText(/Laptop runs a Gustaf version that cannot pair/))
      .toBeInTheDocument();
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("asks a signed-out device to sign in and shows the link form straight away", async () => {
    const { onPaired } = setup({ computers: [], problem: "signed_out" });
    await using screen = await render(panel(onPaired));

    await expect
      .element(screen.getByText(/Sign in and register this computer under Settings → Account/))
      .toBeInTheDocument();
    await expect.element(screen.getByPlaceholder("gustaf://relay-pair?…")).toBeInTheDocument();
  });
});
