/** Pure helpers for multi-file canvas artifacts. No DOM and no compiler here, so Node tests can import this file. */
export type ArtifactFile = { name: string; code: string };
export type ParsedFiles = { files: ArtifactFile[]; error?: string };

export const DEFAULT_FILE = "App.tsx";
export const MAX_FILES = 24;
const FILE_MARKER = /^[ \t]*\/\/[ \t]*file:[ \t]*([^\r\n]*?)[ \t]*\r?$/;
const FILE_NAME = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:tsx|ts|jsx|js)$/;
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/**
 * A body is multi-file when its first non-blank line is a `// file: path` marker; every marker starts a new file.
 * Anything else is one file called App.tsx. Problems are reported in `error` (files then falls back to one file).
 */
export function parseFiles(code: string): ParsedFiles {
  const lines = code.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const single = [{ name: DEFAULT_FILE, code }];
  if (first < 0 || !FILE_MARKER.test(lines[first])) return { files: single };
  const files: ArtifactFile[] = [];
  let name: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (name !== null)
      files.push({
        name,
        code:
          body
            .join("\n")
            .replace(/^(?:[ \t]*\r?\n)+/, "")
            .replace(/\s+$/, "") + "\n",
      });
  };
  for (const line of lines.slice(first)) {
    const marker = FILE_MARKER.exec(line);
    if (marker) {
      flush();
      name = marker[1];
      body = [];
    } else body.push(line);
  }
  flush();
  const problem = validateFiles(files);
  return problem ? { files: single, error: problem } : { files };
}

export function validateFiles(files: ArtifactFile[]): string | undefined {
  if (files.length > MAX_FILES) return `Too many files (${files.length}, maximum ${MAX_FILES}).`;
  const seen = new Set<string>();
  for (const { name } of files) {
    if (!FILE_NAME.test(name) || name.split("/").includes(".."))
      return `Invalid file name "${name}". Use relative paths such as App.tsx or lib/utils.ts.`;
    if (seen.has(name)) return `Duplicate file "${name}".`;
    seen.add(name);
  }
  return undefined;
}

export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Resolves a relative import specifier against the importing file; null when no such file exists. */
export function resolveRelative(from: string, spec: string, names: Iterable<string>): string | null {
  const known = new Set(names);
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const base = normalizePath(`${dir}/${spec}`);
  if (!base) return null;
  const stripped = base.replace(/\.(?:jsx?|tsx?)$/, "");
  for (const candidate of [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
    ...EXTENSIONS.map((e) => stripped + e),
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Evaluates the entry file (the first one) and everything it imports. Only `externals` (react, ...) and relative
 * imports resolve. Modules are registered before they run, so import cycles see partially filled exports instead of looping.
 */
export function loadModules(
  files: ArtifactFile[],
  compile: (code: string, name: string) => string,
  externals: Record<string, unknown>,
): Record<string, unknown> {
  const problem = validateFiles(files);
  if (problem) throw new Error(problem);
  if (!files.length) throw new Error("The artifact has no files.");
  const sources = new Map(files.map((f) => [f.name, f.code]));
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const evaluate = (name: string): Record<string, unknown> => {
    const cached = cache.get(name);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(name, module);
    const require = (spec: string): unknown => {
      if (Object.prototype.hasOwnProperty.call(externals, spec)) return externals[spec];
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = resolveRelative(name, spec, sources.keys());
        if (!target)
          throw new Error(
            `Cannot find module "${spec}" imported from ${name}. Files: ${[...sources.keys()].join(", ")}.`,
          );
        return evaluate(target);
      }
      const allowed = Object.keys(externals)
        .map((k) => `"${k}"`)
        .join(", ");
      throw new Error(
        `Unsupported import "${spec}" in ${name}. Only ${allowed} and relative imports of the artifact's own files are available.`,
      );
    };
    new Function("require", "module", "exports", "React", compile(sources.get(name)!, name))(
      require,
      module,
      module.exports,
      externals.react,
    );
    return module.exports;
  };
  return evaluate(files[0].name);
}
