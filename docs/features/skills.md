# Skills and slash commands

Type `/` at the beginning of the composer to see available commands. Arrow keys select; Enter/Tab inserts the command without sending it; add arguments and press Enter again to send. Escape or moving focus outside dismisses suggestions without clearing the draft.

Built-in commands: `/review`, `/test`, `/explain`, `/commit`. The last one prepares a commit message; it does not itself authorize staging, committing, pushing, or publishing. Commands run through the selected provider and normal chat mode/tool approvals. Ask remains without tools, Plan remains read-only, Agent retains the selected access rules.

Project and home directories are scanned at:

- `.agents/skills/<name>/SKILL.md`, `.mcode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `.cursor/skills/<name>/SKILL.md`, `.codex/skills/<name>/SKILL.md`.
- Compatibility command files: `.cursor/commands/*.md`, `.claude/commands/*.md` (nested directories up to four levels).

A SKILL.md can start with frontmatter `name:` and `description:`. Without those fields, its containing directory becomes the name. A command Markdown file uses its filename stem. Names may contain ASCII letters, digits, `-`, and `_`; invocation is case insensitive. Project definitions override global definitions, which override built-ins. Names are resolved deterministically within a scope. Symlinked files/folders are excluded, read paths cannot escape the containing root, and bodies over 128 KiB are rejected. Discovery is capped at 200 files per scope.

Only descriptions are included in the model catalogue (up to 80 entries); instruction bodies are loaded upon explicit `/name` invocation or the model's `use_skill` read-only tool. Explicit slash invocation can still use entries beyond the catalogue limit. `$ARGUMENTS` denotes supplied user arguments; M Code presents them as data separately and never executes placeholders as shell code.

API providers can request `use_skill`; native CLI providers receive explicitly invoked skill instructions in their prompt and keep their own native tools. All skills remain subject to existing chat permissions and review isolation. Supporting files can be read with existing project tools when inside the project; global skill supporting files are not exposed through an unrestricted file reader.

A review run discovers skills from its original project mapping. If that mapping cannot be resolved, only global/built-in skills are offered. Unknown explicit slash commands fail clearly rather than silently running a different task. If discovery is unavailable, built-in commands remain available.
