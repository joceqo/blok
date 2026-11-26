//! The local sync endpoint.
//!
//! A local workspace has no service to connect to, so its windows relay
//! collaboration frames to one another through [`crate::collab_broadcast`]. An
//! agent over MCP cannot join that: it is a separate process, and Tauri events
//! never leave the app.
//!
//! This listens on loopback and speaks the same frames, so the agent's existing
//! live client connects to a local workspace exactly as it connects to a server.
//! It relays and does not arbitrate — the updates commute, every participant
//! applies what it receives, and the windows remain the ones holding the
//! document.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tauri::{Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message;

/// The version the windows speak, and the only one this relay selects.
const SYNC_SUBPROTOCOL_V1: &str = "blok-sync.v1";

/// One frame on its way between the windows and the connected agents.
#[derive(Clone, serde::Serialize)]
pub struct CollabFrame {
    pub workspace: String,
    pub doc: String,
    pub frame: Vec<u8>,
}

struct Client {
    workspace: String,
    doc: String,
    send: UnboundedSender<Vec<u8>>,
}

/// Where the endpoint can be reached, and the secret that admits a caller.
#[derive(Clone, serde::Serialize)]
pub struct SyncEndpoint {
    pub url: String,
    pub token: String,
}

#[derive(Default)]
pub struct SyncServer {
    clients: Mutex<HashMap<u64, Client>>,
    endpoint: Mutex<Option<SyncEndpoint>>,
    next_id: Mutex<u64>,
}

impl SyncServer {
    /// Sends a frame to every agent watching this document.
    pub fn fan_out(&self, workspace: &str, doc: &str, frame: &[u8], except: Option<u64>) {
        let clients = match self.clients.lock() {
            Ok(clients) => clients,
            Err(poisoned) => poisoned.into_inner(),
        };

        for (id, client) in clients.iter() {
            if Some(*id) != except && client.workspace == workspace && client.doc == doc {
                // A full or closed receiver means a client that is already gone.
                let _ = client.send.send(frame.to_vec());
            }
        }
    }

    pub fn endpoint(&self) -> Option<SyncEndpoint> {
        match self.endpoint.lock() {
            Ok(endpoint) => endpoint.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

/// A 32-character secret from the system's random source.
///
/// Not the clock, the pid and an address: anything on this machine can reach the
/// port, and a token someone can derive from when the app started is no better
/// than no token at all.
fn mint_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];

    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;

    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// What a connection asked for, however it spelled it.
struct Route {
    workspace: String,
    doc: String,
    token: Option<String>,
}

/// Reads `workspace`, `doc` and the token out of the request target.
///
/// Two spellings, because two callers. A plain client names everything in the
/// query. An agent's live client builds its URL as `<base>/<doc>` and has no
/// room for a query, so the workspace rides in the path — `/sync/<workspace>/<doc>`
/// — and its ticket arrives as the last WebSocket subprotocol instead.
fn route(target: &str) -> Option<Route> {
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    };
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let doc = decode(segments.last()?);
    let mut workspace = segments
        .len()
        .checked_sub(2)
        .and_then(|index| segments.get(index))
        .filter(|segment| **segment != "sync")
        .map(|segment| decode(segment));
    let mut token = None;

    for pair in query.unwrap_or("").split('&') {
        match pair.split_once('=') {
            Some(("workspace", value)) => workspace = Some(decode(value)),
            Some(("token", value)) => token = Some(decode(value)),
            _ => {}
        }
    }

    if doc.is_empty() || doc == "sync" {
        return None;
    }

    Some(Route {
        workspace: workspace.unwrap_or_else(|| "default".to_string()),
        doc,
        token,
    })
}

/// Percent-decoding, enough for the ids and workspace names that reach here.
fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

async fn serve(app: tauri::AppHandle, stream: TcpStream, token: String) {
    let state = app.state::<Arc<SyncServer>>().inner().clone();
    let routed = Arc::new(Mutex::new(None::<(String, String)>));
    let seen = routed.clone();
    let expected = token.clone();

    let accepted = tokio_tungstenite::accept_hdr_async(
        stream,
        |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
         response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            // The ticket an agent's client sends rides as the last subprotocol,
            // after the versions it offers.
            let offers: Vec<String> = request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.split(',').map(|part| part.trim().to_string()).collect())
                .unwrap_or_default();
            let offered_protocol = offers.last().cloned();

            let found = route(&request.uri().to_string());
            let admitted = found
                .as_ref()
                .and_then(|route| route.token.clone().or(offered_protocol))
                .as_deref()
                == Some(expected.as_str());

            match found {
                // Loopback is not a permission: any process on this machine can
                // reach the port, so the token is what admits a caller.
                //
                // No subprotocol is selected in reply, which leaves the session
                // on v1 — the version the windows speak. Agreeing to v2 would
                // promise durable acknowledgements this relay never sends.
                Some(route) if admitted => {
                    *seen.lock().expect("sync route lock") = Some((route.workspace, route.doc));

                    // A client that offered versions refuses a handshake that
                    // selects none. v1 is the one the windows speak: selecting
                    // v2 would promise durable acknowledgements this relay never
                    // sends, and the client would wait for them before writing.
                    let mut response = response;

                    if offers.iter().any(|offer| offer == SYNC_SUBPROTOCOL_V1) {
                        if let Ok(value) = SYNC_SUBPROTOCOL_V1.parse() {
                            response
                                .headers_mut()
                                .insert("sec-websocket-protocol", value);
                        }
                    }

                    Ok(response)
                }
                _ => Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("forbidden".to_string()))
                    .expect("static refusal response")),
            }
        },
    )
    .await;

    let socket = match accepted {
        Ok(socket) => socket,
        Err(_) => return,
    };
    let (workspace, doc) = match routed.lock().expect("sync route lock").clone() {
        Some(route) => route,
        None => return,
    };

    let id = {
        let mut next = state.next_id.lock().expect("sync id lock");

        *next += 1;
        *next
    };
    let (send, mut receive) = unbounded_channel::<Vec<u8>>();

    state.clients.lock().expect("sync clients lock").insert(id, Client {
        workspace: workspace.clone(),
        doc: doc.clone(),
        send,
    });

    let (mut writer, mut reader) = socket.split();
    let outgoing = tokio::spawn(async move {
        while let Some(frame) = receive.recv().await {
            if writer.send(Message::Binary(frame.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = reader.next().await {
        let frame = match message {
            Message::Binary(bytes) => bytes.to_vec(),
            Message::Close(_) => break,
            _ => continue,
        };

        // Every window, and every other agent on the same document.
        let _ = app.emit("blok:collab-frame", CollabFrame {
            workspace: workspace.clone(),
            doc: doc.clone(),
            frame: frame.clone(),
        });
        state.fan_out(&workspace, &doc, &frame, Some(id));
    }

    state.clients.lock().expect("sync clients lock").remove(&id);
    outgoing.abort();
}

/// Binds loopback on a port the OS picks and starts accepting agents.
pub async fn start(app: tauri::AppHandle) -> Result<SyncEndpoint, String> {
    let listener = TcpListener::bind::<SocketAddr>("127.0.0.1:0".parse().map_err(|_| "bad address")?)
        .await
        .map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let token = mint_token()?;
    let endpoint = SyncEndpoint {
        url: format!("ws://127.0.0.1:{port}/sync"),
        token: token.clone(),
    };

    let state = app.state::<Arc<SyncServer>>().inner().clone();

    *state.endpoint.lock().expect("sync endpoint lock") = Some(endpoint.clone());

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(app.clone(), stream, token.clone()));
        }
    });

    Ok(endpoint)
}

/// Writes the endpoint where an agent can find it.
///
/// The file carries a secret, so it is written inside the app's own data
/// directory rather than anywhere a passer-by would look, and rewritten on every
/// launch: the port and the token both change.
pub fn publish(app: &tauri::AppHandle, endpoint: &SyncEndpoint) {
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };

    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }

    let path = directory.join("sync-endpoint.json");
    let body = format!(
        "{{\"url\":\"{}\",\"token\":\"{}\"}}",
        endpoint.url, endpoint.token
    );

    if std::fs::write(&path, body).is_ok() {
        restrict(&path);
    }
}

/// Keeps the token readable by its owner alone, where the platform allows it.
#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) {}
