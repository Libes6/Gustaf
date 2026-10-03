import type { ProviderConfig } from "../providers/types";
import { Mic, Square, X } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { useApp } from "../state";
import { transcribe,voiceConfig } from "../lib/voice";
export function VoiceInput({onText,disabled}:{onText:(s:string)=>void;disabled:boolean}) {
 const app=useApp(),ru=app.locale==="ru";
 const [phase,setPhase]=useState<"idle"|"starting"|"recording"|"ready"|"transcribing">("idle"),[error,setError]=useState("");
 const target=useRef<{provider:ProviderConfig;model:string}|null>(null);
 const audio=useRef<Blob|null>(null),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),abort=useRef<AbortController|null>(null),alive=useRef(true),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const cleanup=()=>{if(timer.current)clearTimeout(timer.current);stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();if(recorder.current?.state==="recording")recorder.current.stop();cleanup();audio.current=null;};},[]);
 const start=async()=>{setError("");setPhase("starting");try{
 const config=await voiceConfig();const provider=app.providers.find(p=>p.id===config.providerId&&!p.disabled);if(!provider)throw Error(ru?"Выберите сервис распознавания в Настройки → Общие → Голосовой ввод":"Choose transcription provider in Settings → General → Voice input");
 target.current={provider,model:config.model};
 if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==="undefined")throw Error(ru?"Запись микрофона недоступна в этом WebView":"Microphone recording unavailable in this WebView");
 const media=await navigator.mediaDevices.getUserMedia({audio:true});if(!alive.current){media.getTracks().forEach(t=>t.stop());return;}stream.current=media;
 const mime=["audio/webm;codecs=opus","audio/mp4","audio/ogg;codecs=opus"].find(t=>MediaRecorder.isTypeSupported(t));
 const rec=new MediaRecorder(media,mime?{mimeType:mime}:undefined);recorder.current=rec;const chunks:Blob[]=[];let bytes=0;
 rec.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>16*1024*1024&&rec.state==="recording")rec.stop();}};
 rec.onerror=()=>{cleanup();if(alive.current){setError(ru?"Ошибка записи":"Recording failed");setPhase("idle");}};
 rec.onstop=()=>{cleanup();if(alive.current){audio.current=new Blob(chunks,{type:rec.mimeType});setPhase("ready");}};
 rec.start(1000);setPhase("recording");timer.current=setTimeout(()=>{if(rec.state==="recording")rec.stop();},60000);
 }catch(e){cleanup();if(alive.current){setError(String(e));setPhase("idle");}}};
 const upload=async()=>{if(!audio.current)return;setPhase("transcribing");setError("");const ctl=new AbortController();abort.current=ctl;const timeout=setTimeout(()=>ctl.abort(),90000);try{const destination=target.current;if(!destination)throw Error("Transcription provider unavailable");const text=await transcribe(audio.current,destination.provider,destination.model,ctl.signal);if(alive.current){onText(text);audio.current=null;setPhase("idle");}}catch(e){if(alive.current){setError(String(e));setPhase("ready");}}finally{clearTimeout(timeout);}};
 useEffect(()=>{if(disabled&&recorder.current?.state==="recording")recorder.current.stop();},[disabled]);
 const title=ru?"Голосовой ввод":"Voice input";
 return <div style={{position:"relative",display:"flex",alignItems:"center",gap:4}}>
 <button className="icon-btn" aria-label={phase==="recording"?(ru?"Остановить запись":"Stop recording"):title} title={title} disabled={disabled||phase==="starting"||phase==="transcribing"||phase==="ready"} onClick={()=>phase==="recording"?recorder.current?.stop():void start()}>{phase==="recording"?<Square size={16}/>:<Mic size={16}/>}</button>
 {phase!=="idle"&&<span className="muted" role="status">{phase==="recording"?(ru?"Запись…":"Recording…"):phase==="transcribing"?(ru?"Распознавание…":"Transcribing…"):phase==="starting"?"…":null}</span>}
 {phase==="ready"&&<div className="menu" style={{position:"absolute",bottom:"calc(100% + 8px)",right:0,width:270}}><div className="menu-heading">{ru?"Аудио будет отправлено выбранному сервису распознавания":"Audio will be sent to your configured transcription provider"}<div>{target.current?.provider.name} · {target.current?.provider.baseUrl}</div></div><button className="menu-item" onClick={()=>void upload()}>{ru?"Расшифровать в черновик":"Transcribe into draft"}</button><button className="menu-item" onClick={()=>{audio.current=null;setPhase("idle");}}>{ru?"Удалить запись":"Discard recording"}</button></div>}
 {phase==="transcribing"&&<button className="icon-btn" aria-label={ru?"Отменить распознавание":"Cancel transcription"} onClick={()=>abort.current?.abort()}><X size={14}/></button>}
 {error&&<div role="alert" className="menu" style={{position:"absolute",bottom:"calc(100% + 8px)",right:0,width:300,padding:12}}>{error}<button className="btn-soft" onClick={()=>setError("")}>{ru?"Закрыть":"Close"}</button></div>}
 </div>;
}
