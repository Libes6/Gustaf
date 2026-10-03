// Metro for an app that is NOT in the root npm workspaces: it has its own node_modules (own React and React Native), and
// consumes @mcode/protocol (pure TypeScript source, no build step) through the symlink that `file:../../packages/protocol`
// creates in node_modules.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const protocolRoot = path.resolve(projectRoot, "../../packages/protocol");

const config = getDefaultConfig(projectRoot);

// Metro must watch the symlink target, which lives outside the project root.
config.watchFolders = [...(config.watchFolders ?? []), protocolRoot];

// Prefer apps/mobile/node_modules for everything. Do not set `resolver.disableHierarchicalLookup`: expo-doctor flags it, and
// every dependency of this app is installed locally, so lookup never reaches the repository root's node_modules (the
// desktop's React) in practice. If a package is ever missing locally, Metro would silently fall back to the root copy;
// `npx expo-doctor` and `npm ls react` from apps/mobile are the checks.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
