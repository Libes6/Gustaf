import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingRow, SettingsSection } from "../../src/components/SettingRow";
import { renderApp } from "./render";

describe("SettingRow", () => {
  it("shows title and description on the left and the control in its own wrapper", () => {
    renderApp(<SettingRow id="x" title="Title" description="About it"><button>Go</button></SettingRow>);
    const row = screen.getByText("Title").closest(".setting-row") as HTMLElement;
    expect(row).toHaveAttribute("data-setting", "x");
    expect(row.querySelector(".setting-text")).toHaveTextContent("TitleAbout it");
    expect(row.querySelector(".setting-control")).toContainElement(screen.getByRole("button", { name: "Go" }));
  });

  it("the toggle is a switch named by the title and reports the new value", async () => {
    const onChange = vi.fn();
    renderApp(<SettingRow title="Do the thing" toggle={{ on: false, onChange }} />);
    const sw = screen.getByRole("switch", { name: "Do the thing" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("two rows get different label ids", () => {
    renderApp(<SettingsSection title="Block" description="Why"><SettingRow title="A" toggle={{ on: true, onChange: () => {} }} /><SettingRow title="B" toggle={{ on: false, onChange: () => {} }} /></SettingsSection>);
    expect(screen.getByRole("switch", { name: "A" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "B" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Why")).toHaveClass("h4-sub");
  });

});
