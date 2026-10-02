import type { ProviderConfig } from './types';

/** Keys travel in child environment, never shell arguments or saved provider config. */
export function cursorAccountEnv(cfg: ProviderConfig, key: string): Record<string, string> {
  if (cfg.cli !== 'cursor-agent') return {};
  if (cfg.cliAuth === 'key' && !key.trim()) throw new Error('Cursor account API key is missing.');
  return cfg.cliAuth === 'key' ? { CURSOR_API_KEY: key.trim() } : {};
}

export function reserveFor(primary: ProviderConfig | undefined, providers: ProviderConfig[], model: string, models: {providerId: string; id: string}[]) {
  if (!primary?.backupProviderId || primary.cli !== 'cursor-agent') return;
  const backup = providers.find(p => p.id === primary.backupProviderId && p.id !== primary.id && !p.disabled && p.cli === 'cursor-agent' && p.cliAuth === 'key');
  return backup && models.some(m => m.providerId === backup.id && m.id === model) ? backup : undefined;
}
