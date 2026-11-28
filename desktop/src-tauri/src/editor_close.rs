use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow, Window, WindowEvent};

#[derive(Default)]
pub(crate) struct EditorClose {
    state: AtomicU8,
    /// When the flush now running started, so the wait can be bounded.
    since: Mutex<Option<Instant>>,
}
const UNARMED: u8 = 0;
const ARMED: u8 = 1;
const FLUSHING: u8 = 2;

/// How long a close request waits for the renderer to flush before it gives up.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// What a close request does, given the guard.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseDecision {
    /// Nothing to flush: let the window close.
    Close,
    /// Ask the renderer to flush, and hold the window open.
    Flush,
    /// A flush is already running: hold the window open.
    Wait,
}

impl EditorClose {
    fn since(&self) -> MutexGuard<'_, Option<Instant>> {
        self.since
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn arm(&self) {
        self.state.store(ARMED, Ordering::Release);
    }

    /// `now` is passed in rather than read, so the wait can be tested.
    fn request_close(&self, now: Instant) -> CloseDecision {
        match self
            .state
            .compare_exchange(ARMED, FLUSHING, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => {
                *self.since() = Some(now);
                CloseDecision::Flush
            }
            Err(FLUSHING) => {
                let started = *self.since();
                // A renderer that lost its server connection never answers.
                // Holding the window for it forever makes the app impossible
                // to quit, so the wait gives up and lets the window go.
                match started {
                    Some(at) if now.saturating_duration_since(at) >= FLUSH_TIMEOUT => {
                        self.state.store(UNARMED, Ordering::Release);
                        *self.since() = None;
                        CloseDecision::Close
                    }
                    _ => CloseDecision::Wait,
                }
            }
            Err(_) => CloseDecision::Close,
        }
    }
}

pub(crate) fn page_started(app: &AppHandle) {
    let previous = app
        .state::<EditorClose>()
        .state
        .swap(UNARMED, Ordering::AcqRel);
    // The old renderer will never answer. Cancel any deferred OS quit; the new
    // page arms its own guard before it mounts an editor.
    #[cfg(target_os = "macos")]
    if previous != UNARMED {
        let _ = app.run_on_main_thread(|| unsafe {
            blok_reply_to_quit(false);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = previous;
}

#[tauri::command]
pub(crate) fn arm_editor_close(window: WebviewWindow) {
    if window.label() == "main" {
        window.state::<EditorClose>().arm();
    }
}

pub(crate) fn window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() != "main" {
            return;
        }
        let guard = window.state::<EditorClose>();
        match guard.request_close(Instant::now()) {
            CloseDecision::Flush => {
                api.prevent_close();
                let delivered = window.get_webview_window("main").is_some_and(|view| {
                    view.eval("window.dispatchEvent(new Event('blok:desktop-prepare-close'))")
                        .is_ok()
                });
                if !delivered {
                    guard.arm();
                    #[cfg(target_os = "macos")]
                    unsafe {
                        blok_reply_to_quit(false);
                    }
                }
            }
            CloseDecision::Wait => api.prevent_close(),
            CloseDecision::Close => {}
        }
    }
}

#[tauri::command]
pub(crate) fn finish_editor_close(window: WebviewWindow, saved: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Fenêtre inconnue.".into());
    }
    let main = window.clone();
    window
        .run_on_main_thread(move || {
            let next = if saved { UNARMED } else { ARMED };
            if main
                .state::<EditorClose>()
                .state
                .compare_exchange(FLUSHING, next, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return; // A stale response from a renderer that navigated away.
            }
            if saved {
                let _ = main.hide();
            }
            #[cfg(target_os = "macos")]
            // On the UI thread; Cocoa may be waiting for our answer to Quit.
            if unsafe { blok_reply_to_quit(saved) } {
                return;
            }
            if saved {
                let _ = main.destroy();
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn blok_install_quit_guard(request: extern "C" fn() -> bool) -> bool;
    fn blok_reply_to_quit(saved: bool) -> bool;
}

#[cfg(target_os = "macos")]
pub(crate) fn install_macos_quit(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::OnceLock;
    static APP: OnceLock<AppHandle> = OnceLock::new();
    extern "C" fn request() -> bool {
        let Some(app) = APP.get() else {
            return false;
        };
        if app.state::<EditorClose>().state.load(Ordering::Acquire) == UNARMED {
            return false;
        }
        app.get_webview_window("main")
            .is_some_and(|view| view.close().is_ok())
    }
    let _ = APP.set(app.handle().clone());
    // Setup runs on the main thread, after Tao installs the application delegate.
    if !unsafe { blok_install_quit_guard(request) } {
        return Err("Le gestionnaire de fermeture macOS est indisponible.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_guard_with_nothing_to_flush_lets_the_window_close() {
        let guard = EditorClose::default();

        assert_eq!(guard.request_close(Instant::now()), CloseDecision::Close);
    }

    #[test]
    fn an_armed_guard_asks_the_renderer_to_flush_first() {
        let guard = EditorClose::default();
        guard.arm();

        assert_eq!(guard.request_close(Instant::now()), CloseDecision::Flush);
    }

    #[test]
    fn a_second_request_while_the_flush_runs_holds_the_window() {
        let guard = EditorClose::default();
        guard.arm();
        let start = Instant::now();
        guard.request_close(start);

        assert_eq!(guard.request_close(start), CloseDecision::Wait);
    }

    /// A renderer that lost its server connection never answers. Without a
    /// bound on the wait, every later request is refused too and the window
    /// can never be closed again -- the app becomes impossible to quit.
    #[test]
    fn a_renderer_that_never_answers_stops_holding_the_window() {
        let guard = EditorClose::default();
        guard.arm();
        let start = Instant::now();
        guard.request_close(start);

        assert_eq!(
            guard.request_close(start + FLUSH_TIMEOUT),
            CloseDecision::Close
        );
    }

    #[test]
    fn a_flush_still_within_its_window_keeps_holding() {
        let guard = EditorClose::default();
        guard.arm();
        let start = Instant::now();
        guard.request_close(start);

        assert_eq!(
            guard.request_close(start + FLUSH_TIMEOUT - Duration::from_millis(1)),
            CloseDecision::Wait
        );
    }
}
