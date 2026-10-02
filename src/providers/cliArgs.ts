export function codexArgs({ model, session, access }: { model?: string; session?: string; access?: 'readonly' | 'auto' | 'full' }): string[] {
  const permissions = access === 'full'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : session
      ? ['-c', `sandbox_mode="${access === 'readonly' ? 'read-only' : 'workspace-write'}"`]
      : ['--sandbox', access === 'readonly' ? 'read-only' : 'workspace-write'];
  return ['exec', ...(session ? ['resume'] : []), '--json', '--skip-git-repo-check', ...permissions, ...(model ? ['-m', model] : []), ...(session ? [session] : [])];
}
