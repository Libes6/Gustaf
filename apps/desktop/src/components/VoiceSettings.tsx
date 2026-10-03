import {useEffect,useState} from "react";
import {useApp} from "../state";
import {setSetting} from "../lib/api";
import {voiceConfig,type VoiceConfig} from "../lib/voice";
export function VoiceSettings(){const app=useApp(),ru=app.locale==="ru";const [config,setConfig]=useState<VoiceConfig>({providerId:"",model:"whisper-1"}),[error,setError]=useState("");useEffect(()=>{voiceConfig().then(setConfig).catch(e=>setError(String(e)));},[]);
 const save=async(next:VoiceConfig)=>{try{await setSetting("voice",next);setConfig(next);setError("");}catch(e){setError(String(e));}};
 return <><h4>{ru?"Голосовой ввод":"Voice input"}</h4><p className="lead">{ru?"Запись до 60 секунд. После подтверждения аудио отправляется на /audio/transcriptions выбранного сервиса. Расшифровка остаётся в черновике. Подписки CLI не предоставляют этот API; можно подключить локальный совместимый сервер.":"Record up to 60 seconds. After confirmation, audio is sent to the selected service's /audio/transcriptions endpoint. Text stays in the draft. CLI subscriptions do not provide this API; a local compatible server can be used."}</p>
 <select className="input" aria-label={ru?"Сервис распознавания":"Transcription provider"} value={config.providerId} onChange={e=>void save({...config,providerId:e.target.value})}><option value="">{ru?"Не настроен":"Not configured"}</option>{app.providers.filter(p=>["openai","custom","lmstudio"].includes(p.kind)&&!p.disabled).map(p=><option key={p.id} value={p.id}>{p.name} · {p.baseUrl}</option>)}</select><label>{ru?"Модель распознавания":"Transcription model"}<input className="input" value={config.model} onChange={e=>setConfig({...config,model:e.target.value})} onBlur={()=>void save(config)}/></label>{error&&<div role="alert">{error}</div>}</>;
}
