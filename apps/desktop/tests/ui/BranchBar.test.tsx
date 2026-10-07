import { fireEvent, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BranchBar } from "../../src/components/chat/BranchBar";
import { branchChat } from "../../src/lib/data";
import { db } from "../../src/lib/api";
import { chat, makeApp, renderApp } from "./render";

describe("branch lineage", () => {
  it("jumps to the exact source point and opens a sibling", async () => {
    vi.spyOn(db, "select").mockImplementation(async (sql) =>
      sql.includes("chat_branches where")
        ? [{ chat_id: 2, source_chat_id: 1, source_message_id: 17, source_title: "source" }]
        : sql.includes("from chats where")
          ? [chat({ title: "Source" })]
          : sql.includes("from messages")
            ? [{ id: 17 }]
            : [chat({ id: 2 }), chat({ id: 3, title: "Sibling" })],
    );
    const app = makeApp({ chats: [chat({ title: "Source" })] });
    renderApp(<BranchBar chatId={2} />, app);
    fireEvent.click(await screen.findByRole("button", { name: "Branch from Source" }));
    expect(app.openChatAt).toHaveBeenCalledWith(1, 1, 17);
    fireEvent.click(screen.getByRole("button", { name: "Sibling" }));
    expect(app.openChat).toHaveBeenCalledWith(3, 1);
    vi.restoreAllMocks();
  });
  it("keeps a deleted source title but disables its link", async () => {
    vi.spyOn(db, "select").mockImplementation(async (sql) =>
      sql.includes("chat_branches where")
        ? [{ chat_id: 2, source_chat_id: 1, source_message_id: 17, source_title: "Deleted" }]
        : [],
    );
    renderApp(<BranchBar chatId={2} />);
    expect(await screen.findByRole("button", { name: /Deleted.*source unavailable/ })).toBeDisabled();
    vi.restoreAllMocks();
  });
  it("rejects a deleted branch point before creating a chat", async () => {
    vi.spyOn(db, "select").mockImplementation(async (sql) => (sql.includes("from chats") ? [chat()] : []));
    const exec = vi.spyOn(db, "exec");
    await expect(branchChat(1, "Branch", 1, 77)).rejects.toThrow("branch point");
    expect(exec).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("copies only the cutoff, strips native session ids, and records lineage without executing tools", async () => {
    vi.spyOn(db, "select").mockImplementation(async (sql) => (sql.includes("from chats") ? [chat()] : [{ id: 17 }]));
    const exec = vi.spyOn(db, "exec").mockResolvedValue({ lastId: 2, changes: 1 });
    expect(await branchChat(1, "Branch", 1, 17)).toBe(2);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("'$.meta.responseId'"), [2, 1, 17]);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("insert into chat_branches"), [2, 1, 17, "First chat"]);
    expect(exec).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });
});
