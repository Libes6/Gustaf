/**
 * `images` are absolute paths of attachments written by `attachments_save`. `--image=<path>` (one flag per file) is used
 * instead of `-i <path>` because `codex exec -i` takes a variadic list and would swallow the positional prompt/session id.
 * Each flag is followed by another `--` option, never by a positional.
 */
export function codexArgs({ model, session, access, images = [] }: { model?: string; session?: string; access?: 'readonly' | 'auto' | 'full'; images?: string[] }): string[] {
  const permissions = access === 'full'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : session
      ? ['-c', `sandbox_mode="${access === 'readonly' ? 'read-only' : 'workspace-write'}"`]
      : ['--sandbox', access === 'readonly' ? 'read-only' : 'workspace-write'];
  return ['exec', ...(session ? ['resume'] : []), '--json', '--skip-git-repo-check', ...images.map((p) => `--image=${p}`), ...permissions, ...(model ? ['-m', model] : []), ...(session ? [session] : [])];
}

/** Claude and Cursor Agent have no image flag: the prompt points them at the files, and their tool permissions must cover the folder. */
export function withImagePaths(prompt: string, images: string[]): string {
  if (!images.length) return prompt;
  const lines = images.map((p) => `Attached image: ${p} (read it with your file-reading tool)`);
  return `${prompt}\n\n${lines.join('\n')}`;
}

/** Images to send with this turn: those of the user messages after the resumed session, or only the latest user message when the history is replayed as text. */
export function turnImages(rest: { role: string; parts: { type: string; data?: string }[] }[], resumed: boolean): string[] {
  const users = rest.filter((m) => m.role === 'user');
  const picked = resumed ? users : users.slice(-1);
  return picked.flatMap((m) => m.parts.flatMap((p) => (p.type === 'image' && p.data ? [p.data] : [])));
}
