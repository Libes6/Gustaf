import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ProjectPreview } from "../../src/components/ProjectPreview";
import { renderApp } from "./render";
import { callsOf, mockInvoke, mockSettings } from "./tauri";
import { previewUrlError } from "../../src/lib/projectPreview";

const info={id:7,root:"/project",command:"npm run dev",url:"http://127.0.0.1:5173/",previewUrl:"http://127.0.0.1:45678/__mcode_preview/token/",state:"running",logs:"server output",console:[{kind:"error",message:"fixture failure"}],instrumented:true,error:null};
it("never starts a dev server automatically; explicit Start shows isolated iframe and Stop removes it",async()=>{
 mockSettings({"preview:/project":{command:"npm run dev",url:"http://127.0.0.1:5173/"}});
 mockInvoke({preview_list:[],preview_start:info,preview_status:info,preview_stop:undefined});
 renderApp(<ProjectPreview root="/project"/>);
 await waitFor(()=>expect(screen.getByLabelText("Dev server command")).toHaveValue("npm run dev"));
 expect(callsOf("preview_start")).toHaveLength(0);
 await userEvent.click(screen.getByRole("button",{name:"Start"}));
 await waitFor(()=>expect(screen.getByTitle("Project preview")).toBeInTheDocument());
 expect(callsOf("preview_start")[0]).toEqual({root:"/project",command:"npm run dev",url:"http://127.0.0.1:5173/"});
 const frame=screen.getByTitle("Project preview");expect(frame).toHaveAttribute("src",info.previewUrl);expect(frame).toHaveAttribute("sandbox","allow-scripts allow-forms allow-same-origin");
 await userEvent.click(screen.getByRole("button",{name:"Stop"}));
 await waitFor(()=>expect(screen.queryByTitle("Project preview")).not.toBeInTheDocument());expect(callsOf("preview_stop")[0]).toEqual({id:7});
});
it("exports actual console records as untrusted text only on explicit Send",async()=>{
 mockSettings({});mockInvoke({preview_list:[info],fs_read:"1|{}",preview_status:info});const send=vi.fn();renderApp(<ProjectPreview root="/project" onSendConsole={send}/>);
 await waitFor(()=>expect(screen.getByTitle("Project preview")).toBeInTheDocument());
 await userEvent.click(screen.getByRole("button",{name:"Console 1"}));
 expect(screen.getByText("error: fixture failure")).toBeInTheDocument();expect(send).not.toHaveBeenCalled();await userEvent.click(screen.getByRole("button",{name:"Send to chat"}));expect(send).toHaveBeenCalledWith(expect.stringContaining("untrusted page output"));expect(send).toHaveBeenCalledWith(expect.stringContaining("fixture failure"));
});
it("rejects remote or credential-bearing URLs",()=>{
 expect(previewUrlError("http://127.0.0.1:5173/")).toBeFalsy();expect(previewUrlError("https://example.com/")).toBeTruthy();expect(previewUrlError("http://user:pass@localhost:3000/")).toBeTruthy();expect(previewUrlError("http://localhost.evil:3000/")).toBeTruthy();
});
