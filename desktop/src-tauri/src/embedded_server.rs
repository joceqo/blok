use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Child;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};
use tauri::Manager;

const READY_TIMEOUT: Duration = Duration::from_secs(150);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(100);

struct Resources {
    runtime: PathBuf,
    web: PathBuf,
}

fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

impl Resources {
    fn in_bundle(root: &Path) -> Self {
        Self {
            runtime: root.join("bundled-runtime"),
            web: root.join("bundled-web"),
        }
    }

    fn available(&self) -> bool {
        self.web.join("index.html").is_file()
            && [
                format!("bin/{}", executable("node")),
                format!("bin/{}", executable("weed")),
                format!("postgres/bin/{}", executable("initdb")),
                format!("postgres/bin/{}", executable("postgres")),
                "supervisor.mjs".into(),
                "app/main.mjs".into(),
                "app/schema.sql".into(),
                "room/room.mjs".into(),
                "room/media.mjs".into(),
            ]
            .iter()
            .all(|relative| self.runtime.join(relative).is_file())
    }
}

// Delivered by our child over a private pipe. Only the public origin is exposed
// by ensure_embedded_server. Keep these credentials out of Debug and Serialize.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    origin: String,
    api_origin: String,
    device_secret: String,
}

fn valid_endpoint(origin: &str) -> bool {
    tauri::Url::parse(origin).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some_and(|port| port > 0)
            && url.origin().ascii_serialization() == origin
    })
}

fn parse_ready(line: &[u8]) -> Result<Ready, String> {
    let invalid = || "Le serveur embarqué a renvoyé une configuration locale invalide.".to_string();
    let ready: Ready = serde_json::from_slice(line).map_err(|_| invalid())?;
    if !valid_endpoint(&ready.origin)
        || !valid_endpoint(&ready.api_origin)
        || ready.origin == ready.api_origin
        || !(32..=128).contains(&ready.device_secret.len())
        || !ready
            .device_secret
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(invalid());
    }
    Ok(ready)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceSession {
    #[serde(skip_deserializing)]
    origin: String,
    user: serde_json::Value,
    workspaces: Vec<serde_json::Value>,
    support_email: Option<String>,
    device_workspace_id: String,
    device_active_page_id: Option<String>,
    device_imported_workspace_id: Option<String>,
    token: String,
}

impl Ready {
    async fn device_session(&self) -> Result<DeviceSession, String> {
        let failed = |_| "Impossible d’ouvrir le compte de cet appareil.".to_string();
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(failed)?;
        let response = http
            .post(format!("{}/internal/desktop/session", self.api_origin))
            .bearer_auth(&self.device_secret)
            .send()
            .await
            .map_err(failed)?;
        if !response.status().is_success() {
            return Err(format!(
                "Le serveur local a refusé la session de cet appareil ({}).",
                response.status().as_u16()
            ));
        }
        let mut session: DeviceSession = response.json().await.map_err(failed)?;
        session.origin = self.origin.clone();
        Ok(session)
    }
}

#[derive(Default)]
pub(crate) struct EmbeddedServer {
    running: Mutex<Option<ServerProcess>>,
    quitting: AtomicBool,
}

struct ServerProcess {
    input: Option<ChildStdin>,
    output: Option<ChildStdout>,
    exited: mpsc::Receiver<()>,
    ready: Option<Ready>,
    #[cfg(unix)]
    group: i32,
    #[cfg(windows)]
    job: std::sync::Arc<std::os::windows::io::OwnedHandle>,
}

#[cfg(windows)]
fn own_process_tree(child: &Child) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    // Closing this handle also stops any remaining embedded database or media processes.
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
}

impl ServerProcess {
    fn launch(resources: &Resources, data: &Path) -> Result<Self, String> {
        use std::fs::OpenOptions;
        fs::create_dir_all(data).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(data, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .open(data.join("supervisor.log"))
            .map_err(|e| e.to_string())?;
        let mut command = Command::new(resources.runtime.join("bin").join(executable("node")));
        command
            .arg(resources.runtime.join("supervisor.mjs"))
            .arg("--resources")
            .arg(&resources.runtime)
            .arg("--data")
            .arg(data)
            .arg("--web")
            .arg(&resources.web)
            .current_dir(data)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Impossible de lancer le serveur embarqué : {e}"))?;
        #[cfg(windows)]
        let job = match own_process_tree(&child) {
            Ok(job) => std::sync::Arc::new(job),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        };
        let input = child.stdin.take();
        let output = child.stdout.take();
        let (notify, exited) = mpsc::channel();
        #[cfg(unix)]
        let group = child.id() as i32;
        #[cfg(windows)]
        let monitor_job = job.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            // Even a supervisor crash while the app is idle must release its
            // PostgreSQL/S3/Node processes before the next launch.
            #[cfg(unix)]
            terminate_orphan_group(group);
            #[cfg(windows)]
            terminate_job(&monitor_job);
            let _ = notify.send(());
        });
        Ok(Self {
            input,
            output,
            exited,
            ready: None,
            #[cfg(unix)]
            group,
            #[cfg(windows)]
            job,
        })
    }

    fn wait_ready(&mut self, quitting: &AtomicBool, timeout: Duration) -> Result<Ready, String> {
        let stdout = self.output.take().expect("piped supervisor stdout");
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let ready = reader
                .by_ref()
                .take(4096)
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())
                .and_then(|n| {
                    if n == 0 {
                        Err("Le serveur embarqué s’est arrêté avant de démarrer. Consultez embedded-server/supervisor.log.".into())
                    } else {
                        parse_ready(&line)
                    }
                });
            let _ = send.send(ready);
            let _ = io::copy(&mut reader, &mut io::sink());
        });
        let deadline = Instant::now() + timeout;
        while !quitting.load(Ordering::Acquire) && Instant::now() < deadline {
            match receive.recv_timeout(POLL) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        Err("Le serveur embarqué n’a pas démarré à temps. Consultez supervisor.log dans le dossier embedded-server.".into())
    }
}

#[cfg(unix)]
fn terminate_orphan_group(group: i32) {
    // The supervisor normally exits after reaping every service.
    // A negative pid targets just its group if a service survived it.
    if unsafe { libc::kill(-group, libc::SIGTERM) } != 0 {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if unsafe { libc::kill(-group, 0) } != 0 {
            return;
        }
        std::thread::sleep(POLL);
    }
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_job(job: &std::os::windows::io::OwnedHandle) {
    use std::os::windows::io::AsRawHandle;
    unsafe {
        windows_sys::Win32::System::JobObjects::TerminateJobObject(job.as_raw_handle(), 1);
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        // EOF allows the supervisor to flush documents and stop the database cleanly.
        drop(self.input.take());
        if matches!(
            self.exited.recv_timeout(STOP_TIMEOUT),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-self.group, libc::SIGKILL);
            }
            #[cfg(windows)]
            terminate_job(&self.job);
            let _ = self.exited.recv_timeout(Duration::from_secs(5));
        }
    }
}

impl EmbeddedServer {
    fn ensure(&self, resources: &Resources, data: &Path) -> Result<Ready, String> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| "État du serveur indisponible.")?;
        if self.quitting.load(Ordering::Acquire) {
            return Err("Blok se ferme.".into());
        }
        if let Some(process) = running.as_ref() {
            if matches!(process.exited.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                if let Some(ready) = &process.ready {
                    return Ok(ready.clone());
                }
            }
        }
        drop(running.take());
        if !resources.available() {
            return Err(
                "Les composants du serveur embarqué sont absents de cette distribution.".into(),
            );
        }
        let mut process = ServerProcess::launch(resources, data)?;
        let ready = process.wait_ready(&self.quitting, READY_TIMEOUT)?;
        process.ready = Some(ready.clone());
        *running = Some(process);
        Ok(ready)
    }

    pub(crate) fn shutdown(&self) {
        self.quitting.store(true, Ordering::Release);
        if let Ok(mut running) = self.running.lock() {
            drop(running.take());
        }
    }
}

#[tauri::command]
pub(crate) fn embedded_server_available(app: tauri::AppHandle) -> bool {
    app.path()
        .resource_dir()
        .is_ok_and(|path| Resources::in_bundle(&path).available())
}

async fn ready_server(app: tauri::AppHandle) -> Result<Ready, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resources =
            Resources::in_bundle(&app.path().resource_dir().map_err(|e| e.to_string())?);
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("embedded-server");
        app.state::<EmbeddedServer>().ensure(&resources, &data)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn ensure_embedded_server(app: tauri::AppHandle) -> Result<String, String> {
    Ok(ready_server(app).await?.origin)
}

fn trusted_webview(label: &str, url: &tauri::Url) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
        );
    bundled
        || (cfg!(debug_assertions) && url.origin().ascii_serialization() == "http://localhost:1420")
}

#[tauri::command]
pub(crate) async fn embedded_device_session(
    webview: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<DeviceSession, String> {
    if !trusted_webview(webview.label(), &webview.url().map_err(|e| e.to_string())?) {
        return Err("La session locale est réservée à la fenêtre Blok.".into());
    }
    ready_server(app).await?.device_session().await
}

#[tauri::command]
pub(crate) async fn embedded_workspace_backup(
    webview: tauri::WebviewWindow,
    app: tauri::AppHandle,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    if !trusted_webview(webview.label(), &webview.url().map_err(|e| e.to_string())?) {
        return Err("Commande réservée à Blok Desktop.".into());
    }
    ready_server(app.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let runtime =
            Resources::in_bundle(&app.path().resource_dir().map_err(|e| e.to_string())?).runtime;
        let data = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("embedded-server");
        let mut child = Command::new(runtime.join("bin").join(executable("node")))
            .arg(runtime.join("app/backup.mjs"))
            .arg(data)
            .arg(&runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        child
            .stdin
            .take()
            .ok_or("Canal local indisponible")?
            .write_all(&serde_json::to_vec(&options).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let result = child.wait_with_output().map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err("Le processus de sauvegarde a été interrompu.".into());
        }
        serde_json::from_slice(&result.stdout).map_err(|_| "Réponse de sauvegarde invalide.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_private_supervisor_endpoints_and_a_separate_credential() {
        let ready = |origin: &str, api: &str, secret: &str| {
            let bytes = serde_json::to_vec(
                &serde_json::json!({"origin":origin,"apiOrigin":api,"deviceSecret":secret}),
            )
            .unwrap();
            parse_ready(&bytes)
        };
        let secret = "a".repeat(48);
        let public = "http://127.0.0.1:18400";
        let private = "http://127.0.0.1:18401";
        assert_eq!(ready(public, private, &secret).unwrap().origin, public);
        for origin in [
            "https://example.com",
            "http://localhost:8080",
            "http://0.0.0.0:8000",
            "http://127.0.0.1:8000/a",
            "http://user@127.0.0.1:8000",
            "http://127.0.0.1:8000?x=1",
        ] {
            assert!(ready(origin, private, &secret).is_err());
            assert!(ready(public, origin, &secret).is_err());
        }
        assert!(ready(public, public, &secret).is_err());
        assert!(ready(public, private, "short").is_err());
    }

    #[test]
    fn local_session_is_limited_to_bundled_main_ui() {
        let trusted =
            |label: &str, url: &str| trusted_webview(label, &tauri::Url::parse(url).unwrap());
        assert!(trusted("main", "tauri://localhost/?view=calendar"));
        assert!(trusted("main", "https://tauri.localhost"));
        assert!(!trusted("other", "tauri://localhost"));
        assert!(!trusted("main", "http://127.0.0.1:18400"));
        assert!(!trusted("main", "https://remote.test"));
        assert!(!trusted("main", "https://tauri.localhost:8888"));
    }

    #[test]
    fn device_session_refuses_redirects() {
        use std::io::Write;
        use std::net::TcpListener;

        let api = TcpListener::bind("127.0.0.1:0").unwrap();
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let api_origin = format!("http://{}", api.local_addr().unwrap());
        let location = format!("http://{}", other.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (socket, _) = api.accept().unwrap();
            let mut req = BufReader::new(socket);
            let mut lines = Vec::new();
            loop {
                let mut line = String::new();
                if req.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                lines.push(line);
            }
            assert!(lines[0].starts_with("POST /internal/desktop/session "));
            assert!(lines.iter().any(|line| {
                line.trim()
                    .eq_ignore_ascii_case("Authorization: Bearer private-test-secret")
            }));
            write!(req.into_inner(),"HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let ready = Ready {
            origin: "http://127.0.0.1:8331".into(),
            api_origin,
            device_secret: "private-test-secret".into(),
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(rt.block_on(ready.device_session()).is_err());
        server.join().unwrap();
        other.set_nonblocking(true).unwrap();
        assert!(matches!(other.accept(), Err(e) if e.kind() == io::ErrorKind::WouldBlock));
    }

    #[cfg(unix)]
    #[test]
    fn starts_once_and_notifies_the_supervisor_on_exit() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let resources = Resources::in_bundle(dir.path());
        let data = dir.path().join("data");
        let manager = EmbeddedServer::default();
        assert!(!resources.available());
        assert!(manager.ensure(&resources, &data).is_err());
        assert!(!data.exists());
        for file in [
            "bin/node",
            "bin/weed",
            "postgres/bin/postgres",
            "postgres/bin/initdb",
            "supervisor.mjs",
            "app/main.mjs",
            "app/schema.sql",
            "room/room.mjs",
            "room/media.mjs",
        ] {
            let path = resources.runtime.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }
        fs::create_dir_all(&resources.web).unwrap();
        fs::write(resources.web.join("index.html"), "").unwrap();
        let binary = resources.runtime.join("bin/node");
        fs::write(
            &binary,
            r#"#!/bin/sh
echo start >> launches
echo '{"origin":"http://127.0.0.1:18733","apiOrigin":"http://127.0.0.1:18734","deviceSecret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
cat > /dev/null
echo stop >> launches
"#,
        )
        .unwrap();
        fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| manager.ensure(&resources, &data).unwrap());
            let second = scope.spawn(|| manager.ensure(&resources, &data).unwrap());
            assert_eq!(first.join().unwrap().origin, second.join().unwrap().origin);
        });
        manager.shutdown();
        assert_eq!(
            fs::read_to_string(data.join("launches")).unwrap(),
            "start\nstop\n"
        );
        assert!(manager.ensure(&resources, &data).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reaps_services_if_the_supervisor_crashes_while_the_app_stays_open() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let resources = Resources::in_bundle(dir.path());
        let data = dir.path().join("data");
        let binary = resources.runtime.join("bin/node");
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(
            &binary,
            r#"#!/bin/sh
sleep 90 &
echo "$!" > service-pid
echo '{"origin":"http://127.0.0.1:18733","apiOrigin":"http://127.0.0.1:18734","deviceSecret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
read keepalive
"#,
        )
        .unwrap();
        fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
        let mut process = ServerProcess::launch(&resources, &data).unwrap();
        process
            .wait_ready(&AtomicBool::new(false), Duration::from_secs(5))
            .unwrap();
        let daemon: i32 = fs::read_to_string(data.join("service-pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        unsafe {
            libc::kill(process.group, libc::SIGKILL);
        }
        process
            .exited
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        assert_ne!(
            unsafe { libc::kill(daemon, 0) },
            0,
            "orphan service still running"
        );
    }

    // Use the staged (or mounted DMG's) resources to exercise the actual Rust
    // launcher headlessly. The test data is private to this test run.
    #[test]
    #[ignore = "requires packaged native backend resources"]
    fn starts_the_packaged_server_and_stops_it() {
        let root =
            std::env::var_os("BLOK_TEST_BUNDLE_RESOURCES").expect("Set BLOK_TEST_BUNDLE_RESOURCES");
        let resources = Resources::in_bundle(Path::new(&root));
        let data = tempfile::tempdir().unwrap();
        let manager = EmbeddedServer::default();
        let ready = match manager.ensure(&resources, data.path()) {
            Ok(ready) => ready,
            Err(error) => panic!(
                "{error} — journal : {}",
                data.keep().join("supervisor.log").display()
            ),
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let session = rt.block_on(async {
            let info: serde_json::Value = http
                .get(format!("{}/api/instance", ready.origin))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(info["setupRequired"], false);
            assert_eq!(
                http.post(format!("{}/internal/desktop/session", ready.origin))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
            assert!(
                !http
                    .post(format!("{}/internal/desktop/session", ready.api_origin))
                    .send()
                    .await
                    .unwrap()
                    .status()
                    .is_success()
            );
            let session = ready.device_session().await.unwrap();
            let authenticated: serde_json::Value = http
                .get(format!("{}/api/session", ready.origin))
                .bearer_auth(&session.token)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(authenticated["user"]["id"], session.user["id"]);
            assert!(
                session
                    .workspaces
                    .iter()
                    .any(|space| space["id"] == session.device_workspace_id)
            );
            session
        });
        assert_eq!(
            manager.ensure(&resources, data.path()).unwrap().origin,
            ready.origin
        );
        manager.shutdown();
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(data.path().join("instance.json")).unwrap()).unwrap();
        for (service, port) in state["ports"].as_object().unwrap() {
            let port = port.as_u64().unwrap() as u16;
            assert!(
                std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
                "{service} still listening after shutdown"
            );
        }
        let reopened = EmbeddedServer::default();
        let second = reopened.ensure(&resources, data.path()).unwrap();
        assert_eq!(second.origin, ready.origin);
        let restored = rt.block_on(second.device_session()).unwrap();
        assert_eq!(restored.device_workspace_id, session.device_workspace_id);
        assert_eq!(restored.user["id"], session.user["id"]);
        reopened.shutdown();
    }
}
