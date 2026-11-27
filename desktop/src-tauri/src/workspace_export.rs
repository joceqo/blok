//! Save a completed ZIP in Downloads. Publishing the temporary file without
//! clobbering keeps concurrent exports and existing user files independent.
use std::{
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{
    Manager,
    ipc::{InvokeBody, Request},
};

fn save_zip(directory: &Path, title: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let stem: String = title
        .chars()
        .take(60)
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim_matches(['.', ' ']);
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    for copy in 1.. {
        let suffix = if copy == 1 {
            String::new()
        } else {
            format!(" ({copy})")
        };
        let path = directory.join(format!("Blok - {stem}{suffix}.zip"));
        match temp.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => temp = e.file,
            Err(e) => return Err(e.error.to_string()),
        }
    }
    unreachable!()
}

#[tauri::command]
pub fn save_workspace_export(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Archive ZIP attendue".into());
    };
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err("Archive ZIP invalide".into());
    }
    let encoded = request
        .headers()
        .get("x-blok-workspace")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("Blok");
    let title = percent_encoding::percent_decode_str(encoded).decode_utf8_lossy();
    let directory = app.path().download_dir().map_err(|e| e.to_string())?;
    save_zip(&directory, &title, bytes).map(|path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_complete_archives_without_replacing_an_existing_copy() {
        let dir = tempfile::tempdir().unwrap();
        let first = save_zip(dir.path(), "../Démo", b"one").unwrap();
        let second = save_zip(dir.path(), "../Démo", b"two").unwrap();
        assert_eq!(first.parent(), Some(dir.path()));
        assert_eq!(std::fs::read(first).unwrap(), b"one");
        assert_eq!(std::fs::read(second).unwrap(), b"two");
    }
}
