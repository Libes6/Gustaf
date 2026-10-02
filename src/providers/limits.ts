import { resolveResource } from '@tauri-apps/api/path';
import { spawnLines, shq, codexExecutable } from './cli';
import { codexLimits } from './usage';
import type { ProviderConfig } from './types';
declare const __SIDECAR__: string;
export async function readSubscriptionLimits(p: ProviderConfig) {
  if (p.kind !== 'cli' || p.cli !== 'codex') throw new Error('Subscription limits are not available through this provider.');
  const script = import.meta.env.DEV ? __SIDECAR__.replace(/cursor-agent\.mjs$/, 'codex-limits.mjs') : await resolveResource('sidecar/codex-limits.mjs');
  let result; let error = '';
  const executable = await codexExecutable();
  await spawnLines(`exec env MCODE_CODEX_BINARY=${shq(executable)} node ${shq(script)}`, e => { if (e.type === 'limits') result = e.result; if (e.type === 'error') error = e.message; });
  if (error) throw new Error(error);
  const windows = codexLimits(result);
  if (!windows.length) throw new Error('Account did not return subscription limits.');
  return windows;
}
