import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { SemanticSettings } from "../../src/components/SemanticSettings";
import { semanticSearch } from "../../src/agent/semanticSearch";
import { renderApp, makeApp, project } from "./render";
import { callsOf, mockInvoke, mockSettings } from "./tauri";
it("keeps embeddings opt-in and never builds merely by opening Settings",async()=>{
 mockSettings({});renderApp(<SemanticSettings/>,makeApp({projects:[project({path:"/project"})]}));
 const enabled=screen.getByRole("checkbox");expect(enabled).not.toBeChecked();expect(screen.getByRole("button",{name:"Update index"})).toBeDisabled();expect(callsOf("semantic_build")).toHaveLength(0);
 await expect(semanticSearch("/project","find auth")).rejects.toThrow("disabled");expect(callsOf("semantic_query")).toHaveLength(0);
});
it("explicit enabling and index update stores consent before building",async()=>{
 const settings:Record<string,unknown>={};mockInvoke({db_select:({params}:any)=>settings[params[0]]?[{value:JSON.stringify(settings[params[0]])}]:[],db_execute:({params}:any)=>{settings[params[0]]=JSON.parse(params[1]);return[1,1];},semantic_build:{files:2,chunks:3,embedded:3,reused:0,skipped:1}});
 renderApp(<SemanticSettings/>,makeApp({projects:[project({path:"/project"})]}));await userEvent.click(screen.getByRole("checkbox"));await userEvent.click(screen.getByRole("button",{name:"Update index"}));await waitFor(()=>expect(callsOf("semantic_build")).toHaveLength(1));expect(callsOf("semantic_build")[0]).toEqual({root:"/project",config:expect.objectContaining({enabled:true,kind:"ollama",endpoint:"http://127.0.0.1:11434"})});expect(screen.getByRole("status")).toHaveTextContent("2 files");
});
