#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn blok_notification_permission(request: bool) -> i32;
    fn blok_send_notification(id: *const std::ffi::c_char, body: *const std::ffi::c_char) -> bool;
}

#[tauri::command]
pub(crate) async fn notification_permission(request: bool) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let result = tauri::async_runtime::spawn_blocking(move || unsafe { blok_notification_permission(request) })
            .await.map_err(|error| error.to_string())?;
        return match result {
            0 => Ok("default".into()),
            1 => Ok("granted".into()),
            2 => Ok("denied".into()),
            _ => Err("Autorisation des notifications inaccessible.".into()),
        };
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = request; Ok("unavailable".into()) }
}

#[tauri::command]
pub(crate) async fn post_system_notification(id: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        if id.len() > 160 || body.len() > 512 { return Err("Notification invalide.".into()); }
        let id = CString::new(id).map_err(|_| "Identifiant invalide.")?;
        let body = CString::new(body).map_err(|_| "Texte invalide.")?;
        let sent = tauri::async_runtime::spawn_blocking(move || unsafe { blok_send_notification(id.as_ptr(), body.as_ptr()) })
            .await.map_err(|error| error.to_string())?;
        if sent { Ok(()) } else { Err("Le système a refusé cette notification.".into()) }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (id,body); Err("Notifications système indisponibles.".into()) }
}

#[tauri::command]
pub(crate) fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        .spawn().map(|_| ()).map_err(|error| error.to_string()) }
    #[cfg(not(target_os = "macos"))]
    { Err("Réglages système indisponibles.".into()) }
}
