export function claudeArgs({model,session,access}:{model?:string;session?:string;access?:'readonly'|'auto'|'full'}) {
 return ['-p','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode',access === 'readonly' ? 'plan' : access === 'full' ? 'bypassPermissions' : 'acceptEdits',...(model ? ['--model',model] : []),...(session ? ['--resume',session] : [])];
}
export function parseClaudeEvent(e: any) {
 if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta') return {text:e.event.delta.text};
 if (e.type === 'assistant') return {session:e.session_id};
 if (e.type === 'result') return {session:e.session_id,final:e.result,error:e.is_error ? String(e.result || e.errors?.join('\n') || e.terminal_reason || e.subtype || 'Claude request failed') : undefined};
 return {session:e.session_id};
}
