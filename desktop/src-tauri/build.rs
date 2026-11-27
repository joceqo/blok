fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/macos_quit.m");
        println!("cargo:rerun-if-changed=src/macos_notifications.m");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        cc::Build::new().flag("-fobjc-arc").flag("-fblocks").file("src/macos_notifications.m").compile("blok_macos_notifications");
        cc::Build::new().file("src/macos_quit.m").compile("blok_macos_quit");
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "notification_permission", "post_system_notification", "open_notification_settings", "take_page_link", "open_calendar_authorization", "embedded_server_available", "ensure_embedded_server", "embedded_device_session", "embedded_workspace_backup", "close_editor_window", "arm_editor_close", "finish_editor_close", "load_cloud_session", "save_cloud_session", "load_workspace_file", "save_workspace_file", "save_workspace_export", "workspace_data_directory",
                "agent_provider_status", "agent_ask", "agent_cancel",
                "ai_local_status", "ai_local_save", "ai_local_delete", "ai_local_models", "ai_local_respond", "ai_local_cancel",
            ])),
    )
    .expect("failed to run tauri build script");
}
