import {fireEvent,screen} from "@testing-library/react";
import {describe,it,expect,vi} from "vitest";
import {VoiceInput} from "../../src/components/VoiceInput";
import {transcriptionUrl} from "../../src/lib/voice";
import {renderApp,makeApp,provider} from "./render";
import {mockSettings} from "./tauri";
import {webDomain} from "../../src/agent/web";
describe("Voice and web configuration",()=>{
 it("rejects credential URLs and remote plaintext transcription",()=>{expect(()=>transcriptionUrl("http://remote.test/v1")).toThrow();expect(()=>transcriptionUrl("https://user:secret@remote.test/v1")).toThrow();expect(transcriptionUrl("http://127.0.0.1:8000/v1")).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");});
 it("domain policy matches boundaries, denial wins",()=>{const c={enabled:true,allow:["example.com"],deny:["private.example.com"]};expect(webDomain("https://docs.example.com",c)).toBe("docs.example.com");expect(()=>webDomain("https://badexample.com",c)).toThrow();expect(()=>webDomain("https://private.example.com",c)).toThrow();});
 it("unconfigured voice does not request the microphone",async()=>{const mic=vi.fn();Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:mic}});renderApp(<VoiceInput onText={()=>{}} disabled={false}/>);fireEvent.click(screen.getByRole("button",{name:"Voice input"}));expect(await screen.findByRole("alert")).toHaveTextContent("Choose transcription provider");expect(mic).not.toHaveBeenCalled();});
 it("records on click, stop releases tracks, discard never sends text",async()=>{
 const stop=vi.fn(),mic=vi.fn(async()=>({getTracks:()=>[{stop}]}));Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:mic}});
 class Recorder {static isTypeSupported(){return true;} state="inactive";mimeType="audio/webm";onstop?:()=>void;ondataavailable?:(e:any)=>void;start(){this.state="recording";}stop(){this.state="inactive";this.ondataavailable?.({data:new Blob(["audio"])});this.onstop?.();}}
 vi.stubGlobal("MediaRecorder",Recorder);mockSettings({voice:{providerId:"p1",model:"whisper-1"}});const onText=vi.fn();renderApp(<VoiceInput onText={onText} disabled={false}/>,makeApp({providers:[provider()]}));expect(mic).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Voice input"}));await screen.findByRole("button",{name:"Stop recording"});fireEvent.click(screen.getByRole("button",{name:"Stop recording"}));await screen.findByRole("button",{name:"Discard recording"});expect(stop).toHaveBeenCalled();expect(onText).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Discard recording"}));expect(screen.queryByRole("button",{name:"Transcribe into draft"})).not.toBeInTheDocument();vi.unstubAllGlobals();
 });
});
