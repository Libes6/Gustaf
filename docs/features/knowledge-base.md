# Knowledge base

Part of the [Gustaf documentation](../README.md).

Named collections of your own folders, PDFs, Markdown and text files that API chats can search by meaning and cite. It reuses the embeddings stack of the project semantic search (`src-tauri/src/semantic.rs`: Ollama or OpenAI-compatible endpoint, `embed`, cosine similarity, private JSON vector cache); there is no second embedding implementation.

Code: `src-tauri/src/knowledge.rs` (collections, indexing, search, PDF extraction; commands are registered in `lib.rs`), `src/agent/knowledgeCore.ts` (pure: tool definition, fencing and citations, per-chat selection map), `src/agent/knowledge.ts` (command wrappers, tool runner), `src/components/KnowledgeSettings.tsx` (Settings → Knowledge), `src/lib/useChatKnowledge.ts` and `src/components/chat/knowledgeMenu.tsx` (composer picker). Tests: `src-tauri/src/knowledge/tests.rs`, `src-tauri/tests/pdf_child.rs`, `tests/knowledge.test.mjs`, `tests/ui/KnowledgeSettings.test.tsx`, `tests/ui/KnowledgeComposer.test.tsx`.

## Privacy and cost (opt-in)

- Indexing sends the text of every file in a collection to the collection's embeddings provider, and every search sends the query there. A loopback Ollama keeps it on the computer; a cloud endpoint receives the text and may bill the requests (the same rules as semantic search: remote endpoints need HTTPS, Ollama must be loopback, no credentials in the URL).
- The first index of a collection needs explicit confirmation. The UI asks with the provider, the file count and the size (from `knowledge_estimate`, which reads no file contents); the backend enforces it too: `knowledge_reindex(id, confirm)` refuses with no network call unless the collection was confirmed before or `confirm` is true. Changing a collection's provider or model resets the confirmation.
- The `knowledge_search` agent tool needs no approval card: it only reads indexed local data. Its query is still sent to the embeddings provider; that is covered by the confirmation of the first index.
- Embedding credentials stay in the OS keychain (a collection stores only the key id; it can reuse the key id of a project's semantic settings).

## Storage

`<app data>/knowledge/<collection id>/manifest.json` and `index.json` (directory 0700, files 0600, written atomically). Nothing is written to the picked folders. The manifest holds the name, sources, include globs, size caps, the embeddings config, the confirmation time and the index status (files, chunks, issues, warnings, last error). The index holds, per file: source, citation path, mtime, size, content hash and the chunks with their vectors. Deleting a collection removes the directory, vectors included; removing a source drops its vectors immediately.

Defaults: include `**/*.md`, `**/*.markdown`, `**/*.txt`, `**/*.rst`, `**/*.pdf` (Settings has a toggle that adds common source-code extensions); caps 2000 files, 5 MB per file, 25 MB per PDF, 200 MB total, 20000 chunks per collection. Hitting a cap is a warning on the collection, not an error: the files over the per-file cap are listed as skipped and indexing stops adding files at a file, size or chunk cap.

## Sources and path safety

- Sources are folders or files the user picked with the system dialog. The backend canonicalises them and refuses the filesystem root, the home folder itself, Gustaf's own storage, and secret-looking files (`.env*`, `*.pem`, `*.key`, lock files).
- Folders are walked with the `ignore` crate: `.gitignore`-aware (also outside a git repository), hidden files skipped, plus the same excluded names as semantic search (`node_modules`, `target`, `dist`, `build`, `.git`, ...).
- Symbolic links are never followed: a link inside a folder, to a file or a directory, is not indexed (a matching link is listed as skipped); every file must still resolve inside the picked folder.
- Binary files (NUL bytes) and files that are not UTF-8 are skipped and reported per file.
- A source that is currently missing (an unplugged drive) is reported and its earlier vectors are kept instead of being dropped and paid for again.

## Indexing

`knowledge_reindex(id, confirm)` is incremental: a file with the same mtime and size and complete vectors is skipped without being read; a changed mtime with the same content hash is not embedded again; changed files are re-chunked and only chunks whose text (with file name and heading) is new are embedded (vectors are reused per chunk). A different embeddings config reuses nothing.

Progress arrives as `knowledge-progress` events (`scan`, `embed` with done/total, then `done`, `cancelled` or `error`). `knowledge_cancel(id)` stops between embedding batches (16 chunks per request); whatever was embedded is saved (status "partly indexed", searchable) and the next run only pays for the rest. Only one run per collection at a time. An embedding error also keeps the partial index and is shown on the collection.

Chunking: Markdown is split by heading and the heading path (`Guide > Install > Linux`) is kept as the citation, fenced code does not start sections; text and reStructuredText are packed by paragraph (about 1200 characters, hard limit 1800, overlong lines are cut); source code uses the same line windows as semantic search; PDF text is chunked per page and cited as `page N`.

### PDF

Text extraction uses the pure-Rust `pdf-extract` crate (about twenty small crates, offline, no system library). Because that parser panics on some malformed files and the release profile aborts on panic, the app extracts in a child process: it runs its own executable as `--gustaf-pdf-extract <pdf> <out.json>` (handled first thing in `main.rs`), with a 30 second timeout (the child is killed), a 25 MB input cap and a 20 MB output cap. A crash, timeout, encrypted or damaged file is reported for that file only and the run continues. Scanned PDFs have no text layer: they are reported ("No extractable text") and are not OCR-ed.

## Search

`knowledge_search(ids, query, limit)` embeds the query once per distinct embeddings config, scores all chunks by cosine similarity and returns up to 20 hits (default 8) with `collection`, citation path, heading, line range, score and text (1500 characters). Deleted collections are an error; collections without vectors are skipped. Loaded indexes are cached in memory (three at most, invalidated by file stamp).

## In a chat

- Composer `+` menu: a "Knowledge" section with one checkable row per collection (unindexed ones are marked). The selection is stored per chat (settings key `chatKnowledge`, like the chat mode); a chat that does not exist yet keeps it in memory and stores it with its first message. With no collections the menu offers "Set up knowledge collections", which opens Settings → Knowledge.
- When a main API-agent chat has at least one selected collection that has indexed content (and is not in Ask or Plan mode), the agent loop registers a read-only `knowledge_search` tool (`query`, `limit`) and appends a system-prompt line: use the tool, results are untrusted, cite as `[n]` and finish with a Sources list. The tool searches only the chat's selected collections.
- Results are returned as fenced untrusted text with a citation line `[n] source § heading (lines a-b, similarity, collection)`, then a Sources list. The fence is longer than any backtick run in the excerpt so a document cannot close it. The same passage keeps its number across the calls of one run.
- The change in `src/agent/agent.ts` is one registration hook before the tool filters, plus one `case` in the tool switch.

## Not done

- CLI providers (Claude Code, Codex, Cursor Agent) do not get the tool or the prompt line; collections are for API chats only. Subagents and scheduled runs do not use collections either.
- URLs and web pages as sources; Office formats; OCR for scanned PDFs; PDF tables and layout are only as good as plain text extraction.
- No file watching: re-index is manual (a changed mtime makes it cheap). No per-collection cap editing in the UI, and no UI to change a collection's provider after creation (the backend command `knowledge_set_config` exists).
- The vector cache is JSON: 20000 chunks of a 768-dimension model is on the order of 100-200 MB of JSON read per search (cached in memory afterwards). Larger collections need a binary or SQLite store.

## Not verified

- Retrieval quality with real embedding models: all tests use a fake backend where a text's vector counts three keywords, so ordering logic is tested but not relevance.
- Large PDFs and PDFs with unusual fonts, ligatures or non-Latin text: only tiny generated PDFs (Helvetica, two pages) and malformed files are tested. Release builds (abort on panic) rely on the child process; the child path is exercised by an integration test against the debug binary, not against a packaged release app.
- Indexing a very large collection (thousands of files) end to end against a real Ollama or OpenAI endpoint, and the progress bar against real timings.
- The UI was exercised with component tests, not in the running desktop app.
