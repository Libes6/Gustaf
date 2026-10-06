import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EffortPicker, levelFraction, stopAt } from "../../src/components/chat/EffortPicker";
import type { Reasoning } from "../../src/providers/types";
import { renderApp } from "./render";

function Harness({ start = "medium" as Reasoning, onOpenModels = vi.fn(), onClose = vi.fn() }) {
  const [value, setValue] = useState<Reasoning>(start);
  return (
    <EffortPicker levels={["low", "medium", "high"]} value={value} defaultValue="medium" onChange={setValue} modelName="Claude Opus 5.5" onOpenModels={onOpenModels} onClose={onClose} />
  );
}

describe("EffortPicker", () => {
  it("maps levels to track positions and pointer positions to the nearest stop", () => {
    expect([0, 1, 2].map((i) => levelFraction(i, 3))).toEqual([0, 0.5, 1]);
    expect(levelFraction(0, 1)).toBe(1);
    expect(stopAt(-0.2, 3)).toBe(0);
    expect(stopAt(0.24, 3)).toBe(0);
    expect(stopAt(0.26, 3)).toBe(1);
    expect(stopAt(0.9, 3)).toBe(2);
    expect(stopAt(1.5, 3)).toBe(2);
  });

  it("is a labelled slider that moves by arrow keys, Home and End, and clamps at the ends", () => {
    renderApp(<Harness />);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(slider).toHaveAttribute("aria-valuemax", "2");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider).toHaveAttribute("aria-valuenow", "0");
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    expect(slider.className).toContain("top");
  });

  it("reset returns to the default and is disabled while the default is selected", async () => {
    renderApp(<Harness start="high" />);
    const reset = screen.getByRole("button", { name: "Reset to default" });
    await userEvent.click(reset);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Medium");
    expect(reset).toBeDisabled();
  });

  it("the model name opens the model list and Escape closes", async () => {
    const onOpenModels = vi.fn();
    const onClose = vi.fn();
    renderApp(<Harness onOpenModels={onOpenModels} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /Claude Opus 5.5/ }));
    expect(onOpenModels).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("uses Russian level names", () => {
    renderApp(<Harness start="low" />, undefined, "ru");
    expect(screen.getByRole("slider", { name: "Уровень рассуждений" })).toHaveAttribute("aria-valuetext", "Лёгкое");
  });
});
