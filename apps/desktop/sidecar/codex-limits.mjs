// Read-only Codex app-server protocol. No login, resets or credential extraction.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child = spawn(process.env.GUSTAF_CODEX_BINARY || 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
const modelsMode = process.argv.includes('--models');
const models = [];
let requestId = 2;
let finished = false;
const finish = (data) => { if (finished) return; finished = true; clearTimeout(timer); process.stdout.write(JSON.stringify(data) + '\n'); child.kill(); };
const timer = setTimeout(() => finish({ type: 'error', message: 'Codex limits: timeout' }), 15000);
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
child.on('error', () => finish({ type: 'error', message: 'Codex CLI is unavailable' }));
child.on('close', () => finish({ type: 'error', message: 'Codex app-server exited before returning limits' }));
child.stdin.on('error', () => {});
child.stderr.resume();
createInterface({ input: child.stdout }).on('line', line => {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.id === 1) {
    if (ev.error) return finish({ type: 'error', message: ev.error.message });
    send({ method: 'initialized' });
    send({ id: requestId, method: modelsMode ? 'model/list' : 'account/rateLimits/read', ...(modelsMode ? { params: { limit: 100 } } : {}) });
  } else if (ev.id === requestId) {
    if (ev.error) return finish({ type: 'error', message: ev.error.message });
    if (modelsMode) {
      models.push(...(ev.result?.data ?? []).filter(m => !m.hidden).map(m => ({ id: m.model || m.id, name: m.displayName || m.model || m.id })));
      if (ev.result?.nextCursor) {
        send({ id: ++requestId, method: 'model/list', params: { limit: 100, cursor: ev.result.nextCursor } });
      } else finish({ type: 'models', result: models });
      return;
    }
    const pick = b => b ? { limitId: b.limitId, limitName: b.limitName, planType: b.planType, primary: b.primary, secondary: b.secondary } : null;
    finish({ type: 'limits', result: { rateLimits: pick(ev.result?.rateLimits), rateLimitsByLimitId: ev.result?.rateLimitsByLimitId ? Object.fromEntries(Object.entries(ev.result.rateLimitsByLimitId).map(([k,v]) => [k,pick(v)])) : undefined } });
  }
});
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'gustaf', title: 'Gustaf', version: '0.1.0' } } });
