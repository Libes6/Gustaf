import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  McpServerId,
  ProviderDriverKind,
  type ManagedPolicySummary,
  type McpServerConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    updateSettings: vi.fn(),
    alert: vi.fn(),
    targets: [] as ReturnType<typeof environment>[],
    missingScopes: new Set<string>(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Alert: { alert: mocks.alert },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    !mocks.missingScopes.has(`${environmentId}:${scope}`),
  useEnvironmentScope: (environmentId: string, scope: string) =>
    !mocks.missingScopes.has(`${environmentId}:${scope}`),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({
    title: "Filter",
    icon: "line.3.horizontal.decrease.circle",
    items: [],
  }),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title?: string; children?: ReactNode }) => (
    <section aria-label={title}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    subtitle,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    subtitle?: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={value ?? "mixed"}
        disabled={disabled}
        onClick={() => onValueChange(!value)}
      >
        {label}
      </button>
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  ),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets,
  }),
}));

import { SettingsMcpRouteScreen } from "./SettingsMcpRouteScreen";

function environment(options?: {
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly managedPolicy?: ManagedPolicySummary;
}) {
  return {
    environmentId: EnvironmentId.make("local"),
    label: "Local",
    connection: { phase: "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        mcpServers: (options?.mcpServers ?? {}) as Record<McpServerId, McpServerConfig>,
      },
      ...(options?.managedPolicy === undefined ? {} : { managedPolicy: options.managedPolicy }),
      environment: {
        capabilities: {},
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment()];
  mocks.missingScopes = new Set();
  mocks.alert.mockReset();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsMcpRouteScreen", () => {
  it("renders configured servers with sanitized addresses, agent labels, and policy locks", async () => {
    mocks.targets = [
      environment({
        mcpServers: {
          "local-tools": {
            name: "Local Tools",
            enabled: false,
            providers: [ProviderDriverKind.make("codex")],
            transport: { type: "stdio", command: "npx", args: [], env: {}, cwd: "thread" },
          },
          context7: {
            enabled: true,
            transport: {
              type: "http",
              url: "https://user:pass@mcp.context7.com/mcp/?token=secret",
              headers: {},
            },
          },
        },
        managedPolicy: {
          organization: "Acme",
          lockedSettings: ["mcpServers.context7"],
          limits: { localMcpServers: false },
        },
      }),
    ];

    act(() => root.render(<SettingsMcpRouteScreen />));

    const switches = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((el) => el.textContent)).toEqual(["Local Tools", "context7"]);
    expect(switches[0]!.disabled).toBe(true);
    expect(switches[1]!.disabled).toBe(true);

    expect(container.textContent).toContain("Local (stdio) · npx · Only Codex");
    expect(container.textContent).toContain(
      "Remote (HTTP) · https://mcp.context7.com/mcp/ · All agents · Managed by your organization",
    );
    expect(container.textContent).toContain("Your organization does not allow local MCP servers.");

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>("button:not([role='switch'])"),
    ];
    const context7Install = buttons.find((button) => button.textContent === "Installed");
    expect(context7Install?.disabled).toBe(true);
  });

  it("toggles an enabled MCP server and installs a marketplace entry", async () => {
    mocks.targets = [
      environment({
        mcpServers: {
          docs: {
            name: "Docs",
            enabled: false,
            transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          },
        },
      }),
    ];

    act(() => root.render(<SettingsMcpRouteScreen />));

    const docsSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => {
      docsSwitch.click();
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        patch: {
          mcpServers: {
            docs: {
              name: "Docs",
              enabled: true,
              transport: { type: "http", url: "https://example.com/mcp", headers: {} },
            },
          },
        },
      },
    });

    const installButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Install",
    )!;
    await act(async () => {
      installButton.click();
    });

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: {
          mcpServers: {
            context7: {
              name: "Context7",
              enabled: true,
              transport: { type: "http", url: "https://mcp.context7.com/mcp", headers: {} },
            },
          },
        },
      },
    });
  });

  it("disables stdio toggles when terminal access is missing", () => {
    mocks.targets = [
      environment({
        mcpServers: {
          "stdio-server": {
            enabled: true,
            transport: { type: "stdio", command: "uvx", args: [], env: {}, cwd: "thread" },
          },
          "http-server": {
            enabled: false,
            transport: { type: "http", url: "https://example.com/mcp", headers: {} },
          },
        },
      }),
    ];
    mocks.missingScopes.add(`local:${AuthTerminalOperateScope}`);

    act(() => root.render(<SettingsMcpRouteScreen />));

    const switches = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches[0]!.disabled).toBe(true);
    expect(switches[1]!.disabled).toBe(false);
    expect(container.textContent).toContain(
      "Changing local MCP servers also requires terminal access.",
    );
  });

  it.each([AuthProvidersManageScope, AuthSettingsWriteScope])(
    "disables all writes when %s is missing",
    (scope) => {
      mocks.targets = [
        environment({
          mcpServers: {
            "stdio-server": {
              enabled: true,
              transport: { type: "stdio", command: "uvx", args: [], env: {}, cwd: "thread" },
            },
            "http-server": {
              enabled: false,
              transport: { type: "http", url: "https://example.com/mcp", headers: {} },
            },
          },
        }),
      ];
      mocks.missingScopes.add(`local:${scope}`);

      act(() => root.render(<SettingsMcpRouteScreen />));

      const switches = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
      expect(switches.every((button) => button.disabled)).toBe(true);
      expect(container.textContent).toContain(
        "Changing MCP servers requires settings and provider management permissions.",
      );
    },
  );
});
