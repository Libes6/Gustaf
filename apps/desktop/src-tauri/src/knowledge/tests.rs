//! Knowledge base tests. Embeddings come from a local fake server (same approach as the project index tests): a text's
//! vector counts the words "apple", "banana" and "cherry", so similarity ordering is predictable.
use super::*;
use std::sync::atomic::AtomicUsize;

struct Fake {
    port: u16,
    texts: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}
fn vector(text: &str) -> Vec<f32> {
    ["apple", "banana", "cherry"].iter().map(|w| text.matches(w).count() as f32 + 0.001).collect()
}
impl Fake {
    fn start() -> Fake {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let (texts, requests, stop) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
        let (t, r, s) = (texts.clone(), requests.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(50)) else { continue };
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                let input = value["input"].as_array().unwrap();
                r.fetch_add(1, Ordering::SeqCst);
                t.fetch_add(input.len(), Ordering::SeqCst);
                let embeddings: Vec<Vec<f32>> = input.iter().map(|v| vector(v.as_str().unwrap())).collect();
                request.respond(tiny_http::Response::from_string(serde_json::json!({ "embeddings": embeddings }).to_string())).unwrap();
            }
        });
        Fake { port, texts, requests, stop, handle: Some(handle) }
    }
    fn config(&self) -> Config {
        Config { kind: "ollama".into(), endpoint: format!("http://127.0.0.1:{}", self.port), model: "fixture".into(), key_id: None }
    }
    fn embedded(&self) -> usize {
        self.texts.load(Ordering::SeqCst)
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn no_pdf(_: &Path) -> Result<Vec<String>, String> {
    Err("PDF support is not used in this test".into())
}
/// In-process extraction for tests (production runs it in a child process because the release profile aborts on panic).
fn pdf_inproc(path: &Path) -> Result<Vec<String>, String> {
    let path = path.to_path_buf();
    std::panic::catch_unwind(move || pdf_extract::extract_text_by_pages(&path))
        .map_err(|_| "PDF parser panicked".to_string())?
        .map_err(|e| e.to_string())
}
fn run_with(store: &Path, id: &str, confirm: bool, pdf: PdfExtractor, cancel: &AtomicBool, progress: &(dyn Fn(&Progress) + Sync)) -> Result<Stats, String> {
    reindex(store, id, confirm, &Run { pdf, progress, cancel })
}
fn index(store: &Path, id: &str) -> Result<Stats, String> {
    run_with(store, id, true, no_pdf, &AtomicBool::new(false), &|_| {})
}
struct Env {
    store: tempfile::TempDir,
    src: tempfile::TempDir,
    fake: Fake,
    id: String,
}
impl Env {
    fn new() -> Env {
        let store = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let fake = Fake::start();
        let c = create(store.path(), "Docs", fake.config(), None).unwrap();
        add_source(store.path(), &c.id, src.path().to_str().unwrap()).unwrap();
        Env { store, src, fake, id: c.id }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.src.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn manifest(&self) -> Collection {
        read_manifest(&self.store.path().join(&self.id)).unwrap()
    }
    fn files(&self) -> Vec<String> {
        read_index(&self.store.path().join(&self.id)).map(|i| i.files.values().map(|f| f.display.split_once('/').map(|x| x.1.to_string()).unwrap_or_else(|| f.display.clone())).collect()).unwrap_or_default()
    }
}

#[test]
fn lifecycle_create_rename_sources_delete() {
    let env = Env::new();
    let store = env.store.path();
    assert_eq!(list(store).unwrap().len(), 1);
    assert_eq!(env.manifest().sources.len(), 1);
    assert_eq!(env.manifest().status.state, "new");
    let renamed = rename(store, &env.id, "  Team wiki ").unwrap();
    assert_eq!(renamed.name, "Team wiki");
    assert!(rename(store, &env.id, "   ").is_err());
    // Adding the same source twice is a no-op; a file source is accepted.
    add_source(store, &env.id, env.src.path().to_str().unwrap()).unwrap();
    env.write("one.md", "# One\napple");
    let file = env.src.path().join("one.md");
    let c = add_source(store, &env.id, file.to_str().unwrap()).unwrap();
    assert_eq!(c.sources.len(), 2);
    assert_eq!(c.sources[1].kind, "file");
    let c = remove_source(store, &env.id, file.to_str().unwrap()).unwrap();
    assert_eq!(c.sources.len(), 1);
    assert!(remove_source(store, &env.id, file.to_str().unwrap()).is_err());
    delete(store, &env.id).unwrap();
    assert!(list(store).unwrap().is_empty());
    assert!(!store.join(&env.id).exists());
}

#[test]
fn rejects_unsafe_ids_names_and_sources() {
    let env = Env::new();
    let store = env.store.path();
    assert!(rename(store, "../../etc", "x").is_err());
    assert!(delete(store, "..").is_err());
    assert!(add_source(store, &env.id, "/").is_err());
    assert!(add_source(store, &env.id, "/definitely/not/here").is_err());
    if let Some(home) = dirs::home_dir() {
        assert!(add_source(store, &env.id, home.to_str().unwrap()).is_err());
    }
    std::fs::create_dir_all(store.join("sub")).unwrap();
    assert!(add_source(store, &env.id, store.join("sub").to_str().unwrap()).is_err(), "own storage is refused");
    env.write(".env", "TOKEN=1");
    assert!(add_source(store, &env.id, env.src.path().join(".env").to_str().unwrap()).is_err());
    assert!(create(store, "x", Config { kind: "ollama".into(), endpoint: "https://example.com".into(), model: "m".into(), key_id: None }, None).is_err(), "remote Ollama is refused");
    assert!(create(store, "x", env.fake.config(), Some(vec!["[".into()])).is_err(), "bad glob");
}

#[test]
fn first_index_needs_confirmation_and_sends_nothing_before() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    let err = run_with(env.store.path(), &env.id, false, no_pdf, &AtomicBool::new(false), &|_| {}).unwrap_err();
    assert!(err.contains("Confirm"));
    assert_eq!(env.fake.requests.load(Ordering::SeqCst), 0);
    assert!(env.manifest().consented_at.is_none());
    index(env.store.path(), &env.id).unwrap();
    assert!(env.manifest().consented_at.is_some());
    // Once confirmed, later runs need no flag.
    run_with(env.store.path(), &env.id, false, no_pdf, &AtomicBool::new(false), &|_| {}).unwrap();
}

#[test]
fn incremental_reindex_skips_unchanged_files() {
    let env = Env::new();
    env.write("a.md", "# A\napple pie");
    env.write("b.txt", "banana bread\n\nmore banana");
    let first = index(env.store.path(), &env.id).unwrap();
    assert_eq!((first.files, first.unchanged_files), (2, 0));
    assert_eq!(first.embedded, first.chunks);
    let after_first = env.fake.embedded();

    let second = index(env.store.path(), &env.id).unwrap();
    assert_eq!((second.embedded, second.unchanged_files), (0, 2));
    assert_eq!(env.fake.embedded(), after_first, "nothing is sent for unchanged files");

    // Same content with a new modification time: read and hashed, not re-embedded.
    let f = std::fs::File::options().write(true).open(env.src.path().join("a.md")).unwrap();
    f.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
    let third = index(env.store.path(), &env.id).unwrap();
    assert_eq!((third.embedded, third.unchanged_files), (0, 2));
    assert_eq!(env.fake.embedded(), after_first);

    // Changed content: only that file is embedded again.
    env.write("a.md", "# A\napple tart");
    let fourth = index(env.store.path(), &env.id).unwrap();
    assert_eq!((fourth.embedded, fourth.unchanged_files), (1, 1));
    assert_eq!(env.fake.embedded(), after_first + 1);

    // A deleted file leaves the index.
    std::fs::remove_file(env.src.path().join("b.txt")).unwrap();
    let fifth = index(env.store.path(), &env.id).unwrap();
    assert_eq!((fifth.files, fifth.embedded), (1, 0));
    assert_eq!(env.files(), vec!["a.md".to_string()]);
    assert_eq!(env.manifest().status.state, "ready");
}

#[test]
fn skips_ignored_hidden_secret_binary_and_non_utf8_files() {
    let env = Env::new();
    env.write("ok.md", "# Ok\napple");
    env.write(".gitignore", "ignored.md\nignored_dir/\n");
    env.write("ignored.md", "apple secret");
    env.write("ignored_dir/x.md", "apple secret");
    env.write("node_modules/pkg/readme.md", "apple dependency");
    env.write(".hidden/notes.md", "apple hidden");
    env.write(".env.md", "TOKEN=apple");
    env.write("key.pem", "-----BEGIN-----");
    std::fs::write(env.src.path().join("bin.txt"), b"text\0binary").unwrap();
    std::fs::write(env.src.path().join("latin1.txt"), [0x66, 0x6f, 0xff, 0xfe]).unwrap();
    let stats = index(env.store.path(), &env.id).unwrap();
    assert_eq!(env.files(), vec!["ok.md".to_string()]);
    let reasons: Vec<String> = stats.issues.iter().map(|i| format!("{}: {}", i.path, i.reason)).collect();
    assert!(reasons.iter().any(|r| r.contains("bin.txt") && r.contains("Binary")), "{reasons:?}");
    assert!(reasons.iter().any(|r| r.contains("latin1.txt") && r.contains("UTF-8")), "{reasons:?}");
    assert_eq!(stats.skipped, 2);
}

#[cfg(unix)]
#[test]
fn symlinks_pointing_outside_the_picked_folder_are_not_indexed() {
    let env = Env::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "apple outside secret").unwrap();
    std::fs::create_dir(outside.path().join("dir")).unwrap();
    std::fs::write(outside.path().join("dir/more.md"), "apple more").unwrap();
    env.write("real.md", "# Real\napple");
    std::os::unix::fs::symlink(outside.path().join("secret.md"), env.src.path().join("link.md")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("dir"), env.src.path().join("linked")).unwrap();
    let stats = index(env.store.path(), &env.id).unwrap();
    assert_eq!(env.files(), vec!["real.md".to_string()]);
    assert!(stats.issues.iter().any(|i| i.path.ends_with("link.md") && i.reason.contains("Symbolic link")));
    let hits = search(env.store.path(), &[env.id.clone()], "apple", 10).unwrap();
    assert!(hits.iter().all(|h| !h.text.contains("outside") && !h.text.contains("more")));
}

#[test]
fn caps_limit_files_sizes_and_chunks_with_warnings() {
    let env = Env::new();
    for i in 0..5 {
        env.write(&format!("f{i}.md"), &format!("# F{i}\napple {i}"));
    }
    env.write("big.md", &"apple ".repeat(100));
    let dir = env.store.path().join(&env.id);
    update_manifest(&dir, |c| {
        c.caps = Caps { max_files: 3, max_file_bytes: 200, max_total_bytes: 1_000_000, max_pdf_bytes: 1000, max_chunks: 100 };
        Ok(())
    })
    .unwrap();
    let stats = index(env.store.path(), &env.id).unwrap();
    assert_eq!(stats.files, 3);
    assert!(stats.warnings.iter().any(|w| w.contains("File limit")), "{:?}", stats.warnings);
    assert!(stats.issues.iter().any(|i| i.path.ends_with("big.md") && i.reason.contains("Larger than")));

    update_manifest(&dir, |c| {
        c.caps.max_files = 100;
        c.caps.max_total_bytes = 40;
        Ok(())
    })
    .unwrap();
    let stats = index(env.store.path(), &env.id).unwrap();
    assert!(stats.warnings.iter().any(|w| w.contains("Size limit")));
    assert!(stats.files < 5);

    update_manifest(&dir, |c| {
        c.caps.max_total_bytes = 1_000_000;
        c.caps.max_chunks = 2;
        Ok(())
    })
    .unwrap();
    let stats = index(env.store.path(), &env.id).unwrap();
    assert!(stats.warnings.iter().any(|w| w.contains("Chunk limit")));
    assert_eq!(stats.chunks, 2);
    let estimate = estimate(env.store.path(), &env.id).unwrap();
    assert!(estimate.files >= 1 && estimate.bytes > 0);
}

#[test]
fn search_orders_by_similarity_across_collections_and_honours_limit() {
    let env = Env::new();
    env.write("f1.md", "# Fruit\napple apple apple");
    env.write("f2.md", "# Fruit\nbanana banana banana");
    env.write("f3.md", "# Fruit\ncherry cherry cherry");
    env.write("f4.md", "# Mixed\napple banana cherry");
    index(env.store.path(), &env.id).unwrap();
    let other_src = tempfile::tempdir().unwrap();
    std::fs::write(other_src.path().join("g1.md"), "# Other\napple apple").unwrap();
    let other = create(env.store.path(), "Other", env.fake.config(), None).unwrap();
    add_source(env.store.path(), &other.id, other_src.path().to_str().unwrap()).unwrap();
    index(env.store.path(), &other.id).unwrap();

    let hits = search(env.store.path(), &[env.id.clone()], "banana", 3).unwrap();
    assert_eq!(hits.len(), 3);
    assert!(hits[0].source.ends_with("f2.md"));
    assert!(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score);
    assert_eq!(hits[0].heading.as_deref(), Some("Fruit"));
    assert_eq!((hits[0].start, hits[0].end), (1, 2));
    assert_eq!(hits[0].collection, "Docs");

    let both = search(env.store.path(), &[env.id.clone(), other.id.clone()], "apple", 20).unwrap();
    assert_eq!(both.len(), 5);
    assert!(both[0].source.ends_with("f1.md") || both[0].source.ends_with("g1.md"));
    assert!(both.iter().any(|h| h.collection == "Other"));
    assert!(search(env.store.path(), &[env.id.clone()], "  ", 5).is_err());
    assert_eq!(search(env.store.path(), &[env.id.clone()], "apple", 0).unwrap().len(), 1, "limit is clamped to at least one");
}

#[test]
fn deleting_a_collection_or_source_removes_its_vectors() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    index(env.store.path(), &env.id).unwrap();
    let extra = tempfile::tempdir().unwrap();
    std::fs::write(extra.path().join("x.md"), "# X\nbanana").unwrap();
    add_source(env.store.path(), &env.id, extra.path().to_str().unwrap()).unwrap();
    assert_eq!(env.manifest().status.state, "stale");
    index(env.store.path(), &env.id).unwrap();
    assert_eq!(env.files().len(), 2);

    remove_source(env.store.path(), &env.id, extra.path().to_str().unwrap()).unwrap();
    assert_eq!(env.files(), vec!["a.md".to_string()]);
    assert_eq!(env.manifest().status.files, 1);
    let hits = search(env.store.path(), &[env.id.clone()], "banana", 10).unwrap();
    assert!(hits.iter().all(|h| !h.text.contains("banana")));

    delete(env.store.path(), &env.id).unwrap();
    assert!(!env.store.path().join(&env.id).join("index.json").exists());
    assert!(search(env.store.path(), &[env.id.clone()], "apple", 5).unwrap_err().contains("no longer exists"));
}

#[test]
fn cancel_keeps_embedded_vectors_and_resume_only_embeds_the_rest() {
    let env = Env::new();
    for i in 0..40 {
        env.write(&format!("n{i:02}.txt"), &format!("apple number {i}"));
    }
    let cancel = AtomicBool::new(false);
    let stats = run_with(env.store.path(), &env.id, true, no_pdf, &cancel, &|p| {
        if p.phase == "embed" && p.done >= BATCH {
            cancel.store(true, Ordering::SeqCst);
        }
    })
    .unwrap();
    assert!(stats.cancelled);
    assert_eq!(stats.embedded, BATCH);
    assert_eq!(env.manifest().status.state, "partial");
    assert_eq!(env.manifest().status.chunks, BATCH);
    assert_eq!(env.fake.embedded(), BATCH);
    // The partial index is searchable and a later run does not pay for the 16 chunks again.
    assert_eq!(search(env.store.path(), &[env.id.clone()], "apple", 20).unwrap().len(), 20.min(BATCH));
    let sent = env.fake.embedded();
    let resumed = index(env.store.path(), &env.id).unwrap();
    assert!(!resumed.cancelled);
    assert_eq!(resumed.embedded, 40 - BATCH);
    assert_eq!(env.fake.embedded() - sent, 40 - BATCH);
    assert_eq!(env.manifest().status.state, "ready");
}

#[test]
fn cancel_during_scan_keeps_earlier_entries() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    env.write("b.md", "# B\nbanana");
    index(env.store.path(), &env.id).unwrap();
    env.write("b.md", "# B\nbanana changed");
    let cancel = AtomicBool::new(true);
    let stats = run_with(env.store.path(), &env.id, true, no_pdf, &cancel, &|_| {}).unwrap();
    assert!(stats.cancelled);
    assert_eq!(env.files().len(), 2, "unscanned files keep their old entries");
}

#[test]
fn changing_the_embedding_config_requires_confirmation_and_rebuilds() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    index(env.store.path(), &env.id).unwrap();
    let before = env.fake.embedded();
    let mut config = env.fake.config();
    config.model = "other-model".into();
    let c = set_config(env.store.path(), &env.id, config).unwrap();
    assert!(c.consented_at.is_none());
    assert_eq!(c.status.state, "stale");
    assert!(run_with(env.store.path(), &env.id, false, no_pdf, &AtomicBool::new(false), &|_| {}).is_err());
    index(env.store.path(), &env.id).unwrap();
    assert_eq!(env.fake.embedded(), before + 1, "vectors of another model are not reused");
}

#[test]
fn a_missing_source_keeps_its_earlier_entries() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    index(env.store.path(), &env.id).unwrap();
    let moved = env.src.path().with_extension("moved");
    std::fs::rename(env.src.path(), &moved).unwrap();
    let before = env.fake.embedded();
    let stats = index(env.store.path(), &env.id).unwrap();
    assert!(stats.issues.iter().any(|i| i.reason.contains("not found")));
    assert_eq!(env.fake.embedded(), before);
    assert_eq!(stats.files, 1);
    std::fs::rename(&moved, env.src.path()).unwrap();
}

#[test]
fn include_patterns_select_files_and_can_add_code() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    env.write("src/lib.rs", "fn banana() {}");
    index(env.store.path(), &env.id).unwrap();
    assert_eq!(env.files(), vec!["a.md".to_string()]);
    let c = set_include(env.store.path(), &env.id, vec!["**/*.md".into(), "**/*.rs".into()]).unwrap();
    assert_eq!(c.status.state, "stale");
    index(env.store.path(), &env.id).unwrap();
    assert_eq!(env.files(), vec!["a.md".to_string(), "src/lib.rs".to_string()]);
    assert!(set_include(env.store.path(), &env.id, vec![]).is_err());
}

#[test]
fn markdown_chunks_carry_heading_paths_and_line_ranges() {
    let text = "# Title\nintro line\n\n## Setup\nstep one\n\n```sh\n# not a heading\n```\n\n### Deep\ndeep text\n\n## Next\nafter\n\n## Empty\n";
    let chunks = chunk_markdown(text);
    let heads: Vec<_> = chunks.iter().map(|c| c.heading.clone().unwrap()).collect();
    assert_eq!(heads, vec!["Title", "Title > Setup", "Title > Setup > Deep", "Title > Next"]);
    assert_eq!((chunks[0].start, chunks[0].end), (1, 2));
    assert!(chunks[1].text.contains("# not a heading"), "fenced lines stay in their section");
    assert_eq!((chunks[2].start, chunks[2].end), (11, 12));
}

#[test]
fn plain_text_is_packed_by_paragraph_and_long_lines_are_cut() {
    let paragraphs: Vec<String> = (0..30).map(|i| format!("paragraph {i} {}", "word ".repeat(30))).collect();
    let chunks = chunk_plain(&paragraphs.join("\n\n"));
    assert!(chunks.len() > 2 && chunks.len() < 30);
    assert!(chunks.iter().all(|c| c.text.chars().count() <= CHUNK_TARGET + 400));
    assert!(chunks.iter().all(|c| c.heading.is_none()));
    assert!(chunks[0].text.starts_with("paragraph 0"));
    let long = chunk_plain(&"x".repeat(5000));
    assert!(long.len() >= 3 && long.iter().all(|c| c.text.chars().count() <= CHUNK_MAX));
}

fn tiny_pdf(pages: &[&str]) -> Vec<u8> {
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets: Vec<usize> = vec![];
    let add = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, body: String| {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{body}\nendobj\n", offsets.len()).bytes());
    };
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    add(&mut out, &mut offsets, "<< /Type /Catalog /Pages 2 0 R >>".into());
    add(&mut out, &mut offsets, format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()));
    add(&mut out, &mut offsets, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    for (i, text) in pages.iter().enumerate() {
        add(&mut out, &mut offsets, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R /Resources << /Font << /F1 3 0 R >> >> >>", 5 + i * 2));
        let stream = format!("BT /F1 18 Tf 72 700 Td ({text}) Tj ET");
        add(&mut out, &mut offsets, format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()));
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).bytes());
    for o in &offsets {
        out.extend(format!("{o:010} 00000 n \n").bytes());
    }
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1).bytes());
    out
}

#[test]
fn pdf_text_is_extracted_per_page_and_cited_by_page() {
    let env = Env::new();
    std::fs::write(env.src.path().join("paper.pdf"), tiny_pdf(&["apple on page one", "banana on page two"])).unwrap();
    let pages = pdf_inproc(&env.src.path().join("paper.pdf")).unwrap();
    assert_eq!(pages.len(), 2);
    assert!(pages[0].contains("apple on page one") && pages[1].contains("banana on page two"), "{pages:?}");
    let stats = run_with(env.store.path(), &env.id, true, pdf_inproc, &AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!((stats.files, stats.chunks), (1, 2));
    let hits = search(env.store.path(), &[env.id.clone()], "banana", 2).unwrap();
    assert_eq!(hits[0].heading.as_deref(), Some("page 2"));
    assert!(hits[0].source.ends_with("paper.pdf"));
    // Unchanged PDFs are not extracted or embedded again.
    let again = run_with(env.store.path(), &env.id, true, |_| Err("must not run".into()), &AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!((again.unchanged_files, again.embedded), (1, 0));
}

#[test]
fn pdf_failures_are_reported_per_file_and_do_not_stop_the_run() {
    let env = Env::new();
    env.write("good.md", "# Good\napple");
    std::fs::write(env.src.path().join("broken.pdf"), b"%PDF-1.4 this is not a pdf").unwrap();
    std::fs::write(env.src.path().join("empty.pdf"), tiny_pdf(&[""])).unwrap();
    let stats = run_with(env.store.path(), &env.id, true, pdf_inproc, &AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!(env.files(), vec!["good.md".to_string()]);
    let reasons: Vec<String> = stats.issues.iter().map(|i| format!("{}: {}", i.path, i.reason)).collect();
    assert!(reasons.iter().any(|r| r.contains("broken.pdf") && r.contains("PDF extraction failed")), "{reasons:?}");
    assert!(reasons.iter().any(|r| r.contains("empty.pdf") && r.contains("No extractable text")), "{reasons:?}");
}

#[test]
fn pdf_size_cap_is_enforced_before_extraction() {
    let env = Env::new();
    std::fs::write(env.src.path().join("big.pdf"), tiny_pdf(&["apple"])).unwrap();
    update_manifest(&env.store.path().join(&env.id), |c| {
        c.caps.max_pdf_bytes = 50;
        Ok(())
    })
    .unwrap();
    let stats = run_with(env.store.path(), &env.id, true, |_| Err("must not run".into()), &AtomicBool::new(false), &|_| {}).unwrap();
    assert!(stats.issues.iter().any(|i| i.path.ends_with("big.pdf") && i.reason.contains("PDF files")));
    assert_eq!(stats.files, 0);
}

#[test]
fn concurrent_index_runs_of_one_collection_are_refused() {
    let env = Env::new();
    env.write("a.md", "# A\napple");
    let lock = index_lock(&env.store.path().join(&env.id)).unwrap();
    let _held = lock.lock().unwrap();
    let err = index(env.store.path(), &env.id).unwrap_err();
    assert!(err.contains("already being indexed"));
}
