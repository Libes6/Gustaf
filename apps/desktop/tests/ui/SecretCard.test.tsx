import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SecretCard } from "../../src/components/chat/SecretCard";
import { renderApp } from "./render";

it("the secret is typed into a password field and handed over only on Provide; Decline gives null", async () => {
  const resolve = vi.fn();
  renderApp(<SecretCard request={{ name: "GitHub token", reason: "push the branch", resolve }} />);
  expect(screen.getByRole("dialog", { name: "The agent asks for GitHub token" })).toHaveTextContent("push the branch");
  const field = screen.getByLabelText("Secret value");
  expect(field).toHaveAttribute("type", "password");
  expect(field).toHaveAttribute("autocomplete", "off");
  expect(screen.getByRole("button", { name: "Provide" })).toBeDisabled();
  await userEvent.type(field, "ghp_x");
  await userEvent.click(screen.getByRole("button", { name: "Provide" }));
  expect(resolve).toHaveBeenCalledWith("ghp_x");
  await userEvent.click(screen.getByRole("button", { name: "Decline" }));
  expect(resolve).toHaveBeenLastCalledWith(null);
});
