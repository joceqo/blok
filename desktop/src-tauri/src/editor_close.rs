use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Manager, WebviewWindow, Window, WindowEvent};

#[derive(Default)]
pub(crate) struct EditorClose(AtomicU8);
const UNARMED: u8 = 0;
const ARMED: u8 = 1;
const FLUSHING: u8 = 2;

pub(crate) fn page_started(app: &AppHandle) {
    let previous = app.state::<EditorClose>().0.swap(UNARMED, Ordering::AcqRel);
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
        window
            .state::<EditorClose>()
            .0
            .store(ARMED, Ordering::Release);
    }
}

pub(crate) fn window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() != "main" {
            return;
        }
        let guard = window.state::<EditorClose>();
        match guard
            .0
            .compare_exchange(ARMED, FLUSHING, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => {
                api.prevent_close();
                let delivered = window.get_webview_window("main").is_some_and(|view| {
                    view.eval("window.dispatchEvent(new Event('blok:desktop-prepare-close'))")
                        .is_ok()
                });
                if !delivered {
                    guard.0.store(ARMED, Ordering::Release);
                    #[cfg(target_os = "macos")]
                    unsafe {
                        blok_reply_to_quit(false);
                    }
                }
            }
            Err(FLUSHING) => api.prevent_close(),
            Err(_) => {}
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
                .0
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
        if app.state::<EditorClose>().0.load(Ordering::Acquire) == UNARMED {
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
