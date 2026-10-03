//! Opt-in embeddings index. Documents stay in app data; credentials stay in the OS keychain.
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, hash::{Hash, Hasher}, io::Read, path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Manager};
static INDEX_LOCKS: std::sync::OnceLock<std::sync::Mutex<HashMap<String,std::sync::Arc<std::sync::Mutex<()>>>>> = std::sync::OnceLock::new();
fn index_lock(path: &Path) -> Result<std::sync::Arc<std::sync::Mutex<()>>,String> {
    let mut locks=INDEX_LOCKS.get_or_init(||std::sync::Mutex::new(HashMap::new())).lock().map_err(|e|e.to_string())?;
    Ok(locks.entry(path.to_string_lossy().into_owned()).or_insert_with(||std::sync::Arc::new(std::sync::Mutex::new(()))).clone())
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config { pub kind: String, pub endpoint: String, pub model: String, pub key_id: Option<String> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk { pub path: String, pub start: usize, pub end: usize, pub text: String, hash: String, vector: Vec<f32> }
#[derive(Deserialize, Serialize)]
struct Index { version: u32, config: Config, chunks: Vec<Chunk> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats { pub chunks: usize, pub files: usize, pub embedded: usize, pub reused: usize, pub skipped: usize }
#[derive(Serialize)]
pub struct Hit { path: String, start: usize, end: usize, score: f32, text: String }
fn hash(value: &str) -> String { let mut h = std::collections::hash_map::DefaultHasher::new(); value.hash(&mut h); format!("{:016x}", h.finish()) }
fn root_dir(root: &str) -> Result<PathBuf, String> { let p = Path::new(root).canonicalize().map_err(|e| e.to_string())?; if !p.is_dir() { return Err("Project root is not a directory".into()); } Ok(p) }
fn cache_dir(app: &AppHandle, root: &Path) -> Result<PathBuf, String> { Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("semantic").join(hash(&root.to_string_lossy()))) }
fn cache_file(app: &AppHandle, root: &Path, config: &Config) -> Result<PathBuf, String> { Ok(cache_dir(app,root)?.join(format!("{}.json", hash(&serde_json::to_string(config).map_err(|e| e.to_string())?)))) }
fn local(url: &reqwest::Url) -> bool { matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"|"::1")) }
fn endpoint(config: &Config) -> Result<reqwest::Url, String> {
    if config.model.trim().is_empty() || config.model.len() > 200 { return Err("Choose an embeddings model".into()); }
    let base = reqwest::Url::parse(config.endpoint.trim()).map_err(|e| e.to_string())?;
    if !base.username().is_empty() || base.password().is_some() || base.query().is_some() || base.fragment().is_some() { return Err("Embedding endpoint cannot contain credentials, query or fragment".into()); }
    if config.kind == "ollama" && !local(&base) { return Err("Ollama indexing requires a loopback endpoint".into()); }
    if !matches!(config.kind.as_str(),"ollama"|"openai") { return Err("Unknown embeddings provider".into()); }
    if base.scheme() != "https" && !(base.scheme() == "http" && local(&base)) { return Err("Remote embedding endpoints require HTTPS".into()); }
    reqwest::Url::parse(&format!("{}/{}", config.endpoint.trim().trim_end_matches('/'), if config.kind == "ollama" { "api/embed" } else { "embeddings" })).map_err(|e| e.to_string())
}
fn embed(config: &Config, texts: &[String]) -> Result<Vec<Vec<f32>>,String> {
    let endpoint = endpoint(config)?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?;
    let body=if config.kind=="ollama"{serde_json::json!({"model":config.model,"input":texts,"truncate":false})}else{serde_json::json!({"model":config.model,"input":texts})};
    let mut request = client.post(endpoint).json(&body);
    if config.kind == "openai" { if let Some(id) = &config.key_id { if let Some(key) = crate::secrets::read(id).filter(|v| !v.is_empty()) { request = request.bearer_auth(key); } } }
    let response = request.send().map_err(|e|e.to_string())?;
    if !response.status().is_success() { return Err(format!("Embeddings request failed: HTTP {}", response.status())); }
    let mut bytes = Vec::new(); response.take(8_000_001).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len() > 8_000_000 { return Err("Embedding response exceeds 8MB".into()); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
    let arrays: Vec<serde_json::Value> = if config.kind == "ollama" {
        value.get("embeddings").and_then(|v|v.as_array()).ok_or("Missing embedding vectors")?.clone()
    } else {
        let mut data = value.get("data").and_then(|v|v.as_array()).ok_or("Missing embedding data")?.clone();
        data.sort_by_key(|v|v.get("index").and_then(|v|v.as_u64()).unwrap_or(u64::MAX));
        if data.iter().enumerate().any(|(i,v)|v.get("index").and_then(|v|v.as_u64())!=Some(i as u64)) { return Err("Embedding response indices are missing or duplicated".into()); }
        data.into_iter().map(|v|v.get("embedding").cloned().unwrap_or(serde_json::Value::Null)).collect()
    };
    if arrays.len() != texts.len() { return Err("Embedding response count differs from input".into()); }
    let mut result = Vec::new();
    for array in arrays {
        let vector: Vec<f32> = serde_json::from_value(array).map_err(|e|e.to_string())?;
        if vector.is_empty() || vector.len() > 8192 || vector.iter().any(|v|!v.is_finite()) || vector.iter().all(|v|*v==0.0) { return Err("Invalid embedding vector".into()); }
        if result.first().is_some_and(|v: &Vec<f32>|v.len()!=vector.len()) { return Err("Inconsistent embedding dimensions".into()); }
        result.push(vector);
    }
    Ok(result)
}
fn excluded(path: &Path) -> bool {
    path.components().any(|c| matches!(c.as_os_str().to_str(), Some("node_modules"|"target"|"dist"|"build"|"venv"|"__pycache__"|".git"|".next"|".env"))) || path.file_name().and_then(|s|s.to_str()).is_some_and(|s|s.starts_with(".env") || s.ends_with(".pem") || s.ends_with(".key") || s=="package-lock.json" || s=="pnpm-lock.yaml" || s=="yarn.lock" || s=="Cargo.lock")
}
fn split(path: &str, text: &str) -> Vec<Chunk> {
    let lines: Vec<_> = text.lines().collect(); let mut out = Vec::new(); let mut start=0;
    while start < lines.len() {
        let mut end=start; let mut size=0;
        while end<lines.len() && end-start<70 { let count=lines[end].chars().count(); if count>4000 { break; } if end>start && size+count>4000 { break; } size+=count+1;end+=1; }
        if end==start { start+=1;continue; }
        let content=lines[start..end].join("\n");
        if !content.trim().is_empty() { let fingerprint=hash(&format!("{path}:{start}:{end}:{content}")); out.push(Chunk{path:path.into(),start:start+1,end,text:content,hash:fingerprint,vector:vec![]}); }
        if end==lines.len() { break; } start=if end-start>10 {end-10} else {end};
    } out
}
fn collect(root: &Path) -> Result<(Vec<Chunk>,usize),String> {
    let mut chunks=Vec::new(); let mut bytes=0usize; let mut skipped=0;
    let base=root.to_path_buf();
    let walk=WalkBuilder::new(root).follow_links(false).require_git(false).filter_entry(move|e|e.depth()==0||e.path().strip_prefix(&base).is_ok_and(|p|!excluded(p))).build();
    for (visited,entry) in walk.enumerate() {
        if visited>=20_000 { return Err("Project walk exceeds 20000 entries; narrow ignore rules".into()); }
        let entry=entry.map_err(|e|e.to_string())?;
        if !entry.file_type().is_some_and(|t|t.is_file()) {continue;}
        let path=entry.path(); let rel=path.strip_prefix(root).map_err(|e|e.to_string())?;
        if excluded(rel) {continue;}
        let real=path.canonicalize().map_err(|e|e.to_string())?; if !real.starts_with(root) {continue;}
        let size=path.metadata().map_err(|e|e.to_string())?.len();
        if size>512_000 { skipped+=1;continue; }
        let Ok(text)=std::fs::read_to_string(path) else {skipped+=1;continue};
        if text.contains('\0') {skipped+=1;continue;}
        bytes+=text.len(); if bytes>8_000_000 {return Err("Index exceeds 8MB of source text; narrow the project's ignore rules".into());}
        chunks.extend(split(&rel.to_string_lossy().replace('\\',"/"),&text));
        if chunks.len()>2500 {return Err("Index exceeds 2500 chunks; narrow the project's ignore rules".into());}
    } Ok((chunks,skipped))
}
fn build(app: &AppHandle, root: &str, config: &Config) -> Result<(Index,Stats),String> {
    endpoint(config)?;
    let root=root_dir(root)?; let file=cache_file(app,&root,config)?;
    build_at(&root,config,file)
}
fn build_at(root: &Path, config: &Config, file: PathBuf) -> Result<(Index,Stats),String> {
    let lock=index_lock(file.parent().ok_or("Invalid index path")?)?;
    let _guard=lock.lock().map_err(|e|e.to_string())?;
    let previous: Option<Index>=std::fs::read(&file).ok().filter(|v|v.len()<100_000_000).and_then(|v|serde_json::from_slice(&v).ok());
    let vectors:HashMap<_,_>=previous.filter(|i|i.version==1 && i.config==*config).map(|i|i.chunks.into_iter().map(|c|(c.hash,c.vector)).collect()).unwrap_or_default();
    let (mut chunks,skipped)=collect(root)?; let mut reused=0;
    for chunk in &mut chunks { if let Some(vector)=vectors.get(&chunk.hash) {chunk.vector=vector.clone();reused+=1;} }
    let missing:Vec<usize>=chunks.iter().enumerate().filter(|(_,c)|c.vector.is_empty()).map(|(i,_)|i).collect();
    let deadline=std::time::Instant::now()+Duration::from_secs(300);
    for batch in missing.chunks(16) { if std::time::Instant::now()>=deadline {return Err("Index build exceeded five minutes; narrow ignore rules and retry".into());} let input=batch.iter().map(|i|chunks[*i].text.clone()).collect::<Vec<_>>(); for (i,vector) in batch.iter().zip(embed(config,&input)?) {chunks[*i].vector=vector;} }
    if let Some(first)=chunks.first() {if chunks.iter().any(|c|c.vector.len()!=first.vector.len()) {return Err("Model embedding dimensions changed; clear and rebuild the index".into());}}
    let files=chunks.iter().map(|c|c.path.as_str()).collect::<std::collections::HashSet<_>>().len();
    let stats=Stats {chunks:chunks.len(),files,embedded:missing.len(),reused,skipped};
    let index=Index {version:1,config:config.clone(),chunks};
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e|e.to_string())?;
    let temp=file.with_extension(format!("{}.tmp",uuid::Uuid::new_v4()));
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(file.parent().unwrap(),std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?; }
    std::fs::write(&temp,serde_json::to_vec(&index).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&temp,std::fs::Permissions::from_mode(0o600)).map_err(|e|e.to_string())?; }
    std::fs::rename(&temp,file).map_err(|e|e.to_string())?;
    Ok((index,stats))
}
fn cosine(a:&[f32],b:&[f32])->f32 { if a.len()!=b.len() || a.is_empty(){return 0.0;} let mut dot=0.0f64;let mut aa=0.0f64;let mut bb=0.0f64;for(x,y)in a.iter().zip(b){dot+=*x as f64 * *y as f64;aa+=(*x as f64).powi(2);bb+=(*y as f64).powi(2);} if aa==0.0||bb==0.0 {0.0}else{(dot/(aa.sqrt()*bb.sqrt())) as f32} }
#[tauri::command]
pub async fn semantic_build(app:AppHandle,root:String,config:Config)->Result<Stats,String>{tauri::async_runtime::spawn_blocking(move||build(&app,&root,&config).map(|(_,s)|s)).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn semantic_query(app:AppHandle,root:String,config:Config,query:String,limit:Option<usize>)->Result<Vec<Hit>,String>{
    if query.trim().is_empty()||query.len()>4000{return Err("Query requires 1–4000 characters".into());}
    tauri::async_runtime::spawn_blocking(move||{
        let (index,_)=build(&app,&root,&config)?; if index.chunks.is_empty(){return Ok(vec![]);}
        let vector=embed(&config,&[query])?.remove(0);
        if vector.len()!=index.chunks[0].vector.len(){return Err("Query dimensions differ from the cached index; rebuild it".into());}
        let mut hits:Vec<_>=index.chunks.into_iter().map(|c|Hit{path:c.path,start:c.start,end:c.end,score:cosine(&vector,&c.vector),text:c.text.chars().take(1200).collect()}).collect();
        hits.sort_by(|a,b|b.score.total_cmp(&a.score));hits.truncate(limit.unwrap_or(8).clamp(1,20));Ok(hits)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn semantic_clear(app:AppHandle,root:String)->Result<(),String>{tauri::async_runtime::spawn_blocking(move||{let dir=cache_dir(&app,&root_dir(&root)?)?;let lock=index_lock(&dir)?;let _guard=lock.lock().map_err(|e|e.to_string())?;if dir.exists(){std::fs::remove_dir_all(dir).map_err(|e|e.to_string())?;}Ok(())}).await.map_err(|e|e.to_string())?}
#[cfg(test)]mod tests{use super::*;
 #[test]fn endpoint_enforces_local_or_tls(){let c=|kind:&str,url:&str|Config{kind:kind.into(),endpoint:url.into(),model:"embedding".into(),key_id:None};assert!(endpoint(&c("ollama","http://127.0.0.1:11434")).is_ok());assert!(endpoint(&c("ollama","https://example.com")).is_err());assert!(endpoint(&c("openai","http://example.com/v1")).is_err());assert!(endpoint(&c("openai","https://example.com/v1")).is_ok());}
 #[test]fn chunks_overlap_and_keep_line_ranges(){let text=(1..=160).map(|i|format!("line{i}")).collect::<Vec<_>>().join("\n");let chunks=split("src/a.ts",&text);assert_eq!((chunks[0].start,chunks[0].end),(1,70));assert_eq!(chunks[1].start,61);assert_eq!(chunks.last().unwrap().end,160);}
 #[test]fn ignores_generated_secrets_and_symlinks(){let dir=tempfile::tempdir().unwrap();std::fs::write(dir.path().join(".gitignore"),"ignored.txt\n").unwrap();std::fs::write(dir.path().join("ignored.txt"),"secret").unwrap();std::fs::write(dir.path().join(".env"),"password").unwrap();std::fs::create_dir(dir.path().join("node_modules")).unwrap();std::fs::write(dir.path().join("node_modules/a.js"),"package").unwrap();std::fs::write(dir.path().join("a.ts"),"const a = 1;").unwrap();let root=dir.path().canonicalize().unwrap();let(chunks,_)=collect(&root).unwrap();assert_eq!(chunks.len(),1);assert_eq!(chunks[0].path,"a.ts");}
 #[test]fn actual_embeddings_are_cached_and_changed_files_reindexed(){
  let server=tiny_http::Server::http("127.0.0.1:0").unwrap();let port=server.server_addr().to_ip().unwrap().port();
  let count=std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));let calls=count.clone();
  let worker=std::thread::spawn(move||{for _ in 0..3 {let mut request=server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();let mut body=String::new();request.as_reader().read_to_string(&mut body).unwrap();let value:serde_json::Value=serde_json::from_str(&body).unwrap();let n=value["input"].as_array().unwrap().len();calls.fetch_add(n,std::sync::atomic::Ordering::SeqCst);request.respond(tiny_http::Response::from_string(serde_json::json!({"embeddings":value["input"].as_array().unwrap().iter().map(|s|if s.as_str().unwrap().contains("second"){vec![0.,1.]}else{vec![1.,0.]}).collect::<Vec<_>>()}).to_string())).unwrap();}});
  let source=tempfile::tempdir().unwrap();let cache=tempfile::tempdir().unwrap();let root=source.path().canonicalize().unwrap();let file=cache.path().join("index.json");let config=Config{kind:"ollama".into(),endpoint:format!("http://127.0.0.1:{port}"),model:"fixture".into(),key_id:None};
  std::fs::write(root.join("a.ts"),"first").unwrap();let (_,first)=build_at(&root,&config,file.clone()).unwrap();assert_eq!(first.embedded,1);
  let(_,second)=build_at(&root,&config,file.clone()).unwrap();assert_eq!((second.embedded,second.reused),(0,1));
  std::fs::remove_file(root.join("a.ts")).unwrap();std::fs::write(root.join("b.ts"),"second").unwrap();let(index,third)=build_at(&root,&config,file).unwrap();assert_eq!(third.embedded,1);assert_eq!(index.chunks.len(),1);assert_eq!(index.chunks[0].path,"b.ts");
  let query=embed(&config,&["find second".into()]).unwrap().remove(0);assert!((cosine(&query,&index.chunks[0].vector)-1.).abs()<0.001);
  worker.join().unwrap();assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst),3);
 }
 #[test]fn scores_true_cosine(){assert!((cosine(&[1.,0.],&[1.,0.])-1.).abs()<0.001);assert_eq!(cosine(&[1.,0.],&[0.,1.]),0.);}
}
