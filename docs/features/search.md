# Search across chats

Part of the [M Code documentation](../README.md).

Press Cmd+K (or use the search-lines button in the sidebar header) to search the text of every message in all chats, archived ones included. Results are ranked by relevance with the matches highlighted; filter by project and by model (the model filter keeps assistant replies written by that model, since your own messages carry no model). Up/Down move through results, Enter opens the chat and scrolls to the message (steps folded under "Done in ..." are expanded), Esc or Cmd+K closes.

- Typing is searched as you go: every word must appear, words also match as prefixes (`func` finds `function`), and `"in quotes"` is an exact phrase. Case and accents are ignored; `ё` and `е` are different letters. Operators such as `AND`, `NOT`, `-` or `*` are ordinary text, so no input can break the search. Queries need at least two characters; the top 40 results are shown.
- Only message text is indexed: image data, tool calls and results, `@file` contents attached to a prompt and context summaries are not. Text beyond 100,000 characters in one message is not searchable.
- The index is a SQLite FTS5 table (`messages_fts`) kept in sync by database triggers, and is built from existing messages the first time the app starts after this feature (a few seconds for tens of thousands of messages). Nothing is sent anywhere; FTS5 is included in the bundled SQLite, no extra setup. Details are in [Architecture](../ARCHITECTURE.md#full-text-search-dbrs).
