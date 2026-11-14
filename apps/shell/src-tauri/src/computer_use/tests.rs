//! The executor against a fake Mac: nothing here touches the real screen, mouse or keyboard.

use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};

use serde_json::{json, Value};

use super::channel::{self, Channel};
use super::*;

struct World {
    permissions: Permissions,
    /// The helper could not be asked, such as when it failed to start.
    permissions_fail: bool,
    displays: Vec<Display>,
    probe: Probe,
    inputs: Vec<Input>,
    calls: usize,
    /// The input with this index waits for `gate` after telling `entered`.
    pause_at: Option<(usize, mpsc::Sender<()>, mpsc::Receiver<()>)>,
}

const GRANTED: Permissions = Permissions {
    screen_recording: true,
    accessibility: true,
};

fn display(id: u32, x: f64, y: f64, width: f64, height: f64, scale: f64) -> Display {
    Display {
        id,
        name: format!("Display {id}"),
        main: id == 1,
        bounds: Rect {
            x,
            y,
            width,
            height,
        },
        scale,
    }
}

fn world() -> Arc<Mutex<World>> {
    Arc::new(Mutex::new(World {
        permissions: GRANTED,
        permissions_fail: false,
        displays: vec![
            display(1, 0.0, 0.0, 1440.0, 900.0, 2.0),
            display(2, -1920.0, -200.0, 1920.0, 1080.0, 1.0),
        ],
        probe: Probe::default(),
        inputs: Vec::new(),
        calls: 0,
        pause_at: None,
    }))
}

struct Fake(Arc<Mutex<World>>);

impl Backend for Fake {
    fn permissions(&mut self) -> Result<Permissions, String> {
        let mut world = self.0.lock().unwrap();
        world.calls += 1;
        if world.permissions_fail {
            return Err("helper-timed-out".into());
        }
        Ok(world.permissions)
    }
    fn open_settings(&mut self, _permission: Permission) -> Result<(), String> {
        Ok(())
    }
    fn displays(&mut self) -> Result<Vec<Display>, String> {
        Ok(self.0.lock().unwrap().displays.clone())
    }
    fn probe(&mut self) -> Result<Probe, String> {
        Ok(self.0.lock().unwrap().probe.clone())
    }
    fn capture(&mut self, _display: u32, width: u32, height: u32) -> Result<RawImage, String> {
        Ok(RawImage {
            data: "iVBORw0KGgo=".into(),
            width,
            height,
        })
    }
    fn input(&mut self, input: &Input) -> Result<(), String> {
        let pause = {
            let mut world = self.0.lock().unwrap();
            let index = world.inputs.len();
            match world.pause_at.take() {
                Some((at, entered, gate)) if at == index => Some((entered, gate)),
                other => {
                    world.pause_at = other;
                    None
                }
            }
        };
        if let Some((entered, gate)) = pause {
            entered.send(()).unwrap();
            gate.recv().unwrap();
        }
        self.0.lock().unwrap().inputs.push(input.clone());
        Ok(())
    }
    fn activate(&mut self, _app: &str) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct HostLog {
    decline: bool,
    fail_start: bool,
    saved: Vec<bool>,
    started: Vec<String>,
    ended: Vec<EndReason>,
}

struct FakeHost {
    log: Arc<Mutex<HostLog>>,
    ended: Mutex<mpsc::Sender<EndReason>>,
}

impl Host for FakeHost {
    fn confirm_enable(&self) -> bool {
        !self.log.lock().unwrap().decline
    }
    fn save_enabled(&self, enabled: bool) -> Result<(), String> {
        self.log.lock().unwrap().saved.push(enabled);
        Ok(())
    }
    fn session_started(&self, owner: &Owner) -> Result<(), String> {
        let mut log = self.log.lock().unwrap();
        if log.fail_start {
            return Err("shortcut taken".into());
        }
        log.started.push(owner.label.clone());
        Ok(())
    }
    fn session_ended(&self, reason: EndReason) {
        self.log.lock().unwrap().ended.push(reason);
        let _ = self.ended.lock().unwrap().send(reason);
    }
}

struct Rig {
    executor: Arc<Executor>,
    world: Arc<Mutex<World>>,
    log: Arc<Mutex<HostLog>>,
    ended: mpsc::Receiver<EndReason>,
    lock_path: PathBuf,
}

fn rig_with(enabled: bool, lock_path: PathBuf) -> Rig {
    let world = world();
    let log = Arc::new(Mutex::new(HostLog::default()));
    let (send, ended) = mpsc::channel();
    let executor = Arc::new(Executor::new(
        true,
        enabled,
        lock_path.clone(),
        "Gustaf Test".into(),
        Box::new(Fake(Arc::clone(&world))),
        Box::new(FakeHost {
            log: Arc::clone(&log),
            ended: Mutex::new(send),
        }),
    ));
    Rig {
        executor,
        world,
        log,
        ended,
        lock_path,
    }
}

fn rig() -> Rig {
    rig_with(true, lock::tempdir().join("owner.lock"))
}

fn owner(label: &str) -> Owner {
    Owner {
        environment_id: "env-1".into(),
        thread_id: format!("thread-{label}"),
        label: label.into(),
    }
}

fn point(capture_id: &str, x: f64, y: f64) -> ImagePoint {
    ImagePoint {
        capture_id: capture_id.into(),
        x,
        y,
    }
}

fn keys(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

#[test]
fn status_follows_platform_switch_permissions_and_session() {
    let none = Permissions {
        screen_recording: false,
        accessibility: false,
    };
    let screen_only = Permissions {
        screen_recording: true,
        accessibility: false,
    };
    // (supported, enabled, permissions, expected, message start refuses with)
    let cases = [
        (
            false,
            true,
            GRANTED,
            Availability::Unsupported,
            Some(ErrorCode::Unsupported),
        ),
        (
            true,
            false,
            GRANTED,
            Availability::Disabled,
            Some(ErrorCode::Disabled),
        ),
        (
            true,
            true,
            none,
            Availability::PermissionsRequired,
            Some(ErrorCode::PermissionRequired),
        ),
        (
            true,
            true,
            screen_only,
            Availability::PermissionsRequired,
            Some(ErrorCode::PermissionRequired),
        ),
        (true, true, GRANTED, Availability::Ready, None),
    ];
    for (supported, enabled, permissions, expected, refusal) in cases {
        let rig = rig_with(enabled, lock::tempdir().join("owner.lock"));
        let executor = Executor::new(
            supported,
            enabled,
            rig.lock_path.clone(),
            "Gustaf Test".into(),
            Box::new(Fake(Arc::clone(&rig.world))),
            Box::new(FakeHost {
                log: Arc::clone(&rig.log),
                ended: Mutex::new(mpsc::channel().0),
            }),
        );
        rig.world.lock().unwrap().permissions = permissions;
        assert_eq!(executor.status().availability, expected);
        let started = executor.start(1, owner("A"));
        assert_eq!(started.as_ref().err().map(|error| error.code), refusal);
        if started.is_ok() {
            assert_eq!(executor.status().availability, Availability::Active);
        }
    }
    let rig = rig();
    rig.world.lock().unwrap().permissions = screen_only;
    let refused = rig.executor.start(1, owner("A")).unwrap_err();
    assert!(refused.message.contains("needs Accessibility permission"));
    // A helper that cannot be asked names no permission as missing; clients say the check failed.
    rig.world.lock().unwrap().permissions_fail = true;
    let unknown = rig.executor.status();
    assert_eq!(unknown.availability, Availability::PermissionsRequired);
    assert_eq!(unknown.permissions, None);
    // A disabled feature never starts the helper to ask.
    let rig = rig_with(false, lock::tempdir().join("owner.lock"));
    assert_eq!(rig.executor.status().permissions, None);
    assert_eq!(rig.world.lock().unwrap().calls, 0);
}

#[test]
fn one_owner_controls_the_mac_across_threads_and_instances() {
    let first = rig();
    let token = first.executor.start(1, owner("Thread A")).unwrap();
    assert_eq!(first.executor.start(1, owner("Thread A")).unwrap(), token);
    let other_thread = first.executor.start(2, owner("Thread B")).unwrap_err();
    assert_eq!(other_thread.code, ErrorCode::Busy);
    assert!(other_thread.message.contains("\"Thread A\""));
    // Another Gustaf instance finds the same lock file.
    let second = rig_with(true, first.lock_path.clone());
    let other_instance = second.executor.start(1, owner("Thread C")).unwrap_err();
    assert_eq!(other_instance.code, ErrorCode::Busy);
    assert!(other_instance
        .message
        .contains("\"Thread A\" in Gustaf Test"));
    assert!(second.log.lock().unwrap().started.is_empty());

    first.executor.stop(1, Some(&token)).unwrap();
    assert_eq!(first.ended.recv().unwrap(), EndReason::StoppedByOwner);
    second.executor.start(1, owner("Thread C")).unwrap();
}

#[test]
fn a_session_without_an_emergency_stop_does_not_start() {
    let rig = rig();
    rig.log.lock().unwrap().fail_start = true;
    let refused = rig.executor.start(1, owner("A")).unwrap_err();
    assert_eq!(refused.code, ErrorCode::EmergencyStopUnavailable);
    assert_eq!(rig.executor.status().availability, Availability::Ready);
    // The lock was not kept.
    rig.log.lock().unwrap().fail_start = false;
    rig_with(true, rig.lock_path.clone())
        .executor
        .start(1, owner("B"))
        .unwrap();
}

/// Runs `action`, stops control while input `pause_at` is being posted, and returns every
/// input the Mac received, including what the stop released.
fn stopped_mid_action(
    action: Action,
    pause_at: usize,
    screenshot: bool,
) -> (Rig, String, Vec<Input>) {
    let rig = rig();
    let token = rig.executor.start(1, owner("A")).unwrap();
    if screenshot {
        rig.executor
            .screenshot(1, &token, None, None, None)
            .unwrap();
    }
    let (entered_send, entered) = mpsc::channel();
    let (open, gate) = mpsc::channel();
    rig.world.lock().unwrap().pause_at = Some((pause_at, entered_send, gate));
    let executor = Arc::clone(&rig.executor);
    let acting_token = token.clone();
    let acting = std::thread::spawn(move || executor.act(1, &acting_token, action));
    entered.recv().unwrap();
    let ended = rig.executor.detach(EndReason::StoppedByUser).unwrap();
    open.send(()).unwrap();
    assert_eq!(
        acting.join().unwrap().unwrap_err().code,
        ErrorCode::Cancelled
    );
    rig.executor.release(ended);
    let inputs = rig.world.lock().unwrap().inputs.clone();
    (rig, token, inputs)
}

#[test]
fn stopping_mid_drag_cancels_the_rest_and_releases_the_button() {
    let drag = Action::Drag {
        from: point("c1", 10.0, 10.0),
        to: point("c1", 600.0, 400.0),
        button: Button::Left,
    };
    let (rig, token, inputs) = stopped_mid_action(drag, 2, true);
    let kinds: Vec<_> = inputs
        .iter()
        .map(|input| match input {
            Input::Move { dragging: None, .. } => "move",
            Input::Move {
                dragging: Some(_), ..
            } => "drag",
            Input::Button { down: true, .. } => "down",
            Input::Button { down: false, .. } => "up",
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    // The step already posting finishes; the seven remaining drag steps never run.
    assert_eq!(kinds, ["move", "down", "drag", "up"]);
    assert_eq!(rig.log.lock().unwrap().ended, [EndReason::StoppedByUser]);
    // Nothing is accepted after the stop, screenshots included.
    let after = rig
        .executor
        .act(1, &token, Action::Type { text: "x".into() });
    assert_eq!(after.unwrap_err().code, ErrorCode::NoSession);
    let capture = rig.executor.screenshot(1, &token, None, None, None);
    assert_eq!(capture.unwrap_err().code, ErrorCode::NoSession);
    assert_eq!(rig.world.lock().unwrap().inputs.len(), 4);
}

#[test]
fn stopping_mid_shortcut_releases_held_keys_in_reverse() {
    let shortcut = Action::Key {
        keys: keys(&["command", "shift", "s"]),
        repeat: 1,
    };
    let (_rig, _token, inputs) = stopped_mid_action(shortcut, 2, false);
    let up = |code| Input::Key {
        code,
        down: false,
        flags: 0,
    };
    assert_eq!(inputs.len(), 6);
    assert_eq!(inputs[3..], [up(0x01), up(0x38), up(0x37)]);
}

#[test]
fn revoking_a_permission_ends_control() {
    let rig = rig();
    let token = rig.executor.start(1, owner("A")).unwrap();
    rig.executor
        .screenshot(1, &token, None, None, None)
        .unwrap();
    rig.world.lock().unwrap().permissions.accessibility = false;
    let refused = rig
        .executor
        .act(
            1,
            &token,
            Action::Click {
                at: point("c1", 1.0, 1.0),
                button: Button::Left,
                count: 1,
            },
        )
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::PermissionRequired);
    assert_eq!(rig.ended.recv().unwrap(), EndReason::PermissionRevoked);
    let status = rig.executor.status();
    assert_eq!(status.availability, Availability::PermissionsRequired);
    assert_eq!(status.last_end_reason, Some(EndReason::PermissionRevoked));
    assert!(rig.world.lock().unwrap().inputs.is_empty());
}

#[test]
fn a_locked_screen_or_system_dialog_is_reported_not_worked_around() {
    let app = |bundle_id: &str| FrontApp {
        name: "App".into(),
        bundle_id: bundle_id.into(),
        pid: 1,
    };
    let click = Action::Click {
        at: point("c1", 5.0, 5.0),
        button: Button::Left,
        count: 1,
    };
    let typing = Action::Type {
        text: "пароль".into(),
    };
    // (probe, action, expected refusal)
    let cases = [
        (
            Probe {
                screen_locked: true,
                ..Probe::default()
            },
            click.clone(),
            Some(ErrorCode::ScreenLocked),
        ),
        (
            Probe {
                app: Some(app("com.apple.SecurityAgent")),
                ..Probe::default()
            },
            click.clone(),
            Some(ErrorCode::SystemDialog),
        ),
        (
            Probe {
                secure_input: true,
                ..Probe::default()
            },
            typing.clone(),
            Some(ErrorCode::SecureInput),
        ),
        (
            Probe {
                secure_input: true,
                ..Probe::default()
            },
            click.clone(),
            None,
        ),
        (
            Probe {
                app: Some(app("com.apple.TextEdit")),
                ..Probe::default()
            },
            typing,
            None,
        ),
    ];
    for (probe, action, refusal) in cases {
        let rig = rig();
        let token = rig.executor.start(1, owner("A")).unwrap();
        rig.executor
            .screenshot(1, &token, None, None, None)
            .unwrap();
        let expected_screen = probe.screen();
        rig.world.lock().unwrap().probe = probe;
        let result = rig.executor.act(1, &token, action);
        assert_eq!(result.err().map(|error| error.code), refusal);
        assert_eq!(
            rig.executor.context(1, &token).unwrap().screen,
            expected_screen
        );
    }
    let rig = rig();
    let token = rig.executor.start(1, owner("A")).unwrap();
    rig.world.lock().unwrap().probe.screen_locked = true;
    let capture = rig.executor.screenshot(1, &token, None, None, None);
    assert_eq!(capture.unwrap_err().code, ErrorCode::ScreenLocked);
}

#[test]
fn clicks_land_where_the_screenshot_shows_them() {
    let rig = rig();
    let token = rig.executor.start(1, owner("A")).unwrap();
    let second = rig
        .executor
        .screenshot(1, &token, Some(2), None, None)
        .unwrap();
    assert_eq!(
        (
            second.geometry.capture_id.as_str(),
            second.geometry.width,
            second.geometry.height
        ),
        ("c1", 1280, 720)
    );
    let main = rig
        .executor
        .screenshot(1, &token, None, None, None)
        .unwrap();
    assert_eq!((main.geometry.display_id, main.geometry.width), (1, 1280));
    rig.executor
        .act(
            1,
            &token,
            Action::Click {
                at: point("c1", 0.0, 0.0),
                button: Button::Right,
                count: 1,
            },
        )
        .unwrap();
    rig.executor
        .act(
            1,
            &token,
            Action::Move {
                at: point("c2", 640.0, 400.0),
            },
        )
        .unwrap();
    let inputs = rig.world.lock().unwrap().inputs.clone();
    assert_eq!(
        inputs[1],
        Input::Button {
            x: -1919.25,
            y: -199.25,
            button: Button::Right,
            down: true,
            clicks: 1
        }
    );
    assert_eq!(
        inputs[3],
        Input::Move {
            x: 720.5625,
            y: 450.5625,
            dragging: None
        }
    );

    let unknown = rig.executor.act(
        1,
        &token,
        Action::Move {
            at: point("c9", 1.0, 1.0),
        },
    );
    assert_eq!(unknown.unwrap_err().code, ErrorCode::StaleCapture);
    rig.world.lock().unwrap().displays[1].bounds.x = 1440.0;
    let moved = rig.executor.act(
        1,
        &token,
        Action::Move {
            at: point("c1", 1.0, 1.0),
        },
    );
    assert_eq!(moved.unwrap_err().code, ErrorCode::StaleCapture);
    assert_eq!(rig.world.lock().unwrap().inputs.len(), 4);
}

#[test]
fn turning_on_needs_local_consent_and_turning_off_stops_control() {
    let rig = rig_with(false, lock::tempdir().join("owner.lock"));
    rig.log.lock().unwrap().decline = true;
    assert_eq!(
        rig.executor.set_enabled(true).unwrap_err().code,
        ErrorCode::Declined
    );
    assert_eq!(rig.executor.status().availability, Availability::Disabled);
    rig.log.lock().unwrap().decline = false;
    rig.executor.set_enabled(true).unwrap();
    let token = rig.executor.start(1, owner("A")).unwrap();
    rig.executor.set_enabled(false).unwrap();
    assert_eq!(rig.ended.recv().unwrap(), EndReason::Disabled);
    assert_eq!(rig.log.lock().unwrap().saved, [true, false]);
    let after = rig
        .executor
        .act(1, &token, Action::Type { text: "x".into() });
    assert_eq!(after.unwrap_err().code, ErrorCode::NoSession);
    assert_eq!(
        rig.executor.start(1, owner("A")).unwrap_err().code,
        ErrorCode::Disabled
    );
}

fn request(token: &str, body: Value) -> String {
    let mut body = body;
    body["id"] = json!(7);
    body["token"] = json!(token);
    body.to_string()
}

#[test]
fn only_the_server_the_shell_started_reaches_the_executor() {
    let rig = rig();
    let channel = Channel::new(Arc::clone(&rig.executor), "launch-secret".into());
    let start = json!({ "op": "start", "owner": owner("A") });
    for token in ["", "launch-secreT", "launch-secret-but-longer"] {
        let reply = channel.handle(1, &request(token, start.clone()));
        assert_eq!(reply["error"]["code"], "unauthorized");
        assert_eq!(reply["id"], 7);
    }
    assert_eq!(
        channel.handle(1, "not json")["error"]["code"],
        "invalid-request"
    );
    assert!(rig.log.lock().unwrap().started.is_empty());
    assert_eq!(rig.world.lock().unwrap().calls, 0);

    let started = channel.handle(1, &request("launch-secret", start));
    let session = started["result"]["sessionToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let typing =
        json!({ "op": "act", "sessionToken": session, "action": { "type": "type", "text": "hi" } });
    // Another connection, even with the channel token, cannot use this session.
    assert_eq!(
        channel.handle(2, &request("launch-secret", typing.clone()))["error"]["code"],
        "no-session"
    );
    let forged =
        json!({ "op": "act", "sessionToken": "guess", "action": { "type": "type", "text": "hi" } });
    assert_eq!(
        channel.handle(1, &request("launch-secret", forged))["error"]["code"],
        "no-session"
    );
    assert!(rig.world.lock().unwrap().inputs.is_empty());
    assert_eq!(
        channel.handle(1, &request("launch-secret", typing))["ok"],
        true
    );
    assert_eq!(rig.world.lock().unwrap().inputs, [Input::Text("hi".into())]);
}

#[test]
fn closing_the_owning_connection_ends_control() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let rig = rig();
    let channel = Channel::new(Arc::clone(&rig.executor), "launch-secret".into());
    let path = lock::tempdir().join("cu.sock");
    channel::listen(&path, channel).unwrap();
    let mut stream = UnixStream::connect(&path).unwrap();
    let start = request(
        "launch-secret",
        json!({ "op": "start", "owner": owner("A") }),
    );
    writeln!(stream, "{start}").unwrap();
    let mut reply = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut reply)
        .unwrap();
    assert!(reply.contains("sessionToken"));
    assert_eq!(rig.executor.status().availability, Availability::Active);
    drop(stream);
    assert_eq!(rig.ended.recv().unwrap(), EndReason::ConnectionLost);
    assert_eq!(rig.executor.status().owner, None);
}

/// The server decodes these with packages/contracts/src/computerUse.ts; the same file is its test.
#[test]
fn the_wire_matches_the_shared_contract_samples() {
    let samples: Value = serde_json::from_str(include_str!(
        "../../../../../packages/contracts/src/computerUse.wire.json"
    ))
    .unwrap();
    let rig = rig();
    let channel = Channel::new(Arc::clone(&rig.executor), "launch-secret".into());
    let started = channel.handle(
        1,
        &request(
            "launch-secret",
            json!({ "op": "start", "owner": owner("A") }),
        ),
    );
    let session = started["result"]["sessionToken"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_eq!(
        json!({ "event": "status", "status": rig.executor.status() }),
        samples["status"]
    );
    let screenshot = json!({ "op": "screenshot", "sessionToken": session, "displayId": 2 });
    assert_eq!(
        channel.handle(1, &request("launch-secret", screenshot)),
        samples["screenshot"]
    );
    assert_eq!(
        channel.handle(1, &request("wrong", json!({ "op": "status" }))),
        samples["failure"]
    );
    let line = samples["request"].to_string().replace("SESSION", &session);
    assert_eq!(channel.handle(1, &line)["ok"], true);
    assert_eq!(rig.world.lock().unwrap().inputs.len(), 4);
}
