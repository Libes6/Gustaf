import * as Schema from "effect/Schema";

type BuildPlatform = "mac" | "linux" | "win";
type BuildArch = "arm64" | "x64" | "universal";

export const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 reads build approvals only from pnpm-workspace.yaml; omission fails staged lifecycle installs.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  packageExtensions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        peerDependenciesMeta: Schema.Record(
          Schema.String,
          Schema.Struct({ optional: Schema.Boolean }),
        ),
      }),
    ),
  ),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

// TypeScript is a typings-only peer; pnpm auto-installation would ship a compiler.
const STAGE_PACKAGE_EXTENSIONS = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
} as const;

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;

export function resolveFffNativeDependencies(
  platform: BuildPlatform,
  arch: BuildArch,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

export function createStageWorkspaceConfig(input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  // Linux AppImages require glibc native optional dependencies; tell pnpm explicitly.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : {
          os: [hostOs],
          cpu: hostCpu,
        };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    packageExtensions: STAGE_PACKAGE_EXTENSIONS,
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}
