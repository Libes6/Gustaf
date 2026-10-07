import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BranchPicker } from "../../src/components/chat/BranchPicker";
import { makeApp, provider, renderApp } from "./render";

it("requires explicit selection and passes that model without starting a run", async () => {
  const create = vi.fn(async () => {});
  const app = makeApp({ providers: [provider()], models: [{ providerId: "p1", id: "m1", name: "Model" }] });
  renderApp(<BranchPicker busy={false} onCancel={() => {}} onCreate={create} />, app);
  const button = screen.getByRole("button", { name: "branch" });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: JSON.stringify({ providerId: "p1", model: "m1" }) },
  });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(create).toHaveBeenCalledWith({ providerId: "p1", model: "m1" });
  expect(app.setSelection).not.toHaveBeenCalled();
});
it("cancel never changes the current provider/model", () => {
  const cancel = vi.fn();
  const app = makeApp();
  renderApp(<BranchPicker busy={false} onCancel={cancel} onCreate={vi.fn()} />, app);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(app.setSelection).not.toHaveBeenCalled();
});
