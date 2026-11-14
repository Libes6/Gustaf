/** Where the Gustaf shell's computer-use executor listens. See docs/internals/computer-use.md. */
export interface ComputerUseEndpoint {
  readonly socketPath: string;
  readonly token: string;
}

const SOCKET_ENV = "GUSTAF_COMPUTER_USE_SOCKET";
const TOKEN_ENV = "GUSTAF_COMPUTER_USE_TOKEN";

let taken: ComputerUseEndpoint | undefined;

/**
 * Reads the shell's executor address and token and deletes both from the environment. Runs first
 * thing at startup: every agent subprocess inherits this environment, and an agent holding the
 * token could skip the server's per-thread checks. Later calls return what the first one took.
 */
export function takeComputerUseEndpoint(
  env: Record<string, string | undefined> = process.env,
): ComputerUseEndpoint | undefined {
  const socketPath = env[SOCKET_ENV];
  const token = env[TOKEN_ENV];
  delete env[SOCKET_ENV];
  delete env[TOKEN_ENV];
  if (taken === undefined && socketPath && token) taken = { socketPath, token };
  return taken;
}
