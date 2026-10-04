//! Pairing codes, device tokens and the failure limiter. Everything here is pure (time is passed in), so the security
//! rules are unit-tested without a socket.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

/// 32 symbols (no `I`, `O`, `0`, `1`), so one random byte masked with 31 picks a symbol without bias.
/// Every symbol is accepted by the phone's pairing parser (`[A-Za-z0-9_-]{4,64}`).
pub const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// 8 symbols = 40 bits of entropy.
pub const CODE_LEN: usize = 8;
/// A pairing code stops working after this long ...
pub const CODE_TTL: Duration = Duration::from_secs(120);
/// ... or after this many wrong submissions in total (from any address), whichever comes first. With 40 bits of entropy
/// this caps an attacker at 5 guesses per code, however many addresses they use.
pub const CODE_MAX_FAILURES: u32 = 5;

/// Failed pairing attempts allowed per address in `PAIR_WINDOW`; reaching the limit locks the address out for `PAIR_LOCKOUT`.
pub const PAIR_MAX_FAILURES: usize = 5;
pub const PAIR_WINDOW: Duration = Duration::from_secs(60);
pub const PAIR_LOCKOUT: Duration = Duration::from_secs(300);

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the operating system random number generator is unavailable");
    buf
}

pub fn new_code() -> String {
    let bytes = random_bytes::<CODE_LEN>();
    bytes.iter().map(|b| CODE_ALPHABET[(b & 31) as usize] as char).collect()
}

/// What the user types or the QR carries is compared in this form: separators and spaces dropped, upper case.
pub fn normalize_code(input: &str) -> String {
    input.chars().filter(|c| !matches!(c, '-' | ' ' | '_')).map(|c| c.to_ascii_uppercase()).collect()
}

/// Device token: 32 random bytes, base64url without padding (43 characters). Shown to the phone once.
pub fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Only this hash is stored. The token is 256 random bits, so an unsalted fast hash is enough (nothing to brute force).
pub fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

/// A syntactically plausible token (cheap check before hashing; the real check is the hash lookup).
pub fn token_shape_ok(token: &str) -> bool {
    (16..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Finds the device whose stored hash equals `presented`. Compares against EVERY row without stopping at a match, so the
/// time taken does not depend on which row (or whether any row) matched.
pub fn find_device<'a>(devices: &'a [(String, String)], presented: &str) -> Option<&'a str> {
    let mut found: Option<&str> = None;
    for (id, hash) in devices {
        let same = hash.len() == presented.len() && bool::from(hash.as_bytes().ct_eq(presented.as_bytes()));
        if same {
            found = Some(id);
        }
    }
    found
}

// ---- Failure limiter --------------------------------------------------------------------------------------------------

struct Entry {
    failures: VecDeque<Instant>,
    locked_until: Option<Instant>,
}

/// Per-address failure limiter: `max` failures within `window` lock the address out for `lockout`. A locked address is
/// refused even with correct credentials, so the lockout cannot be walked around.
pub struct RateLimiter {
    max: usize,
    window: Duration,
    lockout: Duration,
    entries: HashMap<IpAddr, Entry>,
}

const MAX_TRACKED: usize = 4096;

impl RateLimiter {
    pub fn new(max: usize, window: Duration, lockout: Duration) -> Self {
        Self { max, window, lockout, entries: HashMap::new() }
    }

    pub fn pairing() -> Self {
        Self::new(PAIR_MAX_FAILURES, PAIR_WINDOW, PAIR_LOCKOUT)
    }

    /// `Err(wait)` while the address is locked out.
    pub fn check(&mut self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        if let Some(e) = self.entries.get_mut(&ip) {
            if let Some(until) = e.locked_until {
                if now < until {
                    return Err(until - now);
                }
                e.locked_until = None;
                e.failures.clear();
            }
        }
        Ok(())
    }

    pub fn record_failure(&mut self, ip: IpAddr, now: Instant) {
        if self.entries.len() >= MAX_TRACKED && !self.entries.contains_key(&ip) {
            self.prune(now);
            if self.entries.len() >= MAX_TRACKED {
                // Still full of live entries: forget everything that is not a lockout rather than grow without bound.
                self.entries.retain(|_, e| e.locked_until.is_some_and(|u| now < u));
            }
            if self.entries.len() >= MAX_TRACKED {
                return;
            }
        }
        let e = self.entries.entry(ip).or_insert_with(|| Entry { failures: VecDeque::new(), locked_until: None });
        while e.failures.front().is_some_and(|t| now.duration_since(*t) > self.window) {
            e.failures.pop_front();
        }
        e.failures.push_back(now);
        if e.failures.len() >= self.max {
            e.locked_until = Some(now + self.lockout);
        }
    }

    pub fn reset(&mut self, ip: IpAddr) {
        self.entries.remove(&ip);
    }

    fn prune(&mut self, now: Instant) {
        let window = self.window;
        self.entries.retain(|_, e| e.locked_until.is_some_and(|u| now < u) || e.failures.back().is_some_and(|t| now.duration_since(*t) <= window));
    }
}

// ---- Pairing state ----------------------------------------------------------------------------------------------------

struct ActiveCode {
    code: String,
    expires: Instant,
    failures: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// The address is locked out; the value is how long it has to wait.
    Locked(Duration),
    /// Wrong, expired, already used or never issued: deliberately indistinguishable.
    Invalid,
}

pub struct PairingState {
    current: Option<ActiveCode>,
    limiter: RateLimiter,
}

impl Default for PairingState {
    fn default() -> Self {
        Self { current: None, limiter: RateLimiter::pairing() }
    }
}

impl PairingState {
    /// Issues a fresh code and invalidates the previous one.
    pub fn issue(&mut self, now: Instant) -> (String, Instant) {
        let code = new_code();
        let expires = now + CODE_TTL;
        self.current = Some(ActiveCode { code: code.clone(), expires, failures: 0 });
        (code, expires)
    }

    pub fn clear(&mut self) {
        self.current = None;
    }

    /// The code that is currently usable (for the desktop UI), if any.
    pub fn active(&self, now: Instant) -> Option<(&str, Instant)> {
        self.current.as_ref().filter(|c| now < c.expires).map(|c| (c.code.as_str(), c.expires))
    }

    /// Checks a submitted code. A correct code is consumed (single use). A wrong one counts against the address and
    /// against the code itself, which is burned after `CODE_MAX_FAILURES` wrong submissions.
    pub fn attempt(&mut self, ip: IpAddr, submitted: &str, now: Instant) -> Result<(), PairError> {
        self.limiter.check(ip, now).map_err(PairError::Locked)?;
        let submitted = normalize_code(submitted);
        let ok = match &self.current {
            Some(c) if now < c.expires => bool::from(c.code.as_bytes().ct_eq(submitted.as_bytes())),
            _ => false,
        };
        if ok {
            self.current = None;
            self.limiter.reset(ip);
            return Ok(());
        }
        // An expired code is gone for good.
        if self.current.as_ref().is_some_and(|c| now >= c.expires) {
            self.current = None;
        }
        if let Some(c) = self.current.as_mut() {
            c.failures += 1;
            if c.failures >= CODE_MAX_FAILURES {
                self.current = None;
            }
        }
        self.limiter.record_failure(ip, now);
        Err(PairError::Invalid)
    }

    /// A request that was rejected before the code was looked at (malformed body) still counts as a failure.
    pub fn record_bad_request(&mut self, ip: IpAddr, now: Instant) {
        self.limiter.record_failure(ip, now);
    }

    pub fn check_locked(&mut self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        self.limiter.check(ip, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([192, 168, 1, n])
    }

    #[test]
    fn codes_use_the_alphabet_and_the_phone_parser_accepts_them() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), CODE_LEN);
            assert!(c.bytes().all(|b| CODE_ALPHABET.contains(&b)));
            // apps/mobile/src/lib/pairing.ts: /^[A-Za-z0-9_-]{4,64}$/
            assert!(c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        }
        assert_ne!(new_code(), new_code());
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            seen.extend(new_code().bytes());
        }
        assert!(seen.len() > 20, "the alphabet is actually used: {}", seen.len());
        assert_eq!(CODE_ALPHABET.iter().collect::<std::collections::HashSet<_>>().len(), 32);
    }

    #[test]
    fn code_input_is_forgiving_about_case_and_separators() {
        assert_eq!(normalize_code("k7q2-x9pm"), "K7Q2X9PM");
        assert_eq!(normalize_code(" K7Q2 X9PM "), "K7Q2X9PM");
    }

    #[test]
    fn tokens_are_random_url_safe_and_hash_to_64_hex() {
        let t = new_token();
        assert_eq!(t.len(), 43);
        assert!(token_shape_ok(&t));
        assert_ne!(t, new_token());
        let h = hash_token(&t);
        assert_eq!(h.len(), 64);
        assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(hash_token("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(!token_shape_ok("short"));
        assert!(!token_shape_ok(&"a".repeat(129)));
        assert!(!token_shape_ok("has space in it is long enough"));
    }

    #[test]
    fn device_lookup_matches_only_the_exact_hash() {
        let devices = vec![("a".to_string(), hash_token("token-a-token-a-token")), ("b".to_string(), hash_token("token-b-token-b-token"))];
        assert_eq!(find_device(&devices, &hash_token("token-b-token-b-token")), Some("b"));
        assert_eq!(find_device(&devices, &hash_token("token-c-token-c-token")), None);
        assert_eq!(find_device(&devices, ""), None);
        assert_eq!(find_device(&[], "x"), None);
    }

    #[test]
    fn a_code_works_once() {
        let mut p = PairingState::default();
        let t0 = Instant::now();
        let (code, _) = p.issue(t0);
        assert_eq!(p.attempt(ip(1), &code, t0), Ok(()));
        assert_eq!(p.attempt(ip(1), &code, t0), Err(PairError::Invalid), "single use");
        assert!(p.active(t0).is_none());
    }

    #[test]
    fn a_code_expires_after_two_minutes() {
        let mut p = PairingState::default();
        let t0 = Instant::now();
        let (code, expires) = p.issue(t0);
        assert_eq!(expires - t0, Duration::from_secs(120));
        assert!(p.active(t0 + Duration::from_secs(119)).is_some());
        assert_eq!(p.attempt(ip(1), &code, t0 + Duration::from_secs(120)), Err(PairError::Invalid));
        assert!(p.active(t0).is_none(), "an expired code is dropped");
    }

    #[test]
    fn issuing_a_new_code_invalidates_the_old_one() {
        let mut p = PairingState::default();
        let t0 = Instant::now();
        let (old, _) = p.issue(t0);
        let (new, _) = p.issue(t0);
        assert_ne!(old, new);
        assert_eq!(p.attempt(ip(1), &old, t0), Err(PairError::Invalid));
        assert_eq!(p.attempt(ip(1), &new, t0), Ok(()));
    }

    #[test]
    fn without_a_code_nothing_pairs() {
        let mut p = PairingState::default();
        assert_eq!(p.attempt(ip(1), "AAAAAAAA", Instant::now()), Err(PairError::Invalid));
        assert_eq!(p.attempt(ip(1), "", Instant::now()), Err(PairError::Invalid));
    }

    #[test]
    fn five_wrong_guesses_lock_the_address_even_for_the_right_code() {
        let mut p = PairingState::default();
        let t0 = Instant::now();
        for i in 0..5 {
            p.issue(t0); // a fresh live code each time, so the address limiter (not the per-code budget) is what is tested
            assert_eq!(p.attempt(ip(9), "WRONGCODE", t0 + Duration::from_secs(i)), Err(PairError::Invalid));
        }
        let (code, _) = p.issue(t0);
        match p.attempt(ip(9), &code, t0 + Duration::from_secs(6)) {
            Err(PairError::Locked(wait)) => assert!(wait > Duration::from_secs(290) && wait <= PAIR_LOCKOUT),
            other => panic!("expected a lockout, got {other:?}"),
        }
        // A refused (locked) attempt does not burn the code ...
        assert!(p.active(t0).is_some());
        // ... another address is not affected ...
        assert_eq!(p.attempt(ip(10), &code, t0 + Duration::from_secs(6)), Ok(()));
        // ... and after the lockout the first address may try again.
        let (code3, _) = p.issue(t0 + Duration::from_secs(400));
        assert_eq!(p.attempt(ip(9), &code3, t0 + Duration::from_secs(400)), Ok(()));
    }

    #[test]
    fn failures_outside_the_window_do_not_add_up() {
        let mut l = RateLimiter::pairing();
        let t0 = Instant::now();
        for i in 0..20 {
            let now = t0 + Duration::from_secs(i * 61);
            assert!(l.check(ip(1), now).is_ok());
            l.record_failure(ip(1), now);
        }
    }

    #[test]
    fn a_code_is_burned_after_five_wrong_guesses_from_any_addresses() {
        let mut p = PairingState::default();
        let t0 = Instant::now();
        let (code, _) = p.issue(t0);
        for n in 0..5u8 {
            assert_eq!(p.attempt(ip(n + 20), "WRONGCODE", t0), Err(PairError::Invalid));
        }
        assert!(p.active(t0).is_none(), "the code is gone");
        assert_eq!(p.attempt(ip(99), &code, t0), Err(PairError::Invalid), "even the right code no longer works");
    }

    #[test]
    fn the_limiter_stays_bounded() {
        let mut l = RateLimiter::pairing();
        let t0 = Instant::now();
        for n in 0..(MAX_TRACKED as u32 * 2) {
            l.record_failure(IpAddr::from([10, (n >> 16) as u8, (n >> 8) as u8, n as u8]), t0);
        }
        assert!(l.entries.len() <= MAX_TRACKED);
    }
}
