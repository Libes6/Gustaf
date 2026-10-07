import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileSettings } from "../../src/components/MobileSettings";
import type { MobileDevice, MobileStatus } from "../../src/lib/mobileServer";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const FP = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** A tiny stand-in for the Rust server state machine. */
function fakeServer(initial: Partial<MobileStatus> = {}, devices: MobileDevice[] = []) {
  let s: MobileStatus = {
    enabled: false,
    running: false,
    host: null,
    port: null,
    savedPort: 0,
    fingerprint: null,
    protocol: 1,
    devices: devices.length,
    pairing: null,
    error: null,
    ...initial,
  };
  let list = devices;
  mockInvoke({
    mobile_server_status: () => s,
    mobile_devices: () => list,
    mobile_server_start: (a: { port: number | null }) =>
      (s = {
        ...s,
        enabled: true,
        running: true,
        host: "192.168.1.20",
        port: a.port || 51234,
        savedPort: a.port || 51234,
        fingerprint: FP,
      }),
    mobile_server_stop: () =>
      (s = { ...s, enabled: false, running: false, host: null, port: null, fingerprint: null, pairing: null }),
    mobile_pairing_start: () => (s = { ...s, pairing: { code: "K7Q2X9PM", expiresAt: Date.now() + 120_000 } }),
    mobile_pairing_cancel: () => (s = { ...s, pairing: null }),
    mobile_device_revoke: (a: { id: string }) => {
      list = list.filter((d) => d.id !== a.id);
      return true;
    },
  });
}

const device = (over: Partial<MobileDevice> = {}): MobileDevice => ({
  id: "d1",
  name: "Pixel 9",
  createdAt: 1_700_000_000_000,
  lastSeenAt: null,
  ...over,
});

describe("MobileSettings", () => {
  it("is off by default, warns about the LAN, and the switch starts and stops the server", async () => {
    fakeServer();
    renderApp(<MobileSettings />);
    const sw = await screen.findByRole("switch", { name: "Mobile companion server" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("note")).toHaveTextContent(/opens a port on your local network/);
    expect(screen.queryByRole("heading", { name: "Pair a phone" })).not.toBeInTheDocument();
    expect(callsOf("mobile_server_start")).toHaveLength(0);

    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(callsOf("mobile_server_start")).toEqual([{ port: null }]);
    expect(await screen.findByText("Listening on 192.168.1.20:51234 (local network only)")).toBeInTheDocument();
    expect(
      screen.getByText("a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90 a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pair a phone" })).toBeInTheDocument();

    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(callsOf("mobile_server_stop")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Pair a phone" })).not.toBeInTheDocument();
  });

  it("passes the port the user typed", async () => {
    fakeServer();
    renderApp(<MobileSettings />);
    const input = await screen.findByLabelText(/^Port/);
    fireEvent.change(input, { target: { value: "8443abc" } });
    expect(input).toHaveValue("8443");
    fireEvent.click(screen.getByRole("switch", { name: "Mobile companion server" }));
    await waitFor(() => expect(callsOf("mobile_server_start")).toEqual([{ port: 8443 }]));
    await waitFor(() => expect(input).toBeDisabled());
  });

  it("shows a QR, the code and a countdown only while a code is active", async () => {
    fakeServer({ running: true, enabled: true, host: "192.168.1.20", port: 51234, savedPort: 51234, fingerprint: FP });
    renderApp(<MobileSettings />);
    expect(await screen.findByText("No pairing code is active.")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Pairing QR code" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show pairing QR" }));
    const qr = await screen.findByRole("img", { name: "Pairing QR code" });
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h\d+v1h/);
    expect(screen.getByTestId("pair-code")).toHaveTextContent("K7Q2-X9PM");
    expect(screen.getByRole("timer")).toHaveTextContent(/Expires in [12]:\d\d/);

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Pairing QR code" })).not.toBeInTheDocument());
    expect(screen.queryByTestId("pair-code")).not.toBeInTheDocument();
  });

  it("an expired code is not shown", async () => {
    fakeServer({
      running: true,
      enabled: true,
      host: "192.168.1.20",
      port: 51234,
      fingerprint: FP,
      pairing: { code: "K7Q2X9PM", expiresAt: Date.now() - 1000 },
    });
    renderApp(<MobileSettings />);
    expect(await screen.findByText("The code expired. Show a new one to pair.")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-code")).not.toBeInTheDocument();
  });

  it("lists paired devices with last seen and revokes one", async () => {
    fakeServer({}, [device(), device({ id: "d2", name: "iPhone", lastSeenAt: 1_700_000_100_000 })]);
    renderApp(<MobileSettings />);
    expect(await screen.findByText("Pixel 9")).toBeInTheDocument();
    expect(screen.getByText(/never seen/)).toBeInTheDocument();
    expect(screen.getByText(/last seen/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Pixel 9" }));
    await waitFor(() => expect(callsOf("mobile_device_revoke")).toEqual([{ id: "d1" }]));
    await waitFor(() => expect(screen.queryByText("Pixel 9")).not.toBeInTheDocument());
    expect(screen.getByText("iPhone")).toBeInTheDocument();
  });

  it("shows the empty state and a start error", async () => {
    fakeServer();
    mockInvoke({
      mobile_server_start: () =>
        Promise.reject("no private LAN address found; connect to a Wi-Fi or Ethernet network first"),
    });
    renderApp(<MobileSettings />);
    expect(await screen.findByText("No phone is paired.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Mobile companion server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no private LAN address found");
    expect(screen.getByRole("switch", { name: "Mobile companion server" })).toHaveAttribute("aria-checked", "false");
  });
});
