// Runs the real bridge launcher (src-tauri/src/device_bridge/bridge-launcher.sh) against a local HTTP server, as
// `gustaf-device` or `gustaf-agent` (the script reads its own name). Shared by the device and agent command tests.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../src-tauri/src/device_bridge/bridge-launcher.sh', import.meta.url));
export const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v curl']).status === 0;

const bin = mkdtempSync(join(tmpdir(), 'launcher-'));
const install = (name) => {
  const path = join(bin, name);
  copyFileSync(script, path);
  chmodSync(path, 0o755);
  return path;
};
const paths = { 'gustaf-device': install('gustaf-device'), 'gustaf-agent': install('gustaf-agent') };

/** A server that records requests (`args` = the repeated field `a`, `input` = field `i`) and answers with `reply`. */
export async function server(reply) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        args: form.getAll('a'),
        ...(form.has('i') ? { input: form.get('i') } : {}),
      });
      const r = reply(seen.at(-1));
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(r.text);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => srv.close() };
}

/** Runs the launcher installed as `name` with `env`, `args` and optional stdin text. */
export const runLauncher = (name, env, args, { stdin, cwd } = {}) =>
  new Promise((resolve) => {
    const p = spawn('sh', [paths[name], ...args], { env: { PATH: process.env.PATH, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) p.stdin.end(stdin);
    else p.stdin.end();
  });
