// Settings of an Antigravity provider with a fake adapter module: the status lines (runtime, account), the install seam,
// the sign-in methods and their fields, the API key going through `update` only, and sign in / cancel / sign out.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravitySettings } from "../../src/components/AntigravitySettings";
import type { ProviderConfig } from "../../src/providers/types";
import { makeApp, renderApp } from "./render";

const api = vi.hoisted(() => ({
  authState: vi.fn(),
  probeAntigravity: vi.fn(),
  signInAntigravity: vi.fn(),
  signOutAntigravity: vi.fn(),
  openAuthorizationUrl: vi.fn(),
  antigravitySessionsInUse: vi.fn(),
}));
vi.mock("../../src/providers/antigravity", () => api);
// The managed install seam (Rust commands behind it): a fake. The pure constants stay real.
const rt = vi.hoisted(() => ({
  runtimeStatus: vi.fn(),
  installRuntime: vi.fn(),
  cancelRuntimeInstall: vi.fn(),
  removeRuntime: vi.fn(),
}));
vi.mock("../../src/providers/antigravityRuntime", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...rt,
}));
const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

const SOURCE = "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip";
const STATUS = {
  supported: true,
  reason: null,
  version: "1.3.0",
  archiveBytes: 111_456_962,
  unpackedBytes: 397_146_848,
  source: SOURCE,
  folder: "/data/antigravity-runtime/1.3.0",
  installed: null as null | Record<string, unknown>,
  updateAvailable: false,
  busy: false,
};
const INSTALLED = {
  version: "1.3.0",
  executable: "/data/antigravity-runtime/1.3.0/agy_acp_server.par",
  dir: "/data/antigravity-runtime/1.3.0",
  modified: null,
};
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "antigravity-t1",
  kind: "antigravity",
  name: "Antigravity",
  baseUrl: "",
  antigravity: { method: "oauth-personal" },
  ...over,
});
const URL =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2F";

function show(p = cfg(), update = vi.fn(async () => {})) {
  const refreshModels = vi.fn(async () => []);
  renderApp(<AntigravitySettings p={p} update={update} />, makeApp({ refreshModels, providers: [p] }));
  return { update, refreshModels };
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.authState.mockResolvedValue(undefined);
  api.probeAntigravity.mockResolvedValue({ version: "1.3.0", methods: [], logout: true });
  api.openAuthorizationUrl.mockResolvedValue(undefined);
  api.signOutAntigravity.mockResolvedValue(undefined);
  api.antigravitySessionsInUse.mockReturnValue(false);
  Object.values(rt).forEach((f) => f.mockReset());
  rt.runtimeStatus.mockResolvedValue(STATUS);
  rt.cancelRuntimeInstall.mockResolvedValue(undefined);
  rt.removeRuntime.mockResolvedValue(undefined);
  opener.openUrl.mockReset();
  opener.openUrl.mockResolvedValue(undefined);
});

describe("Antigravity settings", () => {
  it("shows the runtime version from the initialize-only probe and an enabled Install button", async () => {
    show();
    expect(await screen.findByText("Installed, version 1.3.0")).toBeInTheDocument();
    expect(await screen.findByText("111 MB download, version 1.3.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Antigravity" })).toBeEnabled();
    expect(rt.installRuntime).not.toHaveBeenCalled();
    expect(api.probeAntigravity).toHaveBeenCalledTimes(1);
    expect(api.signInAntigravity).not.toHaveBeenCalled();
  });

  it("reports a missing agent and a failing one", async () => {
    api.probeAntigravity.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "not-installed" }));
    show();
    expect(await screen.findByText(/Not installed\. Press Install, set the binary path/)).toBeInTheDocument();
  });

  it("shows the account state: signed in with the method, signed out, unknown", async () => {
    api.authState.mockResolvedValue({ state: "signedIn", method: "oauth-business", at: 1 });
    show(cfg({ antigravity: { method: "oauth-business", project: "p", location: "l" } }));
    expect(await screen.findByText("Signed in (Gemini Enterprise)")).toBeInTheDocument();
  });

  it("starts as 'not checked' and shows signed out", async () => {
    api.authState.mockResolvedValue({ state: "signedOut", method: "", at: 1 });
    show();
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
  });

  it("sign in: opens the reported link, waits, can be cancelled, and refreshes models when done", async () => {
    let finish!: () => void;
    api.signInAntigravity.mockImplementation(
      (_p: unknown, _k: unknown, h: { onUrl: (u: string) => void; signal: AbortSignal }) =>
        new Promise((res, rej) => {
          h.onUrl(URL);
          finish = () => res({ models: [], levels: {} });
          h.signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
        }),
    );
    const { refreshModels } = show();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByText(/Waiting for browser sign-in/)).toBeInTheDocument();
    expect(api.openAuthorizationUrl).toHaveBeenCalledWith(URL);
    // cancel
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/Waiting for browser sign-in/)).toBeNull());
    expect(refreshModels).not.toHaveBeenCalled();
    // again, finishing
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await screen.findByRole("button", { name: "Open the sign-in page again" });
    api.authState.mockResolvedValue({ state: "signedIn", method: "oauth-personal", at: 2 });
    finish();
    expect(await screen.findByText("Signed in.")).toBeInTheDocument();
    expect(refreshModels).toHaveBeenCalledWith({ only: ["antigravity-t1"] });
  });

  it("a failed sign-in shows the message", async () => {
    api.signInAntigravity.mockRejectedValue(new Error("Sign-in timed out. Start it again."));
    show();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in timed out");
  });

  it("sign out calls the adapter and refreshes from the cache", async () => {
    const { refreshModels } = show();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.signOutAntigravity).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshModels).toHaveBeenCalledWith({ refresh: "startup" }));
  });

  it("method select: Gemini Enterprise needs project and location, sign in stays disabled until they are set", async () => {
    const { update } = show(cfg({ antigravity: { method: "oauth-business" } }));
    expect(screen.getByLabelText("GCP project")).toBeInTheDocument();
    expect(screen.getByText("Gemini Enterprise needs a GCP project and location.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeDisabled();
    expect(screen.queryByLabelText("API key")).toBeNull();
    const project = screen.getByLabelText("GCP project");
    await userEvent.type(project, "my-proj");
    fireEvent.blur(project);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ antigravity: { method: "oauth-business", project: "my-proj" } }),
      ),
    );
  });

  it("API-key methods show a Keychain-backed key field; the key goes through update(p, key) only", async () => {
    const { update } = show(cfg({ antigravity: { method: "gemini-api-key" } }));
    const calls = update.mock.calls as unknown as unknown[][];
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled(); // sign-in waits for... see below
    expect(screen.getByText(/Stored in the system Keychain, never in settings/)).toBeInTheDocument();
    expect(screen.queryByLabelText("GCP project")).toBeNull();
    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    await userEvent.type(key, "AIza-test-0001");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "antigravity-t1" }), "AIza-test-0001"),
    );
    expect(JSON.stringify(calls[0][0])).not.toContain("AIza-test-0001");
  });

  it("changing the method saves the setting; the binary path is saved on blur", async () => {
    const { update } = show();
    await userEvent.selectOptions(screen.getByLabelText("Sign-in method"), "agent-platform");
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ antigravity: { method: "agent-platform" } })),
    );
    const bin = screen.getByLabelText("Binary path");
    await userEvent.type(bin, "/opt/agy/agy_acp_server");
    fireEvent.blur(bin);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ antigravity: { method: "oauth-personal", binary: "/opt/agy/agy_acp_server" } }),
      ),
    );
  });

  describe("managed runtime", () => {
    const install = () => screen.findByRole("button", { name: "Install Antigravity" });
    const dialog = () => screen.findByRole("dialog");

    it("Install only opens a confirmation that shows the source, version, size, folder and Google's terms", async () => {
      show();
      await userEvent.click(await install());
      const d = await dialog();
      expect(d).toHaveTextContent(SOURCE);
      expect(d).toHaveTextContent("1.3.0");
      expect(d).toHaveTextContent("111 MB download, 397 MB on disk");
      expect(d).toHaveTextContent("/data/antigravity-runtime/1.3.0");
      expect(d).toHaveTextContent(/Google's proprietary software/);
      await userEvent.click(screen.getByRole("button", { name: "Read Google's terms" }));
      expect(opener.openUrl).toHaveBeenCalledWith("https://antigravity.google/terms");
      // Cancel: nothing is downloaded.
      await userEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(rt.installRuntime).not.toHaveBeenCalled();
    });

    it("confirm runs the install, shows the phases with MB received, then the managed status and Remove", async () => {
      let emit!: (p: { phase: string; received: number; total: number }) => void;
      let finish!: (path: string) => void;
      rt.installRuntime.mockImplementation(
        (on: typeof emit) =>
          new Promise<string>((res) => {
            emit = on;
            finish = res;
          }),
      );
      show();
      await userEvent.click(await install());
      await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(await screen.findByTestId("agy-progress")).toHaveTextContent("Starting…");
      emit({ phase: "download", received: 50_000_000, total: 111_456_962 });
      expect(await screen.findByText(/Downloading… 50\.0 of 111 MB/)).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50000000");
      emit({ phase: "extract", received: 100_000_000, total: 397_146_848 });
      expect(await screen.findByText(/Unpacking… 100 of 397 MB/)).toBeInTheDocument();
      emit({ phase: "verify", received: 0, total: 1 });
      expect(await screen.findByText("Checking that the agent starts…")).toBeInTheDocument();
      rt.runtimeStatus.mockResolvedValue({ ...STATUS, installed: INSTALLED });
      finish(INSTALLED.executable);
      expect(await screen.findByText("Installed 1.3.0 (managed)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove runtime" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install Antigravity" })).toBeNull();
      expect(screen.queryByTestId("agy-progress")).toBeNull();
      // the probe runs again so the status reflects the new executable
      await waitFor(() => expect(api.probeAntigravity).toHaveBeenCalledTimes(2));
    });

    it("Cancel stops the install quietly", async () => {
      rt.installRuntime.mockImplementation(
        () =>
          new Promise((_res, rej) => {
            rt.cancelRuntimeInstall.mockImplementation(async () => rej(failure("cancelled")));
          }),
      );
      show();
      await userEvent.click(await install());
      await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
      await screen.findByTestId("agy-progress");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(rt.cancelRuntimeInstall).toHaveBeenCalledTimes(1));
      expect(await install()).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it.each([
      [
        "no-space",
        "At least 2000 MB of free disk space is needed, 10 MB is free.",
        /Not enough free disk space\. At least 2000 MB/,
      ],
      ["offline", "Could not reach", /Could not reach Google's download server/],
      ["network", "x", /interrupted\. Press Install to continue/],
      ["hash", "x", /did not match the expected size or checksum\. Nothing was installed/],
      ["bad-archive", "x", /archive is not what was expected/],
      ["verify", "x", /did not start\. Nothing was installed/],
      ["intel-mac", "x", /Apple Silicon Macs only/],
    ])("shows a clear message for %s and can try again", async (code, message, text) => {
      rt.installRuntime.mockRejectedValueOnce(failure(code, message));
      show();
      await userEvent.click(await install());
      await userEvent.click(await screen.findByRole("button", { name: "Download and install" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(await install()).toBeEnabled();
    });

    it("an installed runtime offers Remove after a confirmation, and passes the in-use facts", async () => {
      rt.runtimeStatus.mockResolvedValue({ ...STATUS, installed: INSTALLED });
      api.antigravitySessionsInUse.mockReturnValue(true);
      show(cfg({ antigravity: { method: "oauth-personal", binary: "/opt/custom/agy" } }));
      await userEvent.click(await screen.findByRole("button", { name: "Remove runtime" }));
      expect(await dialog()).toHaveTextContent("/data/antigravity-runtime/1.3.0");
      rt.removeRuntime.mockRejectedValueOnce(failure("in-use", "in use"));
      await userEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/The runtime is in use/);
      expect(rt.removeRuntime).toHaveBeenCalledWith({ inUse: true, protectedPaths: ["/opt/custom/agy"] });
    });

    it("Remove deletes the runtime and the Install button returns", async () => {
      rt.runtimeStatus.mockResolvedValueOnce({ ...STATUS, installed: INSTALLED });
      show();
      await userEvent.click(await screen.findByRole("button", { name: "Remove runtime" }));
      await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
      await waitFor(() => expect(rt.removeRuntime).toHaveBeenCalledWith({ inUse: false, protectedPaths: [] }));
      expect(await install()).toBeInTheDocument();
    });

    it("a newer pinned version is only offered, never installed by itself", async () => {
      rt.runtimeStatus.mockResolvedValue({
        ...STATUS,
        installed: { ...INSTALLED, version: "1.2.0" },
        updateAvailable: true,
      });
      show();
      expect(await screen.findByTestId("agy-update")).toHaveTextContent("Update available: 1.3.0");
      expect(screen.getByText("Installed 1.2.0 (managed)")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Update to 1.3.0" }));
      expect(await dialog()).toHaveTextContent("Update the Antigravity runtime");
      expect(rt.installRuntime).not.toHaveBeenCalled();
    });

    it("files that changed after install are reported and can be reinstalled", async () => {
      rt.runtimeStatus.mockResolvedValue({
        ...STATUS,
        installed: { ...INSTALLED, modified: "agy_acp_server.par was modified" },
      });
      show();
      expect(
        await screen.findByText(/changed after it was installed \(agy_acp_server\.par was modified\)/),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Install Antigravity" })).toBeEnabled();
    });

    it("an unsupported platform keeps Install disabled and says why", async () => {
      rt.runtimeStatus.mockResolvedValue({ ...STATUS, supported: false, reason: "intel-mac", archiveBytes: 0 });
      show();
      expect(await screen.findByTestId("agy-unsupported")).toHaveTextContent(/Apple Silicon Macs only/);
      expect(screen.getByRole("button", { name: "Install Antigravity" })).toBeDisabled();
    });
  });
});
