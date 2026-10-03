//! Bounded, real stdio Language Server Protocol checks. Never downloads or installs servers.
use serde::{Deserialize, Serialize};
use tauri::Manager;
use serde_json::{json, Value};
use std::{fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::mpsc, time::{Duration, Instant}};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server { pub language: String, pub command: String, pub args: Vec<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic { pub path: String, pub line: u64, pub column: u64, pub end_line: u64, pub end_column: u64, pub severity: String, pub message: String, pub source: Option<String>, pub code: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report { pub status: String, pub server: Option<Server>, pub diagnostics: Vec<Diagnostic>, pub detail: String }
fn executable(root: &Path, name: &str) -> Option<PathBuf> {
    let mut dirs = vec![root.join("node_modules/.bin")];
    if let Some(home) = dirs::home_dir() {
        dirs.extend([home.join(".cargo/bin"), home.join(".local/bin")]);
        if let Ok(items) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<_> = items.filter_map(Result::ok).map(|e| e.path()).collect();
            versions.sort_by_key(|p| p.file_name().and_then(|s|s.to_str()).unwrap_or("").trim_start_matches('v').split('.').map(|s|s.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>());
            versions.reverse();
            dirs.extend(versions.into_iter().map(|p| p.join("bin")));
        }
    }
    dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    #[cfg(unix)] dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    for dir in dirs {
        #[cfg(windows)] let names = vec![format!("{name}.cmd"), format!("{name}.exe"), name.into()];
        #[cfg(not(windows))] let names = vec![name.to_string()];
        for name in names {
            let path = dir.join(name);
            if path.is_file() {
                #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; if fs::metadata(&path).ok()?.permissions().mode() & 0o111 == 0 { continue; } }
                return Some(path);
            }
        }
    }
    None
}
#[tauri::command]
pub fn lsp_detect(app: tauri::AppHandle, root: String) -> Result<Vec<Server>, String> {
    detect(&root, app.path().resource_dir().ok().as_deref())
}
fn detect(root: &str, resource: Option<&Path>) -> Result<Vec<Server>, String> {
    let root = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (language, candidates, stdio) in [("typescript", vec!["typescript-language-server"], true), ("rust", vec!["rust-analyzer"], false), ("python", vec!["basedpyright-langserver", "pyright-langserver", "pylsp"], true)] {
        if let Some(command) = candidates.into_iter().find_map(|name| executable(&root, name)) {
            let args = if stdio && command.file_name().and_then(|s| s.to_str()).is_some_and(|s| !s.starts_with("pylsp")) { vec!["--stdio".into()] } else { vec![] };
            out.push(Server { language: language.into(), command: command.to_string_lossy().into_owned(), args });
        }
    }
    if !out.iter().any(|s| s.language == "typescript") {
        if let Some(server) = bundled_typescript(&root, resource) { out.push(server); }
    }
    Ok(out)
}
fn bundled_typescript(root: &Path, resource: Option<&Path>) -> Option<Server> {
    let mut scripts = Vec::new();
    if let Some(resource) = resource { scripts.push(resource.join("sidecar/node_modules/typescript-language-server/lib/cli.mjs")); }
    #[cfg(debug_assertions)] scripts.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/node_modules/typescript-language-server/lib/cli.mjs"));
    let script = scripts.into_iter().find(|p| p.is_file())?;
    let node = executable(root, "node")?;
    Some(Server { language:"typescript".into(), command:node.to_string_lossy().into_owned(), args:vec![script.to_string_lossy().into_owned(),"--stdio".into()] })
}
fn uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    // Canonical Windows paths carry a filesystem-only verbatim prefix, not a URI authority.
    let text = if let Some(unc) = text.strip_prefix("//?/UNC/") { format!("//{unc}") }
        else { text.strip_prefix("//?/").unwrap_or(&text).to_owned() };
    let mut encoded = String::new();
    for b in text.bytes() { if b.is_ascii_alphanumeric() || b"/-_.~:".contains(&b) { encoded.push(b as char); } else { encoded.push_str(&format!("%{b:02X}")); } }
    if encoded.starts_with("//") { return format!("file:{encoded}"); }
    format!("file://{}{}", if encoded.starts_with('/') { "" } else { "/" }, encoded)
}
fn write_message(input: &mut impl Write, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    write!(input, "Content-Length: {}\r\n\r\n", body.len()).and_then(|_| input.write_all(&body)).and_then(|_| input.flush()).map_err(|e| e.to_string())
}
fn read_message(input: &mut impl BufRead) -> Result<Value, String> {
    let mut size = None;
    let mut count = 0;
    loop {
        let mut line = String::new();
        if input.read_line(&mut line).map_err(|e| e.to_string())? == 0 { return Err("Language server closed its output".into()); }
        count += line.len(); if count > 8192 { return Err("Oversized LSP header".into()); }
        if line == "\r\n" || line == "\n" { break; }
        if let Some((key, value)) = line.split_once(':') { if key.eq_ignore_ascii_case("content-length") { size = value.trim().parse::<usize>().ok(); } }
    }
    let size = size.filter(|n| *n <= 4 * 1024 * 1024).ok_or("Invalid LSP Content-Length")?;
    let mut body = vec![0; size]; input.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}
fn diagnostics(path: &str, values: &Value) -> Vec<Diagnostic> {
    values.as_array().into_iter().flatten().take(1000).filter_map(|d| {
        let range = d.get("range")?; let start = range.get("start")?; let end = range.get("end")?;
        Some(Diagnostic { path: path.into(), line: start.get("line")?.as_u64()? + 1, column: start.get("character")?.as_u64()? + 1, end_line: end.get("line")?.as_u64()? + 1, end_column: end.get("character")?.as_u64()? + 1,
            severity: match d.get("severity").and_then(Value::as_u64) { Some(2)=>"warning", Some(3)=>"information", Some(4)=>"hint", _=>"error" }.into(), message: d.get("message")?.as_str()?.chars().take(8000).collect(), source: d.get("source").and_then(Value::as_str).map(str::to_owned), code: d.get("code").map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())) })
    }).collect()
}
struct Process(Child);
impl Drop for Process { fn drop(&mut self) {
    #[cfg(unix)] unsafe { let group = self.0.id() as i32; if group > 1 && group != libc::getpgrp() { libc::kill(-group, libc::SIGKILL); } }
    #[cfg(windows)] { let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &self.0.id().to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
    let _ = self.0.kill(); let _ = self.0.wait();
} }
#[cfg(test)]
fn check(root: &str, path: &str, timeout_ms: u64) -> Result<Report, String> { check_with_server(root, path, timeout_ms, None, None) }
fn check_with_server(root: &str, path: &str, timeout_ms: u64, provided: Option<Server>, resource: Option<&Path>) -> Result<Report, String> {
    let base = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let file = crate::tools::resolve_in_root(&base, path)?;
    let extension = file.extension().and_then(|s| s.to_str()).unwrap_or("");
    let (language, language_id) = match extension { "ts"=>("typescript","typescript"), "tsx"=>("typescript","typescriptreact"), "js"=>("typescript","javascript"), "jsx"=>("typescript","javascriptreact"), "rs"=>("rust","rust"), "py"=>("python","python"), _=>return Ok(Report { status:"unavailable".into(), server:None, diagnostics:vec![], detail:"No supported language server for this file type".into() }) };
    let Some(server) = provided.or_else(|| detect(root, resource).ok()?.into_iter().find(|s| s.language == language)) else { return Ok(Report { status:"unavailable".into(), server:None, diagnostics:vec![], detail:format!("No installed {language} language server; use the configured diagnostics command fallback") }); };
    if fs::metadata(&file).map_err(|e| e.to_string())?.len() > 1024 * 1024 { return Err("LSP file exceeds 1 MiB".into()); }
    let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    #[cfg(windows)] let mut command = if server.command.ends_with(".cmd") { let mut c = Command::new("cmd.exe"); c.args(["/D", "/S", "/C", &format!("\"{}\" {}", server.command, server.args.join(" "))]); c } else { let mut c=Command::new(&server.command); c.args(&server.args); c };
    #[cfg(not(windows))] let mut command = { let mut c=Command::new(&server.command); c.args(&server.args); c };
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut process = Process(command.current_dir(&base).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("Language server launch failed: {e}"))?);
    let mut input = process.0.stdin.take().ok_or("LSP stdin unavailable")?;
    let output = process.0.stdout.take().ok_or("LSP stdout unavailable")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || { let mut reader = BufReader::new(output); loop { let message = read_message(&mut reader); let failed = message.is_err(); if sender.send(message).is_err() || failed { break; } } });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(1000, 120000));
    let file_uri = uri(&file);
    let tsserver = server.args.first().and_then(|arg| Path::new(arg).parent()?.parent()?.parent()).map(|dir| dir.join("typescript/lib/tsserver.js")).filter(|path| path.is_file());
    let initialization_options = tsserver.map(|path| json!({"tsserver":{"path":path.to_string_lossy()}})).unwrap_or(Value::Null);
    write_message(&mut input, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":std::process::id(),"rootUri":uri(&base),"initializationOptions":initialization_options,"workspaceFolders":[{"uri":uri(&base),"name":base.file_name().and_then(|s|s.to_str()).unwrap_or("project")}],"capabilities":{"textDocument":{"publishDiagnostics":{"relatedInformation":false},"synchronization":{"didSave":true}},"workspace":{"configuration":true}}}}))?;
    let mut initialized = false;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() { return Ok(Report { status:"timeout".into(), server:Some(server), diagnostics:vec![], detail:"Language server did not publish diagnostics before the deadline; no clean-check claim".into() }); }
        let message = match receiver.recv_timeout(remain) { Ok(Ok(v))=>v, Ok(Err(e))=>return Err(e), Err(_)=>continue };
        if message.get("id") == Some(&json!(1)) && message.get("method").is_none() && !initialized {
            if let Some(error) = message.get("error") { return Err(format!("LSP initialize failed: {error}")); }
            initialized = true;
            write_message(&mut input, &json!({"jsonrpc":"2.0","method":"initialized","params":{}}))?;
            write_message(&mut input, &json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":file_uri,"languageId":language_id,"version":1,"text":text}}}))?;
        } else if message.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics") && message.pointer("/params/uri").and_then(Value::as_str) == Some(&file_uri) {
            let result = diagnostics(path, &message["params"]["diagnostics"]);
            let _ = write_message(&mut input, &json!({"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}));
            let _ = write_message(&mut input, &json!({"jsonrpc":"2.0","method":"exit","params":null}));
            return Ok(Report { status:"complete".into(), server:Some(server), diagnostics:result, detail:"Language-server diagnostic snapshot (1-based lines, UTF-16 columns). Background analysis may continue; an empty snapshot is not proof that project tests/checks passed.".into() });
        } else if let Some(id) = message.get("id") {
            // Respond to server requests; never let an unanswered request deadlock initialization.
            let result = match message.get("method").and_then(Value::as_str) { Some("workspace/configuration")=>json!(message.pointer("/params/items").and_then(Value::as_array).map(|xs| vec![Value::Null;xs.len()]).unwrap_or_default()), Some("window/workDoneProgress/create")|Some("client/registerCapability")=>Value::Null, Some("workspace/applyEdit")=>json!({"applied":false,"failureReason":"Diagnostic sessions do not apply edits"}), _=>Value::Null };
            write_message(&mut input, &json!({"jsonrpc":"2.0","id":id,"result":result}))?;
        }
    }
}
#[tauri::command]
pub async fn lsp_diagnostics(app: tauri::AppHandle, root: String, path: String, timeout_ms: Option<u64>) -> Result<Report, String> {
    let resource = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || check_with_server(&root, &path, timeout_ms.unwrap_or(30000), None, resource.as_deref())).await.map_err(|e| e.to_string())?
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn framing_and_ranges_are_real_lsp_not_plaintext() {
        let value=json!({"jsonrpc":"2.0","method":"test","params":{"text":"привет"}});
        let mut bytes=vec![];write_message(&mut bytes,&value).unwrap();
        assert_eq!(read_message(&mut BufReader::new(bytes.as_slice())).unwrap(),value);
        let items=diagnostics("src/a.ts",&json!([{"range":{"start":{"line":2,"character":4},"end":{"line":2,"character":8}},"severity":2,"message":"Wrong type","source":"ts","code":2322}]));
        assert_eq!(items[0].line,3);assert_eq!(items[0].column,5);assert_eq!(items[0].severity,"warning");
        assert!(read_message(&mut BufReader::new(b"Content-Length: 999999999\r\n\r\n".as_slice())).is_err());
    }
    #[test] fn uri_encodes_unicode_spaces_and_fragment_characters() {
        assert_eq!(uri(Path::new("/tmp/a b#c.ts")),"file:///tmp/a%20b%23c.ts");
        assert!(uri(Path::new("/tmp/тест.py")).contains("%D1"));
        assert_eq!(uri(Path::new(r"C:\work\a b.ts")), "file:///C:/work/a%20b.ts");
        assert_eq!(uri(Path::new(r"\\?\C:\work\a b.ts")), "file:///C:/work/a%20b.ts");
        assert_eq!(uri(Path::new(r"\\?\UNC\server\share\a.ts")), "file://server/share/a.ts");
    }
    #[cfg(unix)]
    #[test] fn stdio_session_opens_file_and_returns_structured_diagnostics() {
        if !Path::new("/usr/bin/python3").is_file() { return; }
        let dir=tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a b.ts"), "const value: number = 'wrong';").unwrap();
        let script=dir.path().join("server.py");
        fs::write(&script, r#"import sys,json
while True:
    size=0
    while True:
        line=sys.stdin.buffer.readline()
        if not line: sys.exit(0)
        if line in (b'\r\n', b'\n'): break
        if line.lower().startswith(b'content-length:'): size=int(line.split(b':')[1])
    value=json.loads(sys.stdin.buffer.read(size))
    method=value.get('method')
    if method=='initialize': result={'jsonrpc':'2.0','id':value['id'],'result':{'capabilities':{}}}
    elif method=='textDocument/didOpen':
        result={'jsonrpc':'2.0','method':'textDocument/publishDiagnostics','params':{'uri':value['params']['textDocument']['uri'],'diagnostics':[{'range':{'start':{'line':0,'character':6},'end':{'line':0,'character':11}},'severity':1,'message':'Wrong type','code':2322}]}}
    elif method=='exit': sys.exit(0)
    else: continue
    body=json.dumps(result).encode()
    sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n'%len(body)).encode()+body)
    sys.stdout.buffer.flush()
"#).unwrap();
        let server=Server { language:"typescript".into(),command:"/usr/bin/python3".into(),args:vec![script.to_str().unwrap().into()] };
        // Allow cold interpreter startup on hosted CI runners; production keeps its own timeout.
        let report=check_with_server(dir.path().to_str().unwrap(),"a b.ts",15000,Some(server), None).unwrap();
        assert_eq!(report.status,"complete"); assert_eq!(report.diagnostics[0].line,1); assert_eq!(report.diagnostics[0].column,7);
        assert_eq!(report.diagnostics[0].path,"a b.ts");
        assert!(check(dir.path().to_str().unwrap(),"../outside.ts",1000).is_err());
    }

    #[test] fn bundled_typescript_reports_a_real_type_error() {
        let dir=tempfile::tempdir().unwrap();
        let Some(server)=bundled_typescript(dir.path(), None) else { eprintln!("SKIP: bundled TypeScript LSP or installed Node unavailable"); return; };
        fs::write(dir.path().join("tsconfig.json"), r#"{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}"#).unwrap();
        fs::write(dir.path().join("wrong.ts"), "const value: number = 'wrong';\n").unwrap();
        let report=check_with_server(dir.path().to_str().unwrap(),"wrong.ts",15000,Some(server),None).unwrap();
        assert_eq!(report.status,"complete", "{}",report.detail);
        let error=report.diagnostics.iter().find(|d|d.code.as_deref()==Some("2322")).expect("TypeScript LSP did not report TS2322");
        assert_eq!(error.path,"wrong.ts"); assert_eq!(error.line,1); assert_eq!(error.severity,"error");
        assert!(error.end_column>error.column);
    }

}
