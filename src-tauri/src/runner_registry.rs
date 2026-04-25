//! Inline dev-server runner registry.
//!
//! Each repo (or sub-repo) with a `run:` template in `configuration.yml`
//! gets a keyed slot here. `/api/runner/start` spawns a PTY under
//! [`PtyRegistry`][crate::pty::PtyRegistry] and stashes it in the
//! registry; `/api/runner/stop` SIGTERMs + SIGKILLs with a grace window.
//! `/ws/runner/:key` attaches a live viewer to an existing session — it
//! does not spawn on miss (the Code tab always drives spawn through the
//! HTTP endpoint first).
//!
//! Unlike plain terminals, runner sessions survive *exit* — the UI
//! shows `exited: N` until the user clicks Stop, at which point the
//! registry entry is cleared. The PTY's pump thread writes the final
//! exit code into [`RunnerSession::exit_code`] so the fingerprint layer
//! emits `|run:exit:<stamp>:<code>` instead of `|run:run:<stamp>:<ck>`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::pty::PtySession;

/// Monotonic stamp — bumped on every `start` / `exit` event so the
/// fingerprint layer can distinguish two otherwise-identical states
/// ("exited:42" a few seconds apart isn't the same event).
static STAMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_stamp() -> u64 {
    STAMP_COUNTER.fetch_add(1, Ordering::SeqCst) + 1
}

/// One live (or recently exited) runner. `pty` is `None` only after
/// the session is cleared; while live, it carries the shared
/// [`PtySession`] the PTY handler attaches to.
pub struct RunnerSession {
    pub key: String,
    pub checkout_key: String,
    pub path: String,
    pub template: String,
    pub shell: String,
    pub started_at: SystemTime,
    pub pty: Arc<PtySession>,
    pub stamp: Mutex<u64>,
    pub exit_code: Mutex<Option<i32>>,
}

impl RunnerSession {
    pub fn stamp_now(&self) -> u64 {
        *self.stamp.lock().expect("stamp mutex")
    }
    pub fn exit_code_now(&self) -> Option<i32> {
        *self.exit_code.lock().expect("exit mutex")
    }
}

/// Cloneable handle to the runner registry.
#[derive(Clone, Default)]
pub struct RunnerRegistry {
    inner: Arc<Mutex<HashMap<String, Arc<RunnerSession>>>>,
}

impl RunnerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<Arc<RunnerSession>> {
        self.inner.lock().expect("runners mutex").get(key).cloned()
    }

    pub fn insert(&self, session: Arc<RunnerSession>) {
        self.inner
            .lock()
            .expect("runners mutex")
            .insert(session.key.clone(), session);
    }

    pub fn remove(&self, key: &str) -> Option<Arc<RunnerSession>> {
        self.inner.lock().expect("runners mutex").remove(key)
    }

    pub fn keys(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("runners mutex")
            .keys()
            .cloned()
            .collect()
    }

    /// Snapshot of every registry entry — the caller iterates to build
    /// whatever aggregate it needs (e.g. the renderer's `LiveRunners`
    /// map) without holding the mutex across the build. Both live and
    /// exited sessions are returned; filter on `exit_code_now()` if
    /// you only want the running ones.
    pub fn snapshot(&self) -> Vec<Arc<RunnerSession>> {
        self.inner
            .lock()
            .expect("runners mutex")
            .values()
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("runners mutex").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop every registry entry. Used by the graceful-shutdown path
    /// after each runner's drop chain has completed.
    pub fn clear(&self) {
        self.inner.lock().expect("runners mutex").clear();
    }
}

/// Spawn a runner under the shared PTY registry. Returns `Err("already
/// active")` if a live (non-exited) session owns `key` — callers must
/// stop it first. An exited session at `key` is dropped and replaced.
pub fn start(
    runners: &RunnerRegistry,
    pty_registry: &crate::pty::PtyRegistry,
    key: &str,
    checkout_key: &str,
    path: &str,
    template: &str,
    shell: &str,
) -> Result<Arc<RunnerSession>, String> {
    if let Some(existing) = runners.get(key) {
        if existing.exit_code_now().is_none() {
            return Err("already active".into());
        }
        // Drop the exited carcass so the new session takes the slot.
        let _ = runners.remove(key);
    }
    let mode = crate::pty::SpawnMode::RunnerCommand {
        shell: shell.into(),
        template: template.into(),
        path: path.into(),
    };
    let pty = crate::pty::spawn_session(pty_registry, mode, std::path::PathBuf::from(path), 80, 24)
        .map_err(|e| format!("spawn: {e}"))?;

    let session = Arc::new(RunnerSession {
        key: key.into(),
        checkout_key: checkout_key.into(),
        path: path.into(),
        template: template.into(),
        shell: shell.into(),
        started_at: SystemTime::now(),
        pty,
        stamp: Mutex::new(next_stamp()),
        exit_code: Mutex::new(None),
    });
    runners.insert(session.clone());

    // Awaiter: the PTY pump signals its exit watch when EOF lands on
    // the master side. We listen for that single transition and stamp
    // the exit onto the runner — exit propagation is now bounded by
    // event-loop latency rather than the previous 200 ms poll. The
    // UI keeps the session in `exited: N` until the user clicks Stop.
    // portable-pty doesn't expose the child's wait status on the
    // parent side without moving the Child value, so we default to 0.
    let watcher_runner = session.clone();
    let watcher_runners = runners.clone();
    let watcher_key = key.to_string();
    let mut exit_rx = session.pty.subscribe_exit();
    tokio::spawn(async move {
        // First flip from `false` to `true` is the EOF signal. If the
        // session was manually cleared from the registry while we
        // were awaiting, drop out without stamping anything — the
        // explicit stop path handles its own bookkeeping.
        let _ = exit_rx.changed().await;
        if watcher_runners.get(&watcher_key).is_none() {
            return;
        }
        *watcher_runner.exit_code.lock().expect("exit mutex") = Some(0);
        *watcher_runner.stamp.lock().expect("stamp mutex") = next_stamp();
    });

    Ok(session)
}

/// Run the configured `force_stop` shell command for a single repo
/// key, blocking up to `grace` for it to finish. Errors are swallowed
/// — `force_stop` is a best-effort cleanup hook the user supplies.
async fn run_force_stop(command: &str, grace: std::time::Duration) {
    let cmd = command.to_string();
    let spawn = tokio::task::spawn_blocking(move || {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
    })
    .await;
    let mut child = match spawn {
        Ok(Ok(c)) => c,
        _ => return,
    };
    let wait = tokio::task::spawn_blocking(move || child.wait());
    let _ = tokio::time::timeout(grace, wait).await;
}

/// Graceful shutdown — for every live runner, run any configured
/// `force_stop` shell command first (so users can free a port before
/// condash's own SIGTERM reaches the runner's children), then SIGTERM
/// the PTY child. Awaits each session's PTY exit signal up to `grace`
/// so the host doesn't exit while a runner's drop chain is still in
/// flight. Called from the Tauri host's `WindowEvent::CloseRequested`
/// handler.
pub async fn shutdown(
    runners: &RunnerRegistry,
    force_stop_templates: &std::collections::HashMap<String, String>,
    grace: std::time::Duration,
) {
    let sessions = runners.snapshot();
    let mut handles = Vec::with_capacity(sessions.len());
    for session in sessions {
        if session.exit_code_now().is_some() {
            continue;
        }
        let force_stop = force_stop_templates.get(&session.key).cloned();
        let pty = session.pty.clone();
        handles.push(tokio::spawn(async move {
            if let Some(cmd) = force_stop {
                run_force_stop(&cmd, grace).await;
            }
            pty.kill();
            let mut rx = pty.subscribe_exit();
            if !*rx.borrow() {
                let _ = tokio::time::timeout(grace, rx.changed()).await;
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    // Drop every registry slot — the host is going away.
    runners.clear();
}

/// Stop a runner. SIGTERMs the PTY child (dropping its Child handle),
/// waits for `grace` for the pump thread to reap, then drops the
/// registry slot. Returns `Ok(true)` when the slot was cleared,
/// `Ok(false)` when `key` wasn't live, `Err(_)` on non-fatal trouble.
pub async fn stop(
    runners: &RunnerRegistry,
    key: &str,
    grace: std::time::Duration,
) -> Result<bool, String> {
    let Some(session) = runners.get(key) else {
        return Ok(false);
    };
    // Already exited → just clear.
    if session.exit_code_now().is_some() {
        let _ = runners.remove(key);
        return Ok(true);
    }
    session.pty.kill();
    // Wait on the PTY's exit watch — the runner exit watcher (above)
    // flips `exit_code` from the same signal, so as soon as the pump
    // observes EOF the watcher's tokio task will stamp the code.
    // Either path satisfies us; whichever lands first ends the wait.
    let mut exit_rx = session.pty.subscribe_exit();
    if !*exit_rx.borrow() && session.exit_code_now().is_none() {
        let _ = tokio::time::timeout(grace, exit_rx.changed()).await;
    }
    // If the exit watcher hasn't flipped the code yet, stamp it
    // manually so the UI isn't left showing "running" on a dead
    // process.
    if session.exit_code_now().is_none() {
        *session.exit_code.lock().expect("exit mutex") = Some(-15); // -SIGTERM convention: negate the signal number the runner was killed with
        *session.stamp.lock().expect("stamp mutex") = next_stamp();
    }
    let _ = runners.remove(key);
    Ok(true)
}

/// Short token describing the session's visible state — used by the
/// Code-tab fingerprint layer. Matches Python's `fingerprint_token`.
pub fn fingerprint_token(runners: &RunnerRegistry, key: &str) -> String {
    match runners.get(key) {
        None => "off".into(),
        Some(session) => match session.exit_code_now() {
            Some(code) => format!("exit:{}:{}", session.stamp_now(), code),
            None => format!("run:{}:{}", session.stamp_now(), session.checkout_key),
        },
    }
}

/// Drop an exited session without SIGTERM (no-op if live). Mirrors
/// Python's `clear_exited`.
pub fn clear_exited(runners: &RunnerRegistry, key: &str) -> bool {
    let Some(session) = runners.get(key) else {
        return false;
    };
    if session.exit_code_now().is_none() {
        return false;
    }
    runners.remove(key);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::PtyRegistry;

    #[test]
    fn registry_basic() {
        let reg = RunnerRegistry::new();
        assert!(reg.is_empty());
        assert_eq!(fingerprint_token(&reg, "condash"), "off");
        assert_eq!(reg.keys().len(), 0);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn start_runs_and_stop_clears_slot() {
        let pty_reg = PtyRegistry::new();
        let runners = RunnerRegistry::new();
        // A runner that just blocks for 30 s so we have time to stop it
        // deterministically.
        let session = start(
            &runners,
            &pty_reg,
            "demo",
            "demo@main",
            "/tmp",
            "sleep 30",
            "/bin/sh",
        )
        .expect("start ok");
        assert_eq!(runners.len(), 1);
        assert!(session.exit_code_now().is_none());
        assert!(fingerprint_token(&runners, "demo").starts_with("run:"));

        // Stop it — should clear the slot within the grace window.
        let ok = stop(&runners, "demo", std::time::Duration::from_secs(5))
            .await
            .expect("stop ok");
        assert!(ok);
        assert_eq!(runners.len(), 0);
        assert_eq!(fingerprint_token(&runners, "demo"), "off");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn start_refuses_double_start() {
        let pty_reg = PtyRegistry::new();
        let runners = RunnerRegistry::new();
        let _s = start(
            &runners,
            &pty_reg,
            "demo",
            "demo@main",
            "/tmp",
            "sleep 30",
            "/bin/sh",
        )
        .expect("first start");
        let result = start(
            &runners,
            &pty_reg,
            "demo",
            "demo@main",
            "/tmp",
            "sleep 30",
            "/bin/sh",
        );
        match result {
            Err(e) => assert!(e.contains("active"), "unexpected err: {e}"),
            Ok(_) => panic!("second start should have failed"),
        }
        let _ = stop(&runners, "demo", std::time::Duration::from_secs(5)).await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn clear_exited_drops_exited_slot() {
        let pty_reg = PtyRegistry::new();
        let runners = RunnerRegistry::new();
        let session = start(
            &runners,
            &pty_reg,
            "demo",
            "demo@main",
            "/tmp",
            // Exits immediately.
            "true",
            "/bin/sh",
        )
        .expect("start");
        // Wait for the exit watcher to flip the code.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if session.exit_code_now().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(session.exit_code_now().is_some(), "exit code never set");
        assert!(fingerprint_token(&runners, "demo").starts_with("exit:"));
        assert!(clear_exited(&runners, "demo"));
        assert_eq!(fingerprint_token(&runners, "demo"), "off");
    }
}
