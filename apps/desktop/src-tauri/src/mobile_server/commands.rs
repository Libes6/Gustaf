//! Commands the phone sends that only the webview can run (the agent loop lives in TypeScript): send a message, stop a run,
//! start a chat. The server forwards each one as a Tauri event (`mobile-command`) and waits for the webview's answer
//! (`mobile_command_reply`); the run itself then continues in the webview, so a request returns as soon as it was accepted.

use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::oneshot;

/// Delivers a command to the webview.
pub trait Sink: Send + Sync {
    fn emit(&self, id: u64, kind: &str, payload: &Value);
}

/// What the webview answers. `code` is one of `busy`, `not_found`, `bad_request`, `failed` when `ok` is false.
#[derive(Debug, Clone)]
pub struct Reply {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub data: Value,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BusError {
    /// No webview is attached (the server runs in a test, or the app is shutting down).
    Unavailable,
    /// The webview did not answer in time (window closed, busy, or the handler is not mounted).
    Timeout,
}

#[derive(Default)]
pub struct CommandBus {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sink: Mutex<Option<Arc<dyn Sink>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl CommandBus {
    pub fn set_sink(&self, sink: Option<Arc<dyn Sink>>) {
        *lock(&self.sink) = sink;
    }

    /// Sends a command and waits for the answer.
    pub async fn request(
        &self,
        kind: &str,
        payload: Value,
        wait: Duration,
    ) -> Result<Reply, BusError> {
        let sink = lock(&self.sink).clone().ok_or(BusError::Unavailable)?;
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id, tx);
        sink.emit(id, kind, &payload);
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(BusError::Unavailable),
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(BusError::Timeout)
            }
        }
    }

    /// The webview's answer. False when nobody waits for `id` any more (it timed out).
    pub fn reply(&self, id: u64, reply: Reply) -> bool {
        match lock(&self.pending).remove(&id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo(Arc<CommandBus>);
    impl Sink for Echo {
        fn emit(&self, id: u64, kind: &str, payload: &Value) {
            let bus = self.0.clone();
            let ok = kind != "fail";
            let data = payload.clone();
            tokio::spawn(async move {
                bus.reply(
                    id,
                    Reply {
                        ok,
                        code: if ok { String::new() } else { "busy".into() },
                        message: String::new(),
                        data,
                    },
                );
            });
        }
    }
    struct Silent;
    impl Sink for Silent {
        fn emit(&self, _: u64, _: &str, _: &Value) {}
    }

    #[tokio::test]
    async fn answers_reach_the_waiting_request() {
        let bus = Arc::new(CommandBus::default());
        bus.set_sink(Some(Arc::new(Echo(bus.clone()))));
        let r = bus
            .request(
                "send",
                serde_json::json!({"chatId": 3}),
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert!(r.ok);
        assert_eq!(r.data["chatId"], 3);
        let r = bus
            .request("fail", Value::Null, Duration::from_secs(2))
            .await
            .unwrap();
        assert!(!r.ok);
        assert_eq!(r.code, "busy");
    }

    #[tokio::test]
    async fn no_webview_and_no_answer_are_distinct_errors() {
        let bus = Arc::new(CommandBus::default());
        assert_eq!(
            bus.request("send", Value::Null, Duration::from_millis(50))
                .await
                .unwrap_err(),
            BusError::Unavailable
        );
        bus.set_sink(Some(Arc::new(Silent)));
        assert_eq!(
            bus.request("send", Value::Null, Duration::from_millis(50))
                .await
                .unwrap_err(),
            BusError::Timeout
        );
        // A late answer is ignored, not delivered to a later request.
        assert!(!bus.reply(
            1,
            Reply {
                ok: true,
                code: String::new(),
                message: String::new(),
                data: Value::Null
            }
        ));
    }
}
