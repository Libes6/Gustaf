# Model providers

Settings, Model providers is a two-pane page (`apps/desktop/src/components/ProvidersPage.tsx`).

## Left column

- Four drivers are pinned at the top in this order and always shown, even when nothing is configured: **Claude** (Anthropic API key and/or the Claude Code CLI), **GPT / Codex** (OpenAI API and/or the Codex CLI), **Cursor** (Cursor Agent CLI accounts, Cursor SDK) and **Grok** (xAI). Every other provider (OpenRouter, Gemini, Ollama, LM Studio, custom OpenAI-compatible endpoints) follows in its saved order. Grouping is derived from the saved configs (`providers/drivers.ts`); nothing is migrated or rewritten.
- Each configured instance is its own row (two Cursor accounts are two rows in the Cursor group): icon, name, CLI version when the CLI was detected, a status line and an on/off switch (the provider's `disabled` flag).
- Status comes from cached data only, so opening the page sends no request and reads no Keychain item: **Authenticated** (last check succeeded; with the subscription plan when the CLI reported one, else the model count), **Not authenticated** (the last check failed with a sign-in error), **Unavailable** (the last check or model listing failed, with the error), **Disabled**, or **Not checked**.
- A pinned driver with no instance shows "Not set up · Connect"; its right pane explains the options, offers to connect the detected CLI and opens the wizard for that driver.
- The button at the top right ("Checked N min ago") refreshes every provider's model list; "+" opens the wizard.

## Right pane

Display name, sign-in check ("Check sign-in" sends one short test request), runtime (the CLI command, or base URL and API key: a new key goes to the Keychain through the usual save path), the Cursor accounts and pool section for Cursor, and the model list (search, favourites, show/hide, "Refresh models" for this provider only). The header has Duplicate (new id, no key copied; not offered for browser-login Cursor accounts, which own a profile folder) and Delete.

Only fields that exist in the provider config are shown: there is no per-provider binary path, home directory, launch arguments or environment variables yet.

## Add provider wizard

Three steps (`AddProviderDialog.tsx`, also used by onboarding):

1. **Driver**: Claude, Codex / OpenAI, Cursor, Grok, OpenRouter, Ollama / LM Studio, Gemini, Custom (OpenAI-compatible). GitHub Copilot and OpenCode are greyed "Coming soon" placeholders.
2. **Identity**: name and sign-in method. CLIs (Claude Code, Codex, Cursor Agent) use their own sign-in and connect directly when installed; Cursor also offers browser sign-in into an isolated profile (see [Cursor accounts](cursor-accounts.md)), a CLI account with an API key, or the SDK with an API key; the other drivers take an API key. "Configure manually" goes to step 3.
3. **Config**: base URL (Ollama / LM Studio can detect their default ports), then "Test connection" and "Save", which lists the models and selects the first one when no model is selected yet.

**Grok** is an OpenAI-compatible preset (`kind: "xai"`, base URL `https://api.x.ai/v1`, key from [console.x.ai](https://console.x.ai)); requests go through the Tauri http plugin, whose scope already allows any https host, so no CSP or capability change was needed.

## Model picker

Providers in the picker's rail and models in search results and favourites follow the same order (pinned drivers first). "Manage providers…" at the bottom opens this page.
