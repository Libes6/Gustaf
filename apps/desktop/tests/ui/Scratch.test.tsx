import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { isScratch, scratchRoot } from "../../src/lib/scratch";
import { makeApp, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

it("New scratch chat creates a chat without a project, remembers it and opens it", async () => {
  mockInvoke({ db_execute: [1, 77] });
  const { app } = renderApp(<Sidebar onCreateProject={() => {}} onSearch={() => {}} />, makeApp({ chats: [] })) as any;
  await userEvent.click(screen.getByRole("button", { name: "New scratch chat" }));
  await waitFor(() => expect(app.openChat).toHaveBeenCalledWith(77, null));
  const insert = callsOf("db_execute").find((a) => /insert into chats/.test(a.sql));
  expect(insert.params[0]).toBeNull();
  expect(insert.params[1]).toMatch(/^Scratch /);
  expect(isScratch(77)).toBe(true);
  expect(callsOf("db_execute").some((a) => /settings/.test(a.sql) && a.params.includes("scratchChats"))).toBe(true);
});

it("the folder is asked from the backend once per chat", async () => {
  mockInvoke({
    scratch_dir: ({ chatId, name }: { chatId: number; name: string }) =>
      `/data/scratch/${name.replace(/\W+/g, "-")}-${chatId}`,
  });
  const a = await scratchRoot(91, "Notes");
  expect(a).toMatch(/\/data\/scratch\/\d{4}-\d{2}-\d{2}-Notes-91$/);
  expect(await scratchRoot(91, "Renamed")).toBe(a);
  expect(callsOf("scratch_dir")).toHaveLength(1);
});
