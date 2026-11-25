use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

#[derive(Default)]
pub(crate) struct PendingPageLink(Mutex<Option<String>>);

#[cfg(target_os = "macos")]
pub(crate) fn opened(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let Some(url) = urls.iter().rev().find(|url| {
        matches!(url.as_str(), "blok://calendar" | "blok://calendar/") ||
            (url.scheme() == "blok" && url.host_str() == Some("page") && url.as_str().len() <= 2048)
    }) else { return };
    if let Ok(mut pending) = app.state::<PendingPageLink>().0.lock() {
        *pending = Some(url.to_string());
    }
    if let Some(window) = app.get_webview_window("main") {
        // The URL stays queued if the first WebView is still booting.
        let _ = window.eval("window.dispatchEvent(new Event('blok:page-link'))");
    }
}

#[tauri::command]
pub(crate) fn take_page_link(window: WebviewWindow) -> Option<String> {
    if window.label() != "main" { return None; }
    window.state::<PendingPageLink>().0.lock().ok()?.take()
}
