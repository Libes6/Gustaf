// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("keeps other variables but never bakes T3 Connect or T3 trace identifiers into a build", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_RELAY_URL=https://root.example.test\nEXPO_PUBLIC_GUSTAF_API_URL=https://api.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_JWT_TEMPLATE=template_local\nEXPO_PUBLIC_OTLP_TRACES_TOKEN=token_local\n",
    );

    const env = loadRepoEnv({
      baseEnv: {
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
        T3CODE_RELAY_URL: "https://ci.example.test",
        VITE_T3CODE_RELAY_URL: "https://ci.example.test",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.example.test",
        T3CODE_MOBILE_OTLP_TRACES_URL: "https://traces.example.test",
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "login.example.test",
        APP_VARIANT: "preview",
      },
      repoRoot,
    });

    expect(env).toEqual({
      EXPO_PUBLIC_GUSTAF_API_URL: "https://api.example.test",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "login.example.test",
      APP_VARIANT: "preview",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
