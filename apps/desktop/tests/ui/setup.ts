import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { invokeMock, resetInvoke } from './tauri';

// Every Tauri entry point the components import is replaced here, so a test never reaches a real backend.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setBadgeCount: async () => {},
    requestUserAttention: async () => {},
    onFocusChanged: async () => () => {},
  }),
  UserAttentionType: { Informational: 2, Critical: 1 },
}));
vi.mock('@tauri-apps/api/path', () => ({
  resolveResource: async (p: string) => p,
  homeDir: async () => '/home/test',
  join: async (...p: string[]) => p.join('/'),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
  openPath: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => {}),
  ask: vi.fn(async () => false),
}));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: vi.fn(async () => {}),
  unregister: vi.fn(async () => {}),
  unregisterAll: vi.fn(async () => {}),
  isRegistered: vi.fn(async () => false),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn(async () => new Response('{}')) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { create: vi.fn(), sidecar: vi.fn() } }));

// jsdom lacks these.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  resetInvoke();
  vi.useRealTimers();
});
