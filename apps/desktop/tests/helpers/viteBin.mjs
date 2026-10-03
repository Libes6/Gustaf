// Path of the vite CLI. Resolved through Node's module lookup because npm workspaces hoist `vite` to the repo root's node_modules.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
