# Gustaf release notes

A tag release writes its notes with `apps/shell/scripts/release-notes.mjs`: `feat` pull request titles become up to seven bullets, `fix` and `perf` titles become a closing `Plus N bug fixes and improvements.` line, and other types are left out.
To write the notes by hand, add `docs/release-notes/<version>.md` (for example `0.10.0.md`) before tagging. It is used verbatim as the release body and the updater feed; keep `- **Title.** One sentence.` bullets, since the sidebar update card shows only `- ` bullets and that closing line.
