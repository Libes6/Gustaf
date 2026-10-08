// Module resolution hooks for tests that load app code outside Vite: extensionless relative imports resolve to .ts files,
// and the Tauri-facing `lib/api` module is replaced by tests/helpers/apiStub.mjs. `@tauri-apps/plugin-shell` imported
// by app code is replaced by tests/helpers/shellStub.mjs (processes are fakes a test scripts; nothing is started).
const stub = new URL('./apiStub.mjs', import.meta.url).href;
const shellStub = new URL('./shellStub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  const isApi = /(?:^|\/)lib\/api(?:\.ts)?$/.test(specifier) || (specifier === './api' && /\/src\/lib\//.test(parent));
  if (isApi && /\/src\//.test(parent)) return { url: stub, shortCircuit: true };
  if (specifier === '@tauri-apps/plugin-shell' && /\/src\//.test(parent)) return { url: shellStub, shortCircuit: true };
  if (specifier.startsWith('.')) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw error;
      try {
        return await nextResolve(`${specifier}.ts`, context);
      } catch {
        throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}
