//! User-started dev servers and an isolated loopback HTTP preview with console instrumentation.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};
use tauri::{AppHandle, Manager, State};
static NEXT: AtomicU64=AtomicU64::new(1);
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Info { pub id:u64,pub root:String,pub command:String,pub url:String,pub preview_url:String,pub state:String,pub error:Option<String>,pub logs:String,pub console:Vec<Console>,pub instrumented:bool }
#[derive(Clone, Serialize, Deserialize)]
pub struct Console { pub kind:String,pub message:String }
struct Session { info:Arc<Mutex<Info>>, stopped:Arc<AtomicBool>, killer:Box<dyn ChildKiller+Send+Sync>, master:Box<dyn MasterPty+Send>, #[cfg(unix)]pid:Option<u32> }
impl Drop for Session {fn drop(&mut self){self.stopped.store(true,Ordering::SeqCst);let _=self.killer.kill();#[cfg(unix)]unsafe{if let Some(g)=self.master.process_group_leader(){if g>1&&g!=libc::getpgrp(){libc::kill(-g,libc::SIGKILL);}}if let Some(pid)=self.pid{if pid>1{libc::kill(pid as i32,libc::SIGKILL);}}}}}
#[derive(Default)]pub struct Previews(Arc<Mutex<HashMap<u64,Session>>>);
fn validate_url(value:&str)->Result<reqwest::Url,String>{
 let mut url=reqwest::Url::parse(value).map_err(|e|e.to_string())?;
 if url.scheme()!="http"||!matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"|"::1"))||!url.username().is_empty()||url.password().is_some()||url.fragment().is_some(){return Err("Preview URL must be HTTP on localhost, 127.0.0.1 or ::1, without credentials or fragment".into());}
 if url.host_str()==Some("localhost"){url.set_host(Some("127.0.0.1")).map_err(|e|e.to_string())?;}
 if url.port_or_known_default().unwrap_or(0)<1024{return Err("Use a dev-server port above 1023".into());}Ok(url)
}
fn bounded_append(logs:&mut String,text:&str){logs.push_str(text);if logs.len()>100_000{let mut cut=logs.len()-100_000;while !logs.is_char_boundary(cut){cut+=1;}logs.drain(..cut);}}
fn monitor(token:&str)->String{format!(r#"<script>(function(){{
 const endpoint='/__gustaf_console/{token}';const send=(kind,message)=>{{try{{fetch(endpoint,{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{kind,message:String(message).slice(0,4000)}})}}).catch(()=>{{}})}}catch(_){{}}}};
 const repr=v=>{{try{{return v instanceof Error?v.stack||v.message:typeof v==='string'?v:JSON.stringify(v)}}catch(_){{return String(v)}}}};
 for(const kind of ['error','warn']){{const original=console[kind].bind(console);console[kind]=(...args)=>{{original(...args);send(kind,args.map(repr).join(' '))}}}}
 addEventListener('error',e=>send('error',(e.message||'Resource failed')+' '+(e.filename||e.target?.src||e.target?.href||'')+(e.lineno?':'+e.lineno:'')),true);
 addEventListener('unhandledrejection',e=>send('error',repr(e.reason)));send('ready','Console monitor connected');
}})();</script>"#)}
fn inject(html:&str,token:&str)->String{let script=monitor(token);if let Some(i)=html.to_lowercase().find("<head"){if let Some(end)=html[i..].find('>'){let at=i+end+1;return format!("{}{}{}",&html[..at],script,&html[at..]);}}format!("{script}{html}")}
fn proxy_response(mut request:tiny_http::Request,target:&reqwest::Url,token:&str,info:&Arc<Mutex<Info>>,client:&reqwest::blocking::Client,proxy_origin:&str)->Result<(),String>{
 let path=request.url().to_string();
 let header=|name:&str|request.headers().iter().find(|h|h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h|h.value.as_str().to_string());
 let origin=header("Origin");let referer=header("Referer");
 let same_origin=origin.as_deref()==Some(proxy_origin);
 let same_referer=referer.as_deref().and_then(|r|reqwest::Url::parse(r).ok()).is_some_and(|u|u.origin().ascii_serialization()==proxy_origin);
 let safe=matches!(request.method().as_str(),"GET"|"HEAD");
 let prefix=format!("/__gustaf_preview/{token}");
 let bootstrap=path.starts_with(&format!("{prefix}/"));
 if (!safe&&!same_origin)||(!bootstrap&&!same_origin&&!same_referer)|| (path.starts_with("/__gustaf_preview/")&&!bootstrap){return request.respond(tiny_http::Response::from_string("Unauthorized preview request").with_status_code(403)).map_err(|e|e.to_string());}

 if path==format!("/__gustaf_console/{token}"){
  if request.method().as_str()!="POST"||request.body_length().unwrap_or(0)>16_000{return request.respond(tiny_http::Response::from_string("Invalid console event").with_status_code(400)).map_err(|e|e.to_string());}
  let mut data=String::new();request.as_reader().take(16_001).read_to_string(&mut data).map_err(|e|e.to_string())?;
  if data.len()>16_000{return request.respond(tiny_http::Response::empty(413)).map_err(|e|e.to_string());}
  let event:Console=serde_json::from_str(&data).map_err(|e|e.to_string())?;
  if let Ok(mut state)=info.lock(){if event.kind=="ready"{state.instrumented=true;}else if matches!(event.kind.as_str(),"error"|"warn"){state.console.push(Console{kind:event.kind,message:event.message.chars().take(4000).collect()});if state.console.len()>100{state.console.remove(0);}}}
  return request.respond(tiny_http::Response::empty(204)).map_err(|e|e.to_string());
 }
 if path.starts_with("/__gustaf_console/"){return request.respond(tiny_http::Response::empty(403)).map_err(|e|e.to_string());}
 let path=path.strip_prefix(&prefix).unwrap_or(&path);
 if !path.starts_with('/')||path.starts_with("//"){return request.respond(tiny_http::Response::empty(400)).map_err(|e|e.to_string());}
 let destination=target.join(path).map_err(|e|e.to_string())?;
 if destination.origin()!=target.origin(){return request.respond(tiny_http::Response::empty(403)).map_err(|e|e.to_string());}
 if request.body_length().unwrap_or(0)>1_000_000{return request.respond(tiny_http::Response::empty(413)).map_err(|e|e.to_string());}
 let method=reqwest::Method::from_bytes(request.method().as_str().as_bytes()).map_err(|e|e.to_string())?;
 let mut body=Vec::new();request.as_reader().take(1_000_001).read_to_end(&mut body).map_err(|e|e.to_string())?;
 if body.len()>1_000_000{return request.respond(tiny_http::Response::empty(413)).map_err(|e|e.to_string());}
 let mut outgoing=client.request(method,destination.clone()).header("Accept-Encoding","identity").body(body);
 for header in request.headers(){let name=header.field.as_str().as_str();if !matches!(name.to_lowercase().as_str(),"host"|"connection"|"content-length"|"accept-encoding"|"upgrade"|"origin"|"referer"){outgoing=outgoing.header(name,header.value.as_str());}}
 let response=match outgoing.send(){Ok(r)=>r,Err(e)=>return request.respond(tiny_http::Response::from_string(format!("Dev server unavailable: {e}")).with_status_code(502)).map_err(|e|e.to_string())};
 let status=response.status().as_u16();let headers=response.headers().clone();
 let html=headers.get("content-type").and_then(|h|h.to_str().ok()).is_some_and(|h|h.contains("text/html"));
 let mut bytes=Vec::new();response.take(10_000_001).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
 if bytes.len()>10_000_000{return request.respond(tiny_http::Response::from_string("Preview response exceeds 10MB").with_status_code(413)).map_err(|e|e.to_string());}
 if html{let text=String::from_utf8(bytes).map_err(|e|e.to_string())?;bytes=inject(&text,token).into_bytes();}
 let mut result=tiny_http::Response::from_data(bytes).with_status_code(status);
 for(name,value)in &headers{
  let n=name.as_str();if matches!(n,"content-length"|"content-encoding"|"connection"|"transfer-encoding"|"content-security-policy"|"content-security-policy-report-only"|"x-frame-options"|"access-control-allow-origin"|"etag"){continue;}
  let Ok(value)=value.to_str()else{continue};
  if n=="location"{let next=destination.join(value).map_err(|e|e.to_string())?;if next.origin()!=target.origin(){return request.respond(tiny_http::Response::from_string("External redirect blocked in local preview").with_status_code(403)).map_err(|e|e.to_string());}let rel=format!("{}{}",next.path(),next.query().map(|q|format!("?{q}")).unwrap_or_default());if let Ok(h)=tiny_http::Header::from_bytes("Location",rel){result.add_header(h);}continue;}
  if let Ok(h)=tiny_http::Header::from_bytes(n,value){result.add_header(h);}
 }
 result.add_header(tiny_http::Header::from_bytes("Cache-Control","no-store").unwrap());
 request.respond(result).map_err(|e|e.to_string())
}
fn start(state:&Previews,root:String,command:String,url:String)->Result<Info,String>{start_checked(state,root,command,url,true)}
fn start_checked(state:&Previews,root:String,command:String,url:String,check_port:bool)->Result<Info,String>{
 let root=Path::new(&root).canonicalize().map_err(|e|e.to_string())?;if !root.is_dir(){return Err("Preview project root must be a directory".into());}
 if command.trim().is_empty()||command.len()>4000||command.contains('\0'){return Err("Provide a dev-server command (maximum 4000 characters)".into());}
 let target=validate_url(&url)?;
 let host=target.host_str().ok_or("Preview host missing")?.trim_matches(['[',']']);
 let ip:std::net::IpAddr=host.parse().map_err(|_|"Preview host must resolve to a literal loopback address")?;
 let address=std::net::SocketAddr::new(ip,target.port_or_known_default().unwrap());
 if check_port&&std::net::TcpStream::connect_timeout(&address,Duration::from_millis(300)).is_ok(){return Err("The selected dev-server port is already in use; stop that server or choose another port".into());}
 let mut sessions=state.0.lock().map_err(|e|e.to_string())?;if sessions.len()>=8{return Err("Stop a preview before opening another (maximum 8)".into());}
 if sessions.values().any(|s|s.info.lock().ok().is_some_and(|i|i.root==root.to_string_lossy()&&i.state!="exited")){return Err("This project already has a preview server".into());}
 let server=Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|e|e.to_string())?);let port=server.server_addr().to_ip().ok_or("Preview server address unavailable")?.port();let token=uuid::Uuid::new_v4().to_string();
 let pair=native_pty_system().openpty(PtySize{rows:40,cols:160,pixel_width:0,pixel_height:0}).map_err(|e|e.to_string())?;
 let mut reader=pair.master.try_clone_reader().map_err(|e|e.to_string())?;
 let mut cmd=CommandBuilder::new(crate::shell::Shell::current().program());cmd.args(crate::shell::Shell::current().flags());cmd.arg(&command);cmd.cwd(&root);cmd.env("TERM","dumb");cmd.env("NO_COLOR","1");
 let mut child=pair.slave.spawn_command(cmd).map_err(|e|e.to_string())?;drop(pair.slave);
 let id=NEXT.fetch_add(1,Ordering::SeqCst);let path=format!("{}{}",target.path(),target.query().map(|q|format!("?{q}")).unwrap_or_default());
 let initial=Info{id,root:root.to_string_lossy().into_owned(),command,url:target.to_string(),preview_url:format!("http://127.0.0.1:{port}/__gustaf_preview/{token}{path}"),state:"starting".into(),error:None,logs:String::new(),console:vec![],instrumented:false};
 let info=Arc::new(Mutex::new(initial.clone()));let stopped=Arc::new(AtomicBool::new(false));
 sessions.insert(id,Session{info:info.clone(),stopped:stopped.clone(),killer:child.clone_killer(),master:pair.master,#[cfg(unix)]pid:child.process_id()});drop(sessions);
 let loginfo=info.clone();let stop=stopped.clone();std::thread::spawn(move||{
  let mut buffer=[0u8;8192];loop{match reader.read(&mut buffer){Ok(0)=>break,Ok(n)=>if let Ok(mut state)=loginfo.lock(){bounded_append(&mut state.logs,&String::from_utf8_lossy(&buffer[..n]));},Err(e)if e.kind()==std::io::ErrorKind::Interrupted=>continue,Err(_)=>break}}
  let result=child.wait();if let Ok(mut state)=loginfo.lock(){state.state=if stop.load(Ordering::SeqCst){"stopped"}else{"exited"}.into();if let Ok(status)=result{bounded_append(&mut state.logs,&format!("\n[server exit {}]\n",status.exit_code()));}else{state.error=result.err().map(|e|e.to_string());}}
 });
 for _ in 0..4{let server=server.clone();let target=target.clone();let token=token.clone();let info=info.clone();let stopped=stopped.clone();let proxy_origin=format!("http://127.0.0.1:{port}");std::thread::spawn(move||{
  let Ok(client)=reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build()else{return};
  while !stopped.load(Ordering::SeqCst){match server.recv_timeout(Duration::from_millis(100)){Ok(Some(request))=>{if let Err(e)=proxy_response(request,&target,&token,&info,&client,&proxy_origin){if let Ok(mut state)=info.lock(){state.error=Some(e);}}},Ok(None)=>{},Err(_)=>break}}
 });}
 Ok(initial)
}
#[tauri::command]pub async fn preview_start(state:State<'_,Previews>,root:String,command:String,url:String)->Result<Info,String>{let state=Previews(state.0.clone());tauri::async_runtime::spawn_blocking(move||start(&state,root,command,url)).await.map_err(|e|e.to_string())?}
#[tauri::command]pub async fn preview_status(state:State<'_,Previews>,id:u64)->Result<Info,String>{
 let info=state.0.lock().map_err(|e|e.to_string())?.get(&id).ok_or("Preview is stopped")?.info.clone();
 tauri::async_runtime::spawn_blocking(move||{let mut snapshot=info.lock().map_err(|e|e.to_string())?.clone();if snapshot.state=="starting"||snapshot.state=="running"{let target=validate_url(&snapshot.url)?;let response=reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?.get(target).send();if let Ok(mut current)=info.lock(){if current.state=="starting"||current.state=="running"{current.state=if response.is_ok(){"running"}else{"starting"}.into();}snapshot=current.clone();}}Ok(snapshot)}).await.map_err(|e|e.to_string())?
}
#[tauri::command]pub fn preview_stop(state:State<'_,Previews>,id:u64)->Result<(),String>{state.0.lock().map_err(|e|e.to_string())?.remove(&id);Ok(())}
#[tauri::command]pub fn preview_list(state:State<'_,Previews>,root:String)->Result<Vec<Info>,String>{let root=Path::new(&root).canonicalize().map_err(|e|e.to_string())?;Ok(state.0.lock().map_err(|e|e.to_string())?.values().filter_map(|s|s.info.lock().ok().filter(|i|i.root==root.to_string_lossy()).map(|i|i.clone())).collect())}
pub fn shutdown(app:&AppHandle){if let Some(state)=app.try_state::<Previews>(){if let Ok(mut sessions)=state.0.lock(){sessions.clear();}}}
#[cfg(test)]mod tests{use super::*;
 #[test]fn only_loopback_dev_ports(){for ok in["http://127.0.0.1:3000/","http://localhost:5173/a","http://[::1]:8080/"]{assert!(validate_url(ok).is_ok(),"{ok}");}for bad in["https://example.com","http://localhost.evil:3000","http://127.0.0.1:80","file:///a","http://user:pass@localhost:3000/"]{assert!(validate_url(bad).is_err(),"{bad}");}}
 #[test]fn rejects_existing_server_instead_of_showing_another_project(){let server=tiny_http::Server::http("127.0.0.1:0").unwrap();let port=server.server_addr().to_ip().unwrap().port();let dir=tempfile::tempdir().unwrap();let result=start(&Previews::default(),dir.path().to_string_lossy().into_owned(),"sleep 30".into(),format!("http://127.0.0.1:{port}/"));assert!(result.err().unwrap().contains("already in use"));}
 #[test]fn monitor_is_before_project_scripts(){let html=inject("<!doctype html><html><head><script src='/app.js'></script></head></html>","token");assert!(html.find("__gustaf_console/token").unwrap()<html.find("src='/app.js'").unwrap());assert!(html.contains("unhandledrejection"));}
 #[test]fn real_proxy_instruments_console_and_blocks_external_redirect(){
  let target=tiny_http::Server::http("127.0.0.1:0").unwrap();let port=target.server_addr().to_ip().unwrap().port();
  let origin=std::thread::spawn(move||{for _ in 0..3{let request=target.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();if request.url()=="/redirect"{request.respond(tiny_http::Response::empty(302).with_header(tiny_http::Header::from_bytes("Location","https://example.com/").unwrap())).unwrap();}else{request.respond(tiny_http::Response::from_string("<html><head></head><body>fixture</body></html>").with_header(tiny_http::Header::from_bytes("Content-Type","text/html").unwrap()).with_header(tiny_http::Header::from_bytes("X-Frame-Options","DENY").unwrap())).unwrap();}}});
  let dir=tempfile::tempdir().unwrap();let state=Previews::default();let info=start_checked(&state,dir.path().to_string_lossy().into_owned(),"sleep 30".into(),format!("http://127.0.0.1:{port}/"),false).unwrap();
  let client=reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(5)).build().unwrap();
  let response=client.get(&info.preview_url).send().unwrap();assert!(response.headers().get("x-frame-options").is_none());let html=response.text().unwrap();assert!(html.contains("__gustaf_console/"));assert!(html.contains("fixture"));
  let url=reqwest::Url::parse(&info.preview_url).unwrap();let token=url.path().split('/').nth(2).unwrap();let endpoint=url.join(&format!("/__gustaf_console/{token}")).unwrap();
  assert_eq!(client.post(endpoint.clone()).header("Origin",url.origin().ascii_serialization()).json(&serde_json::json!({"kind":"ready","message":"connected"})).send().unwrap().status().as_u16(),204);
  assert_eq!(client.post(endpoint).header("Origin",url.origin().ascii_serialization()).json(&serde_json::json!({"kind":"error","message":"actual fixture error"})).send().unwrap().status().as_u16(),204);
  let snapshot=state.0.lock().unwrap().get(&info.id).unwrap().info.lock().unwrap().clone();assert!(snapshot.instrumented);assert_eq!(snapshot.console[0].message,"actual fixture error");
  assert_eq!(client.post(url.join("/__gustaf_console/wrong").unwrap()).header("Origin",url.origin().ascii_serialization()).json(&serde_json::json!({"kind":"error","message":"forged"})).send().unwrap().status().as_u16(),403);
  assert_eq!(client.get(url.join("/redirect").unwrap()).header("Referer",info.preview_url.clone()).send().unwrap().status().as_u16(),403);
  let asset=client.get(url.join("/asset.js").unwrap()).header("Referer",&info.preview_url).send().unwrap();assert_eq!(asset.status().as_u16(),200);assert!(asset.text().unwrap().contains("fixture"));
  assert_eq!(client.get(url.join("/private").unwrap()).send().unwrap().status().as_u16(),403);
  assert_eq!(client.get(url.join("/__gustaf_preview/wrong/").unwrap()).header("Referer",&info.preview_url).send().unwrap().status().as_u16(),403);
  assert_eq!(client.post(&info.preview_url).header("Origin","https://evil.example").body("request").send().unwrap().status().as_u16(),403);
  state.0.lock().unwrap().remove(&info.id);origin.join().unwrap();
 }
 #[test]fn logs_are_utf8_bounded(){let mut s="я".repeat(60000);bounded_append(&mut s,"done");assert!(s.len()<=100000);assert!(s.ends_with("done"));}
}
