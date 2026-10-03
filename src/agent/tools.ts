import type { ToolDef } from "../providers/types";

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const READ_TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a text file from the project. Returns lines prefixed with line numbers.",
    parameters: obj({ path: str("Path relative to the project root"), offset: int("1-based first line"), limit: int("Max lines") }, ["path"]),
  },
  {
    name: "list_dir",
    description: "List a directory in the project. Directories end with '/'.",
    parameters: obj({ path: str("Path relative to the project root, '.' for the root") }, ["path"]),
  },
  {
    name: "search",
    description: "Regex search over project files (respects .gitignore). Returns path:line:text.",
    parameters: obj({ pattern: str("Rust regex"), glob: str("Optional glob filter, e.g. '*.ts'") }, ["pattern"]),
  },
];

export const WRITE_TOOLS: ToolDef[] = [
  {
    name: "edit_file",
    description: "Replace exactly one occurrence of old_string with new_string. Fails if old_string is missing or not unique; include enough context.",
    parameters: obj({ path: str("Path relative to the project root"), old_string: str("Exact text to replace"), new_string: str("Replacement") }, [
      "path",
      "old_string",
      "new_string",
    ]),
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    parameters: obj({ path: str("Path relative to the project root"), content: str("Full file content") }, ["path", "content"]),
  },
  {
    name: "run_command",
    description: "Run a shell command in the project root (zsh on macOS, bash on Linux, PowerShell on Windows). Returns combined stdout/stderr and exit code. The user's command rules may block a command or ask them first; a blocked command must not be retried or reworded.",
    parameters: obj({ command: str("Command line"), timeout_ms: int("Timeout, default 120000") }, ["command"]),
  },
];
