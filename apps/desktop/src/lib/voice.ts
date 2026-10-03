import { fetch } from "../providers/http";
import { getSetting, secrets } from "./api";
import type { ProviderConfig } from "../providers/types";
export type VoiceConfig = { providerId: string; model: string };
export const voiceConfig = () => getSetting<VoiceConfig>("voice", {providerId:"",model:"whisper-1"});
export function transcriptionUrl(base: string) {
 const u=new URL(base);
 if(u.search||u.hash)throw Error("Transcription endpoint cannot contain a query or fragment.");
 u.pathname=u.pathname.replace(/\/$/,"")+"/audio/transcriptions";
 if (u.username||u.password||u.protocol!=="https:"&&!(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname))) throw Error("Use HTTPS or a local transcription server.");
 return u.toString();
}
export async function transcribe(blob: Blob, provider: ProviderConfig, model: string, signal: AbortSignal) {
 if(!blob.size||blob.size>16*1024*1024)throw Error("Audio must be between 1 byte and 16 MB.");
 const key=await secrets.get(`provider:${provider.id}`);
 const form=new FormData();form.append("file",blob,blob.type.includes("mp4")?"voice.m4a":blob.type.includes("ogg")?"voice.ogg":"voice.webm");form.append("model",model.trim()||"whisper-1");
 // Serialize multipart with the browser; Tauri HTTP transports the bytes without changing the boundary.
 const request=new Request(transcriptionUrl(provider.baseUrl),{method:"POST",body:form});
 const response=await fetch(request.url,{method:"POST",body:await request.arrayBuffer(),headers:{"Content-Type":request.headers.get("content-type")!,...(key?{Authorization:`Bearer ${key}`}:{})},signal,connectTimeout:15000,maxRedirections:0});
 if(!response.ok)throw Error(`Transcription HTTP ${response.status}`);
 const data=await response.json();if(typeof data.text!=="string"||!data.text.trim())throw Error("Transcription returned no text.");return data.text.trim().slice(0,30000);
}
