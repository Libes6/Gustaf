//! Agents seeing and driving the whole Mac. Design and threat model: docs/internals/computer-use.md.
//!
//! The shell owns the session: one owner per Mac (lock.rs), a visible indicator and an emergency
//! shortcut (app.rs), and the server it started as the only caller (channel.rs). Everything
//! here is OS-independent; the OS calls sit behind `Backend` so tests use a fake.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(target_os = "macos")]
mod app;
#[cfg(all(unix, any(target_os = "macos", test)))]
mod channel;
mod lock;
#[cfg(target_os = "macos")]
mod macos;
mod plan;
#[cfg(all(test, unix))]
mod tests;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

pub(crate) use plan::Input;

#[cfg(target_os = "macos")]
pub(crate) use app::{initialize, shutdown};

#[cfg(not(target_os = "macos"))]
pub(crate) fn initialize(
    _app: &tauri::AppHandle,
    _settings: &crate::shell_settings::ShellSettings,
) -> Vec<(String, String)> {
    Vec::new()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn shutdown(_app: &tauri::AppHandle) {}

/// The shortcut the indicator names; app.rs registers it as `EMERGENCY_ACCELERATOR`.
pub(crate) const EMERGENCY_SHORTCUT: &str = "⌃⌥⌘⎋";
const KEPT_CAPTURES: usize = 8;
const MAX_LABEL_CHARS: usize = 80;
const MAX_ID_CHARS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Display {
    pub id: u32,
    pub name: String,
    pub main: bool,
    /// Global display points: origin at the main display's top left, y down.
    pub bounds: Rect,
    /// Pixels per point: 2 on Retina.
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Permissions {
    pub screen_recording: bool,
    pub accessibility: bool,
}

impl Permissions {
    fn granted(self) -> bool {
        self.screen_recording && self.accessibility
    }
    fn missing(self) -> String {
        match (self.screen_recording, self.accessibility) {
            (false, false) => "Screen Recording and Accessibility",
            (false, true) => "Screen Recording",
            _ => "Accessibility",
        }
        .to_owned()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Permission {
    ScreenRecording,
    Accessibility,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Owner {
    pub environment_id: String,
    pub thread_id: String,
    /// Shown in the indicator, such as the thread's title.
    pub label: String,
}

impl Owner {
    fn validated(self) -> Result<Self, Error> {
        let id = |value: &str| {
            !value.trim().is_empty()
                && value.chars().count() <= MAX_ID_CHARS
                && !value.chars().any(char::is_control)
        };
        if !id(&self.environment_id) || !id(&self.thread_id) {
            return Err(Error::new(ErrorCode::InvalidRequest, "Invalid owner ids."));
        }
        let label: String = self
            .label
            .chars()
            .filter(|character| !character.is_control())
            .take(MAX_LABEL_CHARS)
            .collect();
        let label = label.trim();
        Ok(Self {
            label: if label.is_empty() {
                "Gustaf agent".to_owned()
            } else {
                label.to_owned()
            },
            ..self
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Availability {
    Unsupported,
    Disabled,
    PermissionsRequired,
    Ready,
    Active,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EndReason {
    StoppedByUser,
    EmergencyShortcut,
    StoppedByOwner,
    ConnectionLost,
    PermissionRevoked,
    Disabled,
    AppQuit,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub availability: Availability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Permissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<Owner>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_end_reason: Option<EndReason>,
    pub emergency_shortcut: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ScreenState {
    Available,
    Locked,
    SecureInput,
    SystemDialog,
}

/// What the OS reports about the front of the screen.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Probe {
    pub app: Option<FrontApp>,
    pub window_title: Option<String>,
    pub screen_locked: bool,
    pub secure_input: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontApp {
    pub name: String,
    pub bundle_id: String,
    pub pid: i32,
}

/// Apps whose windows macOS does not let synthetic events reach.
const SYSTEM_DIALOG_APPS: [&str; 3] = [
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.UserNotificationCenter",
];

impl Probe {
    fn screen(&self) -> ScreenState {
        let front = self.app.as_ref().map(|app| app.bundle_id.as_str());
        if self.screen_locked {
            ScreenState::Locked
        } else if front.is_some_and(|id| SYSTEM_DIALOG_APPS.contains(&id)) {
            ScreenState::SystemDialog
        } else if self.secure_input {
            ScreenState::SecureInput
        } else {
            ScreenState::Available
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppContext {
    pub screen: ScreenState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<FrontApp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
}

/// What a screenshot's pixels are tied to. Actions name it by `capture_id`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureGeometry {
    pub capture_id: String,
    pub display_id: u32,
    pub bounds: Rect,
    pub scale: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Screenshot {
    #[serde(flatten)]
    pub geometry: CaptureGeometry,
    pub mime_type: &'static str,
    /// Base64 PNG. Goes to the server only; never logged.
    pub data: String,
}

pub(crate) struct RawImage {
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

/// A pixel of a screenshot this session took.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagePoint {
    pub capture_id: String,
    pub x: f64,
    pub y: f64,
}

fn one() -> u8 {
    1
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Action {
    Move {
        at: ImagePoint,
    },
    Click {
        at: ImagePoint,
        #[serde(default)]
        button: Button,
        #[serde(default = "one")]
        count: u8,
    },
    Drag {
        from: ImagePoint,
        to: ImagePoint,
        #[serde(default)]
        button: Button,
    },
    Scroll {
        at: ImagePoint,
        #[serde(default)]
        delta_x: i32,
        #[serde(default)]
        delta_y: i32,
    },
    Type {
        text: String,
    },
    Key {
        keys: Vec<String>,
        #[serde(default = "one")]
        repeat: u8,
    },
    /// A bundle id such as com.apple.TextEdit, or an app name such as TextEdit.
    Activate {
        app: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ErrorCode {
    Unauthorized,
    InvalidRequest,
    Unsupported,
    Disabled,
    Declined,
    PermissionRequired,
    Busy,
    NoSession,
    Cancelled,
    ScreenLocked,
    SecureInput,
    SystemDialog,
    StaleCapture,
    OutOfBounds,
    InvalidAction,
    EmergencyStopUnavailable,
    Failed,
}

/// Messages are read by the agent and shown in the server's UI, so they are English and
/// never carry captured pixels or typed text.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn backend(error: String) -> Self {
        match error.as_str() {
            "screen-recording-denied" | "accessibility-denied" => Self::new(
                ErrorCode::PermissionRequired,
                "macOS refused the request: a permission was revoked.",
            ),
            "app-not-found" => Self::new(ErrorCode::InvalidAction, "No such app on this Mac."),
            _ => Self::new(
                ErrorCode::Failed,
                format!("The Mac did not respond: {error}."),
            ),
        }
    }
}

/// The OS calls, one per method. Errors are short codes, never user content.
pub(crate) trait Backend: Send {
    fn permissions(&mut self) -> Result<Permissions, String>;
    fn open_settings(&mut self, permission: Permission) -> Result<(), String>;
    fn displays(&mut self) -> Result<Vec<Display>, String>;
    fn probe(&mut self) -> Result<Probe, String>;
    fn capture(&mut self, display: u32, width: u32, height: u32) -> Result<RawImage, String>;
    fn input(&mut self, input: &Input) -> Result<(), String>;
    fn activate(&mut self, app: &str) -> Result<(), String>;
}

/// What the shell around the executor does: dialogs, settings, indicator, shortcut.
pub(crate) trait Host: Send + Sync {
    /// Native and local: a page or a remote client cannot answer it.
    fn confirm_enable(&self) -> bool;
    fn save_enabled(&self, enabled: bool) -> Result<(), String>;
    /// Shows the indicator and registers the emergency shortcut; an error refuses the session.
    fn session_started(&self, owner: &Owner) -> Result<(), String>;
    fn session_ended(&self, reason: EndReason);
}

#[derive(Debug)]
enum Held {
    Button(Button),
    Key(u16),
}

struct Session {
    token: String,
    owner: Owner,
    connection: u64,
    captures: VecDeque<CaptureGeometry>,
    /// Pressed and not yet released, in press order.
    held: Vec<Held>,
    pointer: (f64, f64),
    _lock: lock::OwnerLock,
}

struct State {
    enabled: bool,
    session: Option<Session>,
    /// Bumped when a session ends, so a step planned before cannot run after.
    epoch: u64,
    next_capture: u64,
    last_end: Option<EndReason>,
}

/// What `detach` took from an ended session, for `release` to undo.
pub(crate) struct Ended {
    reason: EndReason,
    held: Vec<Held>,
    pointer: (f64, f64),
    lock: lock::OwnerLock,
}

pub(crate) struct Executor {
    supported: bool,
    lock_path: PathBuf,
    app_name: String,
    state: Mutex<State>,
    backend: Mutex<Box<dyn Backend>>,
    host: Box<dyn Host>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic mid-step must not make Stop unusable.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Compares secrets without returning early on the first difference.
pub(crate) fn same_secret(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

impl Executor {
    pub(crate) fn new(
        supported: bool,
        enabled: bool,
        lock_path: PathBuf,
        app_name: String,
        backend: Box<dyn Backend>,
        host: Box<dyn Host>,
    ) -> Self {
        Self {
            supported,
            lock_path,
            app_name,
            state: Mutex::new(State {
                enabled,
                session: None,
                epoch: 0,
                next_capture: 0,
                last_end: None,
            }),
            backend: Mutex::new(backend),
            host,
        }
    }

    pub(crate) fn status(&self) -> Status {
        let (enabled, owner, last_end_reason) = {
            let state = guard(&self.state);
            (
                state.enabled,
                state.session.as_ref().map(|session| session.owner.clone()),
                state.last_end,
            )
        };
        let permissions = (self.supported && enabled)
            .then(|| guard(&self.backend).permissions().ok())
            .flatten();
        let availability = if !self.supported {
            Availability::Unsupported
        } else if !enabled {
            Availability::Disabled
        } else if !permissions.is_some_and(Permissions::granted) {
            Availability::PermissionsRequired
        } else if owner.is_some() {
            Availability::Active
        } else {
            Availability::Ready
        };
        Status {
            availability,
            permissions,
            owner,
            last_end_reason,
            emergency_shortcut: EMERGENCY_SHORTCUT,
        }
    }

    fn require_supported(&self) -> Result<(), Error> {
        if self.supported {
            Ok(())
        } else {
            Err(Error::new(
                ErrorCode::Unsupported,
                "Computer use is only available on macOS.",
            ))
        }
    }

    pub(crate) fn set_enabled(&self, enabled: bool) -> Result<(), Error> {
        self.require_supported()?;
        let was = guard(&self.state).enabled;
        if enabled && !was && !self.host.confirm_enable() {
            return Err(Error::new(
                ErrorCode::Declined,
                "The user did not allow computer use on this Mac.",
            ));
        }
        self.host
            .save_enabled(enabled)
            .map_err(|error| Error::new(ErrorCode::Failed, error))?;
        guard(&self.state).enabled = enabled;
        if !enabled {
            self.end(EndReason::Disabled);
        }
        Ok(())
    }

    pub(crate) fn open_settings(&self, permission: Permission) -> Result<(), Error> {
        self.require_supported()?;
        guard(&self.backend)
            .open_settings(permission)
            .map_err(Error::backend)
    }

    /// Returns the session token every later call must carry.
    pub(crate) fn start(&self, connection: u64, owner: Owner) -> Result<String, Error> {
        self.require_supported()?;
        let owner = owner.validated()?;
        if !guard(&self.state).enabled {
            return Err(Error::new(
                ErrorCode::Disabled,
                "Computer use is turned off on this Mac. The user can turn it on from the thread's Control Mac button.",
            ));
        }
        let permissions = guard(&self.backend).permissions().map_err(Error::backend)?;
        if !permissions.granted() {
            return Err(Error::new(
                ErrorCode::PermissionRequired,
                format!(
                    "Gustaf needs {} permission in System Settings > Privacy & Security.",
                    permissions.missing()
                ),
            ));
        }
        let mut state = guard(&self.state);
        if let Some(session) = &state.session {
            if session.owner == owner && session.connection == connection {
                return Ok(session.token.clone());
            }
            return Err(busy(&session.owner.label, None));
        }
        let holder = lock::Holder {
            pid: std::process::id(),
            app: self.app_name.clone(),
            owner: owner.label.clone(),
        };
        let lock = lock::acquire(&self.lock_path, &holder).map_err(|refused| match refused {
            lock::Refused::Busy(holder) => match holder {
                Some(holder) => busy(&holder.owner, Some(&holder.app)),
                None => busy("another Gustaf", None),
            },
            lock::Refused::Failed(error) => Error::new(ErrorCode::Failed, error),
        })?;
        // Held under the state lock so a concurrent start cannot slip between check and claim.
        if let Err(error) = self.host.session_started(&owner) {
            return Err(Error::new(
                ErrorCode::EmergencyStopUnavailable,
                format!("The emergency stop shortcut could not be set up, so control was not started: {error}"),
            ));
        }
        let token = crate::account::random_token();
        state.session = Some(Session {
            token: token.clone(),
            owner,
            connection,
            captures: VecDeque::new(),
            held: Vec::new(),
            pointer: (0.0, 0.0),
            _lock: lock,
        });
        state.last_end = None;
        Ok(token)
    }

    /// Ends the session and leaves nothing pressed. Safe to call from any thread at any time.
    pub(crate) fn end(&self, reason: EndReason) -> bool {
        match self.detach(reason) {
            Some(ended) => {
                self.release(ended);
                true
            }
            None => false,
        }
    }

    /// Stops the session at once: no step that has not started will run.
    pub(crate) fn detach(&self, reason: EndReason) -> Option<Ended> {
        let mut state = guard(&self.state);
        let session = state.session.take()?;
        state.epoch += 1;
        state.last_end = Some(reason);
        Some(Ended {
            reason,
            held: session.held,
            pointer: session.pointer,
            lock: session._lock,
        })
    }

    /// Waits for a step in flight, releases what it left pressed, then frees the Mac.
    pub(crate) fn release(&self, ended: Ended) {
        {
            let mut backend = guard(&self.backend);
            let (x, y) = ended.pointer;
            for held in ended.held.iter().rev() {
                let input = match held {
                    Held::Button(button) => Input::Button {
                        x,
                        y,
                        button: *button,
                        down: false,
                        clicks: 1,
                    },
                    Held::Key(code) => Input::Key {
                        code: *code,
                        down: false,
                        flags: 0,
                    },
                };
                let _ = backend.input(&input);
            }
        }
        drop(ended.lock);
        self.host.session_ended(ended.reason);
    }

    /// The owner's own stop, which needs its token; any caller may stop without one.
    pub(crate) fn stop(&self, connection: u64, token: Option<&str>) -> Result<(), Error> {
        let reason = match token {
            Some(token) => {
                self.session(connection, token)?;
                EndReason::StoppedByOwner
            }
            None => EndReason::StoppedByUser,
        };
        self.end(reason);
        Ok(())
    }

    pub(crate) fn connection_closed(&self, connection: u64) {
        let owns = guard(&self.state)
            .session
            .as_ref()
            .is_some_and(|session| session.connection == connection);
        if owns {
            self.end(EndReason::ConnectionLost);
        }
    }

    /// The epoch of the session `token` names, if the connection that started it asks.
    fn session(&self, connection: u64, token: &str) -> Result<u64, Error> {
        let state = guard(&self.state);
        match &state.session {
            Some(session)
                if same_secret(&session.token, token) && session.connection == connection =>
            {
                Ok(state.epoch)
            }
            _ => Err(Error::new(
                ErrorCode::NoSession,
                "This computer-use session has ended. Start a new one when the user allows it.",
            )),
        }
    }

    /// Checks before acting: permissions still granted (else the session ends) and the screen usable.
    fn preflight(&self, keyboard: bool) -> Result<Probe, Error> {
        let checked = {
            let mut backend = guard(&self.backend);
            let permissions = backend.permissions().map_err(Error::backend)?;
            if permissions.granted() {
                Ok(backend.probe().map_err(Error::backend)?)
            } else {
                Err(permissions)
            }
        };
        let probe = match checked {
            Ok(probe) => probe,
            Err(permissions) => {
                self.end(EndReason::PermissionRevoked);
                return Err(Error::new(
                    ErrorCode::PermissionRequired,
                    format!(
                        "{} permission was turned off, so control stopped.",
                        permissions.missing()
                    ),
                ));
            }
        };
        match probe.screen() {
            ScreenState::Locked => Err(Error::new(
                ErrorCode::ScreenLocked,
                "The Mac's screen is locked. Ask the user to unlock it.",
            )),
            ScreenState::SystemDialog => Err(Error::new(
                ErrorCode::SystemDialog,
                "A system dialog is in front, and macOS does not let it be controlled. Ask the user to answer it.",
            )),
            ScreenState::SecureInput if keyboard => Err(Error::new(
                ErrorCode::SecureInput,
                "A secure field, such as a password prompt, has the keyboard; typing is blocked.",
            )),
            _ => Ok(probe),
        }
    }

    pub(crate) fn screenshot(
        &self,
        connection: u64,
        token: &str,
        display: Option<u32>,
        max_width: Option<u32>,
        max_height: Option<u32>,
    ) -> Result<Screenshot, Error> {
        let epoch = self.session(connection, token)?;
        self.preflight(false)?;
        let mut backend = guard(&self.backend);
        let displays = backend.displays().map_err(Error::backend)?;
        let target = match display {
            Some(id) => displays.iter().find(|candidate| candidate.id == id),
            None => displays
                .iter()
                .find(|candidate| candidate.main)
                .or(displays.first()),
        }
        .cloned()
        .ok_or_else(|| {
            Error::new(
                ErrorCode::InvalidAction,
                "No such display. List the displays first.",
            )
        })?;
        let (width, height) = plan::capture_size(&target, max_width, max_height);
        let image = backend
            .capture(target.id, width, height)
            .map_err(Error::backend)?;
        drop(backend);
        let mut state = guard(&self.state);
        if state.epoch != epoch {
            return Err(cancelled());
        }
        state.next_capture += 1;
        let geometry = CaptureGeometry {
            capture_id: format!("c{}", state.next_capture),
            display_id: target.id,
            bounds: target.bounds,
            scale: target.scale,
            width: image.width,
            height: image.height,
        };
        let session = state.session.as_mut().ok_or_else(cancelled)?;
        if session.captures.len() == KEPT_CAPTURES {
            session.captures.pop_front();
        }
        session.captures.push_back(geometry.clone());
        Ok(Screenshot {
            geometry,
            mime_type: "image/png",
            data: image.data,
        })
    }

    pub(crate) fn act(&self, connection: u64, token: &str, action: Action) -> Result<(), Error> {
        let epoch = self.session(connection, token)?;
        self.preflight(matches!(action, Action::Type { .. } | Action::Key { .. }))?;
        if let Action::Activate { app } = &action {
            let app = app.trim();
            if app.is_empty()
                || app.chars().count() > 200
                || app.contains('/')
                || app.chars().any(char::is_control)
            {
                return Err(Error::new(
                    ErrorCode::InvalidAction,
                    "Name the app, such as TextEdit, or its bundle id, such as com.apple.TextEdit.",
                ));
            }
            let mut backend = guard(&self.backend);
            self.check_epoch(epoch)?;
            return backend.activate(app).map_err(Error::backend);
        }
        let captures = {
            let state = guard(&self.state);
            let session = state.session.as_ref().ok_or_else(cancelled)?;
            plan::points(&action)
                .into_iter()
                .map(|point| {
                    session
                        .captures
                        .iter()
                        .find(|capture| capture.capture_id == point.capture_id)
                        .cloned()
                        .ok_or_else(stale)
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        if !captures.is_empty() {
            let displays = guard(&self.backend).displays().map_err(Error::backend)?;
            if !captures
                .iter()
                .all(|capture| plan::capture_is_current(capture, &displays))
            {
                return Err(stale());
            }
        }
        let inputs = plan::plan(&action, |point| {
            let capture = captures
                .iter()
                .find(|capture| capture.capture_id == point.capture_id)
                .ok_or_else(stale)?;
            plan::to_global(capture, point.x, point.y)
        })?;
        for input in &inputs {
            self.step(epoch, input)?;
        }
        Ok(())
    }

    fn check_epoch(&self, epoch: u64) -> Result<(), Error> {
        let state = guard(&self.state);
        if state.epoch == epoch && state.session.is_some() {
            Ok(())
        } else {
            Err(cancelled())
        }
    }

    /// One event, posted only if the session it was planned in is still running. The backend
    /// lock is held across check and post, and `release` takes it, so nothing posts after a stop.
    fn step(&self, epoch: u64, input: &Input) -> Result<(), Error> {
        let mut backend = guard(&self.backend);
        {
            let mut state = guard(&self.state);
            if state.epoch != epoch {
                return Err(cancelled());
            }
            let session = state.session.as_mut().ok_or_else(cancelled)?;
            match input {
                Input::Button {
                    button, down: true, ..
                } => session.held.push(Held::Button(*button)),
                Input::Key {
                    code, down: true, ..
                } => session.held.push(Held::Key(*code)),
                _ => {}
            }
            if let Input::Move { x, y, .. } | Input::Button { x, y, .. } = input {
                session.pointer = (*x, *y);
            }
        }
        backend.input(input).map_err(Error::backend)?;
        let released = |held: &Held| match (held, input) {
            (
                Held::Button(held),
                Input::Button {
                    button,
                    down: false,
                    ..
                },
            ) => held == button,
            (
                Held::Key(held),
                Input::Key {
                    code, down: false, ..
                },
            ) => held == code,
            _ => false,
        };
        let mut state = guard(&self.state);
        if state.epoch == epoch {
            if let Some(session) = state.session.as_mut() {
                if let Some(index) = session.held.iter().rposition(released) {
                    session.held.remove(index);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn displays(&self, connection: u64, token: &str) -> Result<Vec<Display>, Error> {
        self.session(connection, token)?;
        guard(&self.backend).displays().map_err(Error::backend)
    }

    pub(crate) fn context(&self, connection: u64, token: &str) -> Result<AppContext, Error> {
        self.session(connection, token)?;
        let probe = guard(&self.backend).probe().map_err(Error::backend)?;
        Ok(AppContext {
            screen: probe.screen(),
            app: probe.app,
            window_title: probe.window_title,
        })
    }
}

fn cancelled() -> Error {
    Error::new(
        ErrorCode::Cancelled,
        "Control was stopped; the rest of this action was not performed.",
    )
}

fn stale() -> Error {
    Error::new(
        ErrorCode::StaleCapture,
        "That screenshot no longer matches the screen. Take a new one.",
    )
}

fn busy(owner: &str, app: Option<&str>) -> Error {
    let place = app.map(|app| format!(" in {app}")).unwrap_or_default();
    Error::new(
        ErrorCode::Busy,
        format!("This Mac is already controlled by \"{owner}\"{place}. It must stop first."),
    )
}
