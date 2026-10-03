import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { Menu, useMenu } from "../../src/components/Menu";
import { renderApp } from "./render";

describe("floating menus", () => {
  function FocusHarness({ selected = false }: { selected?: boolean }) {
    const menu = useMenu();
    return <><button onKeyDown={menu.onTriggerKeyDown} onClick={e => menu.open(e.currentTarget.getBoundingClientRect(), [{ label: "Usage", onClick() {} }, { label: "Plan", checked: selected, onClick() {} }])}>Account</button>{menu.node}</>;
  }
  it("mouse opening focuses the container, not Usage, and Escape restores the trigger", async () => {
    renderApp(<FocusHarness />);
    const trigger = screen.getByRole("button", { name: "Account" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu")).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Usage" })).not.toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Usage" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
  it.each(["{Enter}", " ", "{ArrowDown}", "{ArrowUp}"])("keyboard %s focuses the selected item", async key => {
    renderApp(<FocusHarness selected />);
    screen.getByRole("button", { name: "Account" }).focus();
    await userEvent.keyboard(key);
    expect(screen.getByRole("menuitemradio", { name: /^Plan/ })).toHaveFocus();
  });
  it("keyboard opening without a selected item focuses the first", async () => {
    renderApp(<FocusHarness />);
    screen.getByRole("button", { name: "Account" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Usage" })).toHaveFocus();
  });

  it("flips above an anchor at the bottom and clamps negative positions", () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 220, height: 200 } as DOMRect);
    renderApp(<Menu at={{ x: -20, y: innerHeight, top: innerHeight - 30 }} items={[{ label: "Settings", onClick() {} }]} onClose={() => {}} />);
    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe(`${innerHeight - 238}px`);
    measure.mockRestore();
  });
  it("closes outside when opening without focusing the trigger", () => {
    function Harness() {
      const menu = useMenu();
      return <><button onClick={e => menu.open(e.currentTarget.getBoundingClientRect(), [{ label: "Item", onClick() {} }])}>Open</button>{menu.node}</>;
    }
    renderApp(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("opens settings after closing and leaves no stale outside-click handler", async () => {
    function Harness() {
      const menu = useMenu();
      const [settings, setSettings] = useState(false);
      return <><button onClick={e => menu.open(e.currentTarget.getBoundingClientRect(), [{ label: "Settings", onClick: () => setSettings(true) }])}>Account</button>{menu.node}{settings && <button onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>Setting field</button>}</>;
    }
    renderApp(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Setting field" }));
    expect(screen.getByRole("button", { name: "Setting field" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Setting field" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
