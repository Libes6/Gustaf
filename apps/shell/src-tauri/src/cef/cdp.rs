//! Makes one page's DevTools agent look like a browser endpoint, which is what Playwright's
//! `connectOverCDP` speaks. A port of the parts of upstream's Electron `CdpRelay.ts` the spike
//! needs: screencast pacing and downloads are left out.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

const BROWSER_CONTEXT_ID: &str = "gustaf-browser";
const PAGE_SESSION_ID: &str = "gustaf-browser-page";

#[derive(Clone, Copy, PartialEq)]
enum Session {
    Browser,
    Page,
}

struct Pending {
    id: Value,
    session: Option<String>,
}

pub struct Relay {
    /// The page's own target description, as its agent reports it.
    target: Value,
    user_agent: String,
    announced: bool,
    sessions: HashMap<String, Session>,
    session_sequence: u32,
    /// Ids restart with every client connection, so the page sees ids of the relay's own.
    pending: HashMap<i64, Pending>,
    next_id: i64,
    runtime_reset: bool,
}

/// What handling one message asks of the caller.
#[derive(Default)]
pub struct Output {
    pub to_client: Vec<String>,
    pub to_page: Vec<String>,
}

impl Relay {
    pub fn new(target: Value, user_agent: String, first_id: i64) -> Self {
        Self {
            target,
            user_agent,
            announced: false,
            sessions: HashMap::from([(PAGE_SESSION_ID.to_owned(), Session::Page)]),
            session_sequence: 0,
            pending: HashMap::new(),
            next_id: first_id,
            runtime_reset: false,
        }
    }

    fn target_info(&self) -> Value {
        let mut info = self.target.clone();
        info["attached"] = json!(true);
        info["browserContextId"] = json!(BROWSER_CONTEXT_ID);
        info
    }

    fn target_id(&self) -> &str {
        self.target["targetId"].as_str().unwrap_or_default()
    }

    fn new_session(&mut self, kind: Session) -> String {
        self.session_sequence += 1;
        let id = format!("gustaf-browser-{}", self.session_sequence);
        self.sessions.insert(id.clone(), kind);
        id
    }

    /// A message from the client (Playwright, through the server's relay).
    pub fn from_client(&mut self, raw: &str) -> Output {
        let mut output = Output::default();
        let Ok(Value::Object(command)) = serde_json::from_str::<Value>(raw) else {
            return output;
        };
        let (Some(id), Some(method)) = (
            command.get("id").cloned(),
            command.get("method").and_then(Value::as_str),
        ) else {
            return output;
        };
        let session = command
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let params = command.get("params").cloned().unwrap_or_else(|| json!({}));
        let kind = session
            .as_deref()
            .map(|session| self.sessions.get(session).copied());
        let reply = |result: Result<Value, String>| {
            let mut message = Map::new();
            message.insert("id".to_owned(), id.clone());
            match result {
                Ok(result) => message.insert("result".to_owned(), result),
                Err(error) => message.insert(
                    "error".to_owned(),
                    json!({ "code": -32000, "message": error }),
                ),
            };
            if let Some(session) = &session {
                message.insert("sessionId".to_owned(), json!(session));
            }
            Value::Object(message).to_string()
        };

        if matches!(kind, None | Some(Some(Session::Browser))) {
            let was_announced = self.announced;
            output
                .to_client
                .push(reply(self.browser_command(method, &params)));
            if method == "Target.setAutoAttach" && !was_announced {
                output.to_client.push(
                    json!({
                        "method": "Target.attachedToTarget",
                        "params": {
                            "sessionId": PAGE_SESSION_ID,
                            "targetInfo": self.target_info(),
                            "waitingForDebugger": false,
                        },
                    })
                    .to_string(),
                );
            }
            return output;
        }

        // A session the relay did not create belongs to a child frame or worker of the page.
        let child = match kind {
            Some(Some(Session::Page)) => None,
            _ => session.clone(),
        };
        if child.is_none()
            && matches!(
                method,
                // The main page never waits; focus emulation would fight the user's own focus.
                "Runtime.runIfWaitingForDebugger" | "Emulation.setFocusEmulationEnabled"
            )
        {
            output.to_client.push(reply(Ok(json!({}))));
            return output;
        }
        // Runtime stays enabled between connections, and a repeated enable reports no contexts.
        if child.is_none() && method == "Runtime.enable" && !self.runtime_reset {
            self.runtime_reset = true;
            let reset = self.next_id;
            self.next_id += 1;
            output
                .to_page
                .push(json!({ "id": reset, "method": "Runtime.disable" }).to_string());
        }
        let page_id = self.next_id;
        self.next_id += 1;
        self.pending.insert(page_id, Pending { id, session });
        let mut forwarded = json!({ "id": page_id, "method": method, "params": params });
        if let Some(child) = child {
            forwarded["sessionId"] = json!(child);
        }
        output.to_page.push(forwarded.to_string());
        output
    }

    fn browser_command(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "Target.setDiscoverTargets"
            | "Browser.grantPermissions"
            | "Browser.resetPermissions"
            | "Browser.cancelDownload"
            | "Browser.setDownloadBehavior" => Ok(json!({})),
            "Browser.getVersion" => Ok(json!({
                "protocolVersion": "1.3",
                "product": "Gustaf/CEF",
                "revision": "",
                "userAgent": self.user_agent,
                "jsVersion": "",
            })),
            "Target.getTargetInfo" => Ok(json!({
                "targetInfo": {
                    "targetId": "browser",
                    "type": "browser",
                    "title": "",
                    "url": "",
                    "attached": true,
                    "canAccessOpener": false,
                },
            })),
            "Target.getBrowserContexts" => Ok(json!({ "browserContextIds": [] })),
            "Target.getTargets" => Ok(json!({ "targetInfos": [self.target_info()] })),
            "Target.attachToBrowserTarget" => {
                Ok(json!({ "sessionId": self.new_session(Session::Browser) }))
            }
            "Target.attachToTarget" => {
                if params["targetId"].as_str() != Some(self.target_id()) {
                    return Err("Only this tab's page can be attached.".to_owned());
                }
                Ok(json!({ "sessionId": self.new_session(Session::Page) }))
            }
            "Target.detachFromTarget" => {
                if let Some(session) = params["sessionId"].as_str() {
                    if session != PAGE_SESSION_ID {
                        self.sessions.remove(session);
                    }
                }
                Ok(json!({}))
            }
            "Target.setAutoAttach" => {
                self.announced = true;
                Ok(json!({}))
            }
            other => Err(format!("Not supported for a desktop tab: {other}")),
        }
    }

    /// A message from the page's DevTools agent. Returns what the client should receive.
    pub fn from_page(&mut self, raw: &str) -> Vec<String> {
        let Ok(Value::Object(mut message)) = serde_json::from_str::<Value>(raw) else {
            return Vec::new();
        };
        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            // No entry: the relay's own `Runtime.disable`, or a reply for an earlier client.
            let Some(pending) = self.pending.remove(&id) else {
                return Vec::new();
            };
            message.insert("id".to_owned(), pending.id);
            match pending.session {
                Some(session) => message.insert("sessionId".to_owned(), json!(session)),
                None => message.remove("sessionId"),
            };
            return vec![Value::Object(message).to_string()];
        }
        if !self.announced {
            return Vec::new();
        }
        if message.get("sessionId").is_some() {
            return vec![Value::Object(message).to_string()];
        }
        self.sessions
            .iter()
            .filter(|(_, kind)| **kind == Session::Page)
            .map(|(session, _)| {
                let mut copy = message.clone();
                copy.insert("sessionId".to_owned(), json!(session));
                Value::Object(copy).to_string()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay() -> Relay {
        Relay::new(
            json!({ "targetId": "T1", "type": "page", "title": "t", "url": "about:blank" }),
            "UA".to_owned(),
            100,
        )
    }

    fn parse(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn auto_attach_announces_the_page_once() {
        let mut relay = relay();
        let first = relay.from_client(r#"{"id":1,"method":"Target.setAutoAttach","params":{}}"#);
        assert_eq!(first.to_client.len(), 2);
        let announce = parse(&first.to_client[1]);
        assert_eq!(announce["method"], "Target.attachedToTarget");
        assert_eq!(announce["params"]["targetInfo"]["targetId"], "T1");
        let again = relay.from_client(r#"{"id":2,"method":"Target.setAutoAttach","params":{}}"#);
        assert_eq!(again.to_client.len(), 1);
    }

    #[test]
    fn page_commands_lose_the_relay_session_and_replies_get_it_back() {
        let mut relay = relay();
        let sent = relay.from_client(
            r#"{"id":7,"method":"Page.enable","sessionId":"gustaf-browser-page"}"#,
        );
        let forwarded = parse(&sent.to_page[0]);
        assert_eq!(forwarded["id"], 100);
        assert!(forwarded.get("sessionId").is_none());
        let reply = parse(&relay.from_page(r#"{"id":100,"result":{}}"#)[0]);
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["sessionId"], "gustaf-browser-page");
    }

    #[test]
    fn child_sessions_pass_through_and_page_events_reach_every_page_session() {
        let mut relay = relay();
        relay.from_client(r#"{"id":1,"method":"Target.setAutoAttach","params":{}}"#);
        let sent = relay.from_client(r#"{"id":2,"method":"Page.enable","sessionId":"CHILD"}"#);
        assert_eq!(parse(&sent.to_page[0])["sessionId"], "CHILD");
        let child_event = relay.from_page(r#"{"method":"Page.loadEventFired","sessionId":"CHILD"}"#);
        assert_eq!(parse(&child_event[0])["sessionId"], "CHILD");
        let page_event = relay.from_page(r#"{"method":"Page.loadEventFired","params":{}}"#);
        assert_eq!(parse(&page_event[0])["sessionId"], "gustaf-browser-page");
    }
}
