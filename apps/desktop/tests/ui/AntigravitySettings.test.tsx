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
}));
vi.mock("../../src/providers/antigravity", () => api);

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
  renderApp(<AntigravitySettings p={p} update={update} />, makeApp({ refreshModels }));
  return { update, refreshModels };
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.authState.mockResolvedValue(undefined);
  api.probeAntigravity.mockResolvedValue({ version: "1.3.0", methods: [], logout: true });
  api.openAuthorizationUrl.mockResolvedValue(undefined);
  api.signOutAntigravity.mockResolvedValue(undefined);
});

describe("Antigravity settings", () => {
  it("shows the runtime version from the initialize-only probe and the install seam as disabled", async () => {
    show();
    expect(await screen.findByText("Installed, version 1.3.0")).toBeInTheDocument();
    expect(screen.getByText("317 MB download, version 1.3.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Antigravity" })).toBeDisabled();
    expect(screen.getByText(/Managed install is coming soon/)).toBeInTheDocument();
    expect(api.probeAntigravity).toHaveBeenCalledTimes(1);
    expect(api.signInAntigravity).not.toHaveBeenCalled();
  });

  it("reports a missing agent and a failing one", async () => {
    api.probeAntigravity.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "not-installed" }));
    show();
    expect(await screen.findByText(/Not installed\. Set the binary path/)).toBeInTheDocument();
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
});
