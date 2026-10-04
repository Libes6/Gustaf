import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export function dmgPaths(output) {
  return [...new Set(output.split('\n').flatMap(line => {
    const match = line.match(/\(([^\n]+\.dmg)\)/);
    return match ? [match[1]] : [];
  }))];
}

export function buildEnvironment(platform, args, env) {
  return platform === 'darwin' && args[0] === 'build'
    ? { ...env, CI: 'true', TAURI_BUNDLER_DMG_IGNORE_CI: 'false' }
    : env;
}

export function mergeConfig(base, update) {
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value);
    } else base[key] = value;
  }
  return base;
}

export function notarizationArgs(env) {
  if (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID) {
    return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  }
  if (env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH) {
    return ['--key', env.APPLE_API_KEY_PATH, '--key-id', env.APPLE_API_KEY, '--issuer', env.APPLE_API_ISSUER];
  }
  return null;
}

export function verifyMountedApp(source, mounted, exec, probe) {
  const signature = probe(source);
  if (signature.error) throw signature.error;
  if (signature.status === 0) {
    exec('codesign', ['--verify', '--deep', '--strict', mounted]);
    return true;
  }
  // --no-sign and an explicitly unsigned macOS config are valid Tauri builds.
  // A signed source must still pass strict verification after packaging.
  return false;
}

export function run(args) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const desktop = join(root, 'apps/desktop');
  const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const capture = process.platform === 'darwin' && args[0] === 'build';
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: desktop, env: buildEnvironment(process.platform, args, process.env),
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: capture ? 'pipe' : 'inherit',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (process.platform !== 'darwin' || args[0] !== 'build') return 0;
  // Use only DMGs reported by this build, never guess target/profile/architecture
  // or pick up a stale artifact from an earlier --bundles app invocation.
  const dmgs = dmgPaths(`${result.stdout}\n${result.stderr}`);
  if (!dmgs.length) return 0;
  const config = JSON.parse(readFileSync(join(desktop, 'src-tauri/tauri.conf.json')));
  const platformConfig = join(desktop, 'src-tauri/tauri.macos.conf.json');
  if (existsSync(platformConfig)) mergeConfig(config, JSON.parse(readFileSync(platformConfig)));
  for (let i = 1; i < args.length; i++) {
    const value = args[i] === '--config' || args[i] === '-c' ? args[++i]
      : args[i].startsWith('--config=') ? args[i].slice(9) : null;
    if (value) mergeConfig(config, JSON.parse(value.trim().startsWith('{') ? value
      : readFileSync(resolve(desktop, value), 'utf8')));
  }
  const temporary = mkdtempSync(join(root, '.dmg-build-'));
  function exec(command, argv) {
    const child = spawnSync(command, argv, { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`${command} failed (${child.status})`);
  }
  try {
    exec('python3', ['-m', 'venv', join(temporary, 'python')]);
    const python = join(temporary, 'python/bin/python');
    const resolvedConfig = join(temporary, 'config.json');
    writeFileSync(resolvedConfig, JSON.stringify(config));
    exec(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(root, 'scripts/dmg-requirements.txt')]);
    for (const reported of dmgs) {
      const dmg = resolve(desktop, reported);
      if (!existsSync(dmg) || !statSync(dmg).isFile()) throw new Error(`Missing bundled DMG: ${dmg}`);
      const app = join(dirname(dirname(dmg)), 'macos', `${config.productName}.app`);
      if (!existsSync(app)) throw new Error(`Missing app bundle: ${app}`);
      // The existing image tells us the exact resolved Developer ID, including
      // config overrides and APPLE_SIGNING_IDENTITY. Ad-hoc images stay unsigned.
      const signature = spawnSync('codesign', ['--display', '--verbose=4', dmg], { encoding: 'utf8' });
      const identity = signature.stderr?.match(/^Authority=(.+)$/m)?.[1];
      const notarize = identity ? notarizationArgs(process.env) : null;
      const wasStapled = identity && spawnSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'ignore' }).status === 0;
      if (wasStapled && !notarize) throw new Error('Rebuilding a notarized DMG requires Apple notarization credentials');
      exec(python, ['-m', 'dmgbuild', '-s', join(root, 'scripts/dmg-settings.py'),
        '-D', `app=${app}`, '-D', `config=${resolvedConfig}`, '-D', `assets=${join(desktop, 'src-tauri')}`,
        config.productName, dmg]);
      if (identity && !args.includes('--no-sign')) {
        exec('codesign', ['--force', '--sign', identity, '--timestamp', dmg]);
        if (notarize) {
          exec('xcrun', ['notarytool', 'submit', dmg, ...notarize, '--wait']);
          exec('xcrun', ['stapler', 'staple', dmg]);
          exec('xcrun', ['stapler', 'validate', dmg]);
        }
        exec('codesign', ['--verify', '--strict', dmg]);
      }
      exec('hdiutil', ['verify', dmg]);
      const mount = join(temporary, 'mounted');
      exec('mkdir', ['-p', mount]);
      exec('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
      try {
        exec(python, [join(root, 'scripts/verify-dmg.py'), mount, resolvedConfig]);
        const verified = verifyMountedApp(app, join(mount, `${config.productName}.app`), exec,
          source => spawnSync('codesign', ['--display', source], { stdio: 'ignore' }));
        console.log(verified ? 'Mounted app signature verified.' : 'Source app intentionally unsigned; signature check skipped.');
      } finally {
        exec('hdiutil', ['detach', mount]);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
