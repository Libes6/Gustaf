import type { ProviderConfig } from './types';

/** Profile names are folder names under the app data dir; must match the Rust `validate_name`. */
export const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const profileName = (stamp: number) => `acc-${stamp.toString(36)}`;

/** Credentials travel in the child environment, never shell arguments or saved provider config.
 *  A browser-login profile account only needs its isolated config dir (`profileDir`, resolved by the backend). */
export function cursorAccountEnv(cfg: ProviderConfig, key: string, profileDir?: string): Record<string, string> {
  if (cfg.cli !== 'cursor-agent') return {};
  if (cfg.cliProfile) {
    if (!PROFILE_NAME.test(cfg.cliProfile) || !profileDir) throw new Error('Cursor account profile is missing.');
    return { CURSOR_CONFIG_DIR: profileDir };
  }
  if (cfg.cliAuth === 'key' && !key.trim()) throw new Error('Cursor account API key is missing.');
  return cfg.cliAuth === 'key' ? { CURSOR_API_KEY: key.trim() } : {};
}

export function reserveFor(primary: ProviderConfig | undefined, providers: ProviderConfig[], model: string, models: {providerId: string; id: string}[]) {
  if (!primary?.backupProviderId || primary.cli !== 'cursor-agent') return;
  const backup = providers.find(p => p.id === primary.backupProviderId && p.id !== primary.id && !p.disabled && p.cli === 'cursor-agent' && p.cliAuth === 'key');
  return backup && models.some(m => m.providerId === backup.id && m.id === model) ? backup : undefined;
}
