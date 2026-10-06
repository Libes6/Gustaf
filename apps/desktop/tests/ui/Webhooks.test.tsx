import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WebhooksSection } from "../../src/components/WebhooksSection";
import type { ScheduledPrompt } from "../../src/lib/scheduledPrompts";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const runNow = vi.fn(() => true);
vi.mock("../../src/lib/scheduledRuntime", () => ({ getRunner: () => ({ runNow }) }));
const sched = vi.hoisted(() => ({ list: [] as ScheduledPrompt[] }));
vi.mock("../../src/lib/scheduledPromptsStore", () => ({ getScheduled: () => sched.list, subscribeScheduled: () => () => {} }));
const hooks = await import("../../src/lib/webhooks");

const sc = (over: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({ id: "nightly", title: "Nightly triage", prompt: "Triage new issues.", projectId: null, providerId: "p1", model: "m", access: "auto", schedule: { kind: "daily", time: "09:00" }, enabled: true, confirmedAt: 1, createdAt: 1, ...over });

describe("webhook triggers", () => {
  it("switching a hook on starts the server with its secret and shows URL, secret and rotate", async () => {
    sched.list = [sc()];
    mockInvoke({ webhook_serve: 47820 });
    renderApp(<WebhooksSection list={sched.list} />);
    await userEvent.click(screen.getByRole("switch", { name: "Webhook for Nightly triage" }));
    await vi.waitFor(() => expect(callsOf("webhook_serve")).toHaveLength(1));
    const [{ port, hooks: served }] = callsOf("webhook_serve");
    expect(port).toBe(47820);
    expect(served).toEqual([{ id: "nightly", secret: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(screen.getByText("http://127.0.0.1:47820/hooks/nightly")).toBeInTheDocument();
    expect(await screen.findByText("Listening on 127.0.0.1:47820")).toBeInTheDocument();
    const before = hooks.getWebhookConfig().hooks.nightly.secret;
    await userEvent.click(screen.getByRole("button", { name: /Rotate/ }));
    expect(hooks.getWebhookConfig().hooks.nightly.secret).not.toBe(before);
  });

  it("a signed delivery runs the schedule with the payload fenced; rejected ones and switched-off schedules do not run", () => {
    sched.list = [sc()];
    act(() => hooks.onDelivery({ id: "nightly", at: 5, status: 202, event: "issues", delivery: "d1", preview: '{"n":1}' }));
    expect(runNow).toHaveBeenCalledWith("nightly", expect.stringContaining("<webhook_payload>\n{\"n\":1}\n</webhook_payload>"));
    runNow.mockClear();
    act(() => hooks.onDelivery({ id: "nightly", at: 6, status: 401, event: "", delivery: "", preview: "" }));
    sched.list = [sc({ enabled: false })];
    act(() => hooks.onDelivery({ id: "nightly", at: 7, status: 202, event: "", delivery: "", preview: "" }));
    expect(runNow).not.toHaveBeenCalled();
    expect(hooks.getDeliveries("nightly").map((d) => d.outcome)).toEqual(["off", "rejected", "started"]);
  });
});
