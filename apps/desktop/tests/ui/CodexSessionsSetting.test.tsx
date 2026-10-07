import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentSettingsSection } from "../../src/components/AgentSettingsSection";
import { renderApp } from "./render";
import { callsOf, mockSettings } from "./tauri";

describe("Settings: read Codex session files to show subagents", () => {
  it("is on by default, explained in a sentence, and the switch stores the setting", async () => {
    mockSettings({});
    renderApp(<AgentSettingsSection />);
    const sw = await screen.findByRole("switch", { name: "Read Codex session files to show subagents" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/reads only the session files of that run/)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    await waitFor(() =>
      expect(
        callsOf("db_execute").some(
          (a: any) =>
            /insert into settings/.test(a.sql) && a.params[0] === "readCodexSessions" && a.params[1] === "false",
        ),
      ).toBe(true),
    );
  });

  it("reads a stored off value", async () => {
    mockSettings({ readCodexSessions: false });
    renderApp(<AgentSettingsSection />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Read Codex session files to show subagents" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
  });
});
