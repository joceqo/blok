//! Live handles on the embedding host's own rooms, through a real room
//! manager, journal and engine.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use blok_blokagent::{Cancel, Executor, HostFuture, PageCreateRequest, PageCreator, Rooms};
use blok_collab::BoxFuture;
use blok_collab_convert::{DocConverter, RuntimeHtmlReader};
use blok_collab_docendpoint::{Loaded, Projection};
use blok_collab_journal::{Store, StoreOptions};
use blok_collab_room::{
    Endpoint, Error as RoomError, LocalJournal, Manager, ManagerOptions, WorkingSetStore,
};
use blok_collab_workingset::{Set, Tag};
use blok_jsjson::{Options as JsonOptions, Value as JsValue, parse_node};
use blok_jsruntime::{Options as PoolOptions, Pool};
use blok_mcp::bundle::Bundle;
use blok_mcp::options::{AgentActor, Hooks};
use blok_mcp::server::{Approval, Caller, Mcp, Outcome};
use serde_json::{Value, json};

#[derive(Default)]
struct MemorySets(Mutex<HashMap<String, Set>>);

impl WorkingSetStore for MemorySets {
    fn read<'a>(&'a self, doc_id: &'a str) -> BoxFuture<'a, Result<Option<Set>, RoomError>> {
        let set = self.0.lock().unwrap().get(doc_id).cloned();
        Box::pin(async move { Ok(set) })
    }
    fn write<'a>(
        &'a self,
        doc_id: &'a str,
        updates: &'a [u8],
        tag: &'a Tag,
    ) -> BoxFuture<'a, Result<(), RoomError>> {
        self.0.lock().unwrap().insert(
            doc_id.to_owned(),
            Set {
                updates: updates.to_vec(),
                tag: tag.clone(),
            },
        );
        Box::pin(async { Ok(()) })
    }
    fn reset<'a>(&'a self, doc_id: &'a str, tag: &'a Tag) -> BoxFuture<'a, Result<(), RoomError>> {
        self.write(doc_id, &[], tag)
    }
    fn retire<'a>(&'a self, doc_id: &'a str) -> BoxFuture<'a, Result<(), RoomError>> {
        self.0.lock().unwrap().remove(doc_id);
        Box::pin(async { Ok(()) })
    }
    fn delete<'a>(&'a self, doc_id: &'a str) -> BoxFuture<'a, Result<(), RoomError>> {
        self.retire(doc_id)
    }
}

/// Answers each held document on every load.
#[derive(Default)]
struct HeldDocs(Mutex<HashMap<String, String>>);

impl Endpoint for HeldDocs {
    fn load<'a>(&'a self, doc_id: &'a str) -> BoxFuture<'a, Result<Loaded, RoomError>> {
        let text = self.0.lock().unwrap().get(doc_id).cloned();
        Box::pin(async move {
            let Some(text) = text else {
                return Ok(Loaded::default());
            };
            let data = parse_node(text.as_bytes(), JsonOptions::default())
                .map_err(|err| RoomError::Other(Box::new(err)))?;
            Ok(Loaded {
                data: Some(data),
                version: None,
            })
        })
    }
    fn save<'a>(
        &'a self,
        _: &'a str,
        _: &'a JsValue,
        _: Option<&'a str>,
        _: Option<&'a Projection>,
    ) -> BoxFuture<'a, Result<Option<String>, RoomError>> {
        Box::pin(async { Ok(None) })
    }
}

fn pool() -> Pool {
    Pool::new(PoolOptions {
        pool_size: Some(1),
        ..PoolOptions::default()
    })
    .expect("a pool")
}

async fn mcp_on_rooms(journal_dir: &std::path::Path) -> Mcp {
    mcp_on_rooms_with(journal_dir, Hooks::default(), false).await
}

async fn mcp_on_rooms_with(journal_dir: &std::path::Path, hooks: Hooks, page_titles: bool) -> Mcp {
    mcp_on_rooms_document(
        journal_dir,
        hooks,
        page_titles,
        r#"{"blocks":[{"id":"p1","type":"paragraph","data":{"text":"Hello"}}]}"#,
    )
    .await
}

async fn mcp_on_rooms_document(
    journal_dir: &std::path::Path,
    mut hooks: Hooks,
    page_titles: bool,
    document: &str,
) -> Mcp {
    let docs = Arc::new(HeldDocs::default());
    docs.0
        .lock()
        .unwrap()
        .insert("doc".to_owned(), document.to_owned());
    let journal =
        Store::new(journal_dir.to_path_buf(), StoreOptions::default()).expect("a journal");
    let mut o = ManagerOptions::new(
        Arc::new(MemorySets::default()),
        docs,
        Arc::new(DocConverter {
            now: Box::new(SystemTime::now),
            html: RuntimeHtmlReader { runtime: pool() },
            fields: None,
            log: None,
        }),
    );
    o.operations = Some(Arc::new(LocalJournal(journal)));
    let manager = Manager::new(o);
    let executor = Arc::new(Executor::new_on_runtime(pool(), Some(Rooms::new(manager))));
    let options = json!({ "transport": { "kind": "stdio" }, "auth": { "kind": "none" }, "pageTitles": if page_titles { "page-map" } else { "off" } });
    hooks.rooms = Some(executor);
    Mcp::with_hooks(Arc::new(Bundle::new(1).expect("a bundle")), &options, hooks)
        .await
        .expect("an MCP server")
}

async fn call(mcp: &Mcp, name: &str, args: Value) -> Value {
    let caller = Caller {
        principal: "alice".to_owned(),
        client_name: Some("Desk".to_owned()),
        scopes: None,
    };
    match mcp
        .call(name, &args, &caller, &Approval::default(), &|| false)
        .await
    {
        Ok(Outcome::Answer(answer)) => serde_json::from_str(&answer.structured).unwrap(),
        Ok(other) => panic!("{name}: {other:?}"),
        Err(err) => panic!("{name}: {err}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_handle_writes_to_the_hosts_room_and_reads_it_back() {
    let dir = std::env::temp_dir().join(format!("blok-mcp-rooms-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mcp = mcp_on_rooms(&dir).await;

    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    assert_eq!(opened["mode"], "live", "{opened}");
    assert_eq!(opened["durability"], "acknowledged");
    assert_eq!(opened["contractRevision"], mcp.surface.live_revision);
    let handle = opened["handle"].as_str().unwrap().to_owned();

    let ran = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [{ "name": "doc.setTitle", "args": { "title": "Plan" } }] }),
    )
    .await;
    assert_eq!(ran["ok"], true, "{ran}");
    assert_eq!(ran["delivery"]["durable"], true);
    assert!(ran["delivery"]["serverSequence"].is_u64(), "{ran}");

    let read = call(&mcp, "blok_read", json!({ "handle": handle })).await;
    assert_eq!(read["page"]["title"], "Plan", "{read}");

    let closed = call(&mcp, "blok_close", json!({ "handle": handle })).await;
    assert_eq!(
        closed,
        json!({ "closed": true, "unsavedBatches": 0, "hostRecordLags": true })
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_only_live_handle_refuses_writes_with_nodes_live_message() {
    let dir = std::env::temp_dir().join(format!("blok-mcp-rooms-ro-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mcp = mcp_on_rooms(&dir).await;

    let opened = call(&mcp, "blok_open", json!({ "documentId": "doc" })).await;
    let handle = opened["handle"].as_str().unwrap().to_owned();
    let refused = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [{ "name": "doc.setTitle", "args": { "title": "T" } }] }),
    )
    .await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["error"]["code"], "READ_ONLY");
    assert_eq!(
        refused["error"]["message"],
        "This handle cannot write to the room."
    );
    let read = call(&mcp, "blok_read", json!({ "handle": handle })).await;
    assert!(read["page"].get("title").is_none(), "{read}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_unlock_on_the_hosts_room_asks_the_person() {
    let dir = std::env::temp_dir().join(format!("blok-mcp-rooms-ask-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mcp = mcp_on_rooms(&dir).await;
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let handle = opened["handle"].as_str().unwrap().to_owned();
    let locked = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [{ "name": "block.insert", "args": { "type": "database", "id": "db", "data": {
            "title": "Payroll", "activeViewId": "v",
            "schema": [{ "id": "t", "name": "Name", "type": "title", "position": "a0" }],
            "views": [{ "id": "v", "name": "Table", "type": "table", "position": "a0", "sorts": [], "filters": [], "visibleProperties": [] }],
        } } }, { "name": "database.setLock", "args": { "id": "db", "locked": true } }] }),
    )
    .await;
    assert_eq!(locked["ok"], true, "{locked}");

    let caller = Caller {
        principal: "alice".to_owned(),
        client_name: Some("Desk".to_owned()),
        scopes: None,
    };
    let asking = Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: None,
    };
    let unlock = json!({ "handle": handle, "commands": [{ "name": "database.setLock", "args": { "id": "db", "locked": false } }] });
    match mcp
        .call("blok_execute", &unlock, &caller, &asking, &|| false)
        .await
    {
        Ok(Outcome::Ask(ask)) => assert_eq!(ask.key, r#"["database.unlock","db","Payroll"]"#),
        other => panic!("expected a question, got {other:?}"),
    }
    let yes = Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: Some(
            json!({ r#"["database.unlock","db","Payroll"]"#: { "action": "accept", "content": { "unlock": true } } }),
        ),
    };
    match mcp
        .call("blok_execute", &unlock, &caller, &yes, &|| false)
        .await
    {
        Ok(Outcome::Answer(answer)) => assert!(!answer.is_error, "{}", answer.structured),
        other => panic!("expected the unlock to apply, got {other:?}"),
    }
    // Unlocked now, so the same call no longer needs a yes.
    match mcp
        .call("blok_execute", &unlock, &caller, &asking, &|| false)
        .await
    {
        Ok(Outcome::Answer(answer)) => assert!(!answer.is_error, "{}", answer.structured),
        other => panic!("expected no question once unlocked, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn undoing_a_lock_in_the_hosts_room_asks_and_a_yes_unlocks() {
    let dir = std::env::temp_dir().join(format!("blok-mcp-rooms-undo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mcp = mcp_on_rooms(&dir).await;
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let handle = opened["handle"].as_str().unwrap().to_owned();
    let inserted = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [{ "name": "block.insert", "args": { "type": "database", "id": "db", "data": {
            "title": "Payroll", "activeViewId": "v",
            "schema": [{ "id": "t", "name": "Name", "type": "title", "position": "a0" }],
            "views": [{ "id": "v", "name": "Table", "type": "table", "position": "a0", "sorts": [], "filters": [], "visibleProperties": [] }],
        } } }] }),
    )
    .await;
    assert_eq!(inserted["ok"], true, "{inserted}");
    let locked = call(&mcp, "blok_execute", json!({ "handle": handle, "commands": [{ "name": "database.setLock", "args": { "id": "db", "locked": true } }] })).await;
    assert_eq!(locked["ok"], true, "{locked}");

    let caller = Caller {
        principal: "alice".to_owned(),
        client_name: Some("Desk".to_owned()),
        scopes: None,
    };
    let undo = json!({ "handle": handle, "commands": [{ "name": "history.undo", "args": {} }] });
    let key = r#"["database.unlock","db","Payroll"]"#;
    let asking = Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: None,
    };
    match mcp
        .call("blok_execute", &undo, &caller, &asking, &|| false)
        .await
    {
        Ok(Outcome::Ask(ask)) => assert_eq!(ask.key, key),
        other => panic!("expected a question, got {other:?}"),
    }
    let no = Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: Some(json!({ key: { "action": "decline" } })),
    };
    match mcp
        .call("blok_execute", &undo, &caller, &no, &|| false)
        .await
    {
        Ok(Outcome::Answer(answer)) => {
            let result: Value = serde_json::from_str(&answer.structured).unwrap();
            assert_eq!(result["error"]["details"]["reason"], "denied", "{result}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    let yes = Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: Some(json!({ key: { "action": "accept", "content": { "unlock": true } } })),
    };
    match mcp
        .call("blok_execute", &undo, &caller, &yes, &|| false)
        .await
    {
        Ok(Outcome::Answer(answer)) => assert!(!answer.is_error, "{}", answer.structured),
        other => panic!("expected the undo to apply, got {other:?}"),
    }
    // Unlocked now: a plain unlock needs no yes.
    let unlock = call(&mcp, "blok_execute", json!({ "handle": handle, "commands": [{ "name": "database.setLock", "args": { "id": "db", "locked": false } }] })).await;
    assert_eq!(unlock["ok"], true, "{unlock}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn undoing_a_sharing_change_in_the_hosts_room_asks_and_a_yes_applies() {
    let dir = std::env::temp_dir().join(format!("blok-mcp-rooms-share-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mcp = mcp_on_rooms(&dir).await;
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let handle = opened["handle"].as_str().unwrap().to_owned();
    let inserted = call(&mcp, "blok_execute", json!({ "handle": handle, "commands": [{ "name": "block.insert", "args": { "type": "database", "id": "db", "data": {
        "title": "Signup", "activeViewId": "v1",
        "schema": [{ "id": "t", "name": "Name", "type": "title", "position": "a0" }],
        "views": [{ "id": "v1", "name": "Form", "type": "form", "position": "a0", "sorts": [], "filters": [], "visibleProperties": [], "form": {} }],
    } } }] })).await;
    assert_eq!(inserted["ok"], true, "{inserted}");
    let caller = Caller {
        principal: "alice".to_owned(),
        client_name: Some("Desk".to_owned()),
        scopes: None,
    };
    let reply = |key: &str, yes: bool| Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: Some(if yes {
            json!({ key: { "action": "accept", "content": { "share": true } } })
        } else {
            json!({ key: { "action": "decline" } })
        }),
    };
    let asking = Approval {
        capabilities: json!({ "elicitation": {} }),
        replies: None,
    };
    let asked = |outcome: Result<Outcome, _>| match outcome {
        Ok(Outcome::Ask(ask)) => ask.key,
        other => panic!("expected a question, got {other:?}"),
    };
    let form_of = |read: &Value| {
        let blocks = read["blocks"].as_array().cloned().unwrap_or_default();
        let db = blocks
            .into_iter()
            .find(|b| b["id"] == "db")
            .unwrap_or(Value::Null);
        db["data"]["views"][0]["form"].clone()
    };
    let close = json!({ "handle": handle, "commands": [{ "name": "database.updateView", "args": { "id": "db", "viewId": "v1", "changes": { "form": { "closed": true } } } }] });
    let key = asked(
        mcp.call("blok_execute", &close, &caller, &asking, &|| false)
            .await,
    );
    let closed = mcp
        .call("blok_execute", &close, &caller, &reply(&key, true), &|| {
            false
        })
        .await;
    assert!(
        matches!(closed, Ok(Outcome::Answer(ref a)) if !a.is_error),
        "{closed:?}"
    );

    let undo = json!({ "handle": handle, "commands": [{ "name": "history.undo", "args": {} }] });
    let key = asked(
        mcp.call("blok_execute", &undo, &caller, &asking, &|| false)
            .await,
    );
    match mcp
        .call("blok_execute", &undo, &caller, &reply(&key, false), &|| {
            false
        })
        .await
    {
        Ok(Outcome::Answer(answer)) => {
            let result: Value = serde_json::from_str(&answer.structured).unwrap();
            assert_eq!(result["error"]["details"]["reason"], "denied", "{result}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    let read = call(
        &mcp,
        "blok_read",
        json!({ "handle": handle, "detail": "full" }),
    )
    .await;
    assert_eq!(form_of(&read), json!({ "closed": true }), "{read}");
    match mcp
        .call("blok_execute", &undo, &caller, &reply(&key, true), &|| {
            false
        })
        .await
    {
        Ok(Outcome::Answer(answer)) => assert!(!answer.is_error, "{}", answer.structured),
        other => panic!("expected the undo to apply, got {other:?}"),
    }
    let read = call(
        &mcp,
        "blok_read",
        json!({ "handle": handle, "detail": "full" }),
    )
    .await;
    assert_eq!(form_of(&read), json!({}), "{read}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[derive(Default)]
struct PageHost {
    asked: Mutex<Vec<PageCreateRequest>>,
    refuse_after: Option<usize>,
}

impl PageCreator for PageHost {
    fn create<'a>(
        &'a self,
        _: &'a Cancel,
        request: &'a PageCreateRequest,
    ) -> HostFuture<'a, Option<String>> {
        let mut asked = self.asked.lock().unwrap();
        asked.push(request.clone());
        let at = asked.len();
        let answer = if self.refuse_after.is_some_and(|limit| at > limit) {
            None
        } else {
            Some(format!("child-{at}"))
        };
        Box::pin(async move { Ok(answer) })
    }
}

fn page_insert(id: &str) -> Value {
    json!({ "name": "block.insert", "args": { "type": "page", "id": id, "position": "end" } })
}

#[tokio::test(flavor = "multi_thread")]
async fn room_page_creator_uses_the_principal_and_targets_authorized_child_rooms() {
    let dir = TestDir::new();
    let host = Arc::new(PageHost::default());
    let checks = Arc::new(Mutex::new(Vec::new()));
    let seen = checks.clone();
    let hooks = Hooks {
        page_creator: Some(host.clone()),
        authorize: Some(Arc::new(
            move |principal: String, id: String, write: bool| {
                seen.lock().unwrap().push((principal, id, write));
                async { true }
            },
        )),
        agent_actor: Some(Arc::new(|_, _| AgentActor {
            id: "custom-agent".into(),
            name: "Agent".into(),
            on_behalf_of: Some("not-the-principal".into()),
            color: None,
        })),
        ..Hooks::default()
    };
    let mcp = mcp_on_rooms_document(dir.path(), hooks, true,
        r#"{"blocks":[{"id":"db","type":"database","content":["row"],"data":{"title":"Sprints","schema":[],"views":[]}},{"id":"row","type":"database-row","parent":"db","content":[],"data":{"properties":{}}}]}"#).await;
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let handle = opened["handle"].clone();
    let description = call(
        &mcp,
        "blok_describe",
        json!({ "handle": handle, "tool": "page" }),
    )
    .await;
    assert_ne!(description["tool"]["insertable"], false, "{description}");
    let mut insert = page_insert("link");
    insert["args"]["parentId"] = json!("row");
    let made = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [insert] }),
    )
    .await;
    assert_eq!(made["ok"], true, "{made}");
    let asked = host.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].principal.as_deref(), Some("alice"));
    assert_eq!(asked[0].parent_document_id.as_deref(), Some("doc"));
    assert_eq!(asked[0].actor.id, "custom-agent");
    assert!(!asked[0].suggested_page_id.is_empty());
    let read = call(
        &mcp,
        "blok_read",
        json!({ "handle": handle, "detail": "full" }),
    )
    .await;
    assert!(
        read["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["id"] == "link" && b["data"]["pageId"] == "child-1"),
        "{read}"
    );
    for command in [
        json!({ "name": "page.rename", "args": { "id": "link", "title": "Commits" } }),
        json!({ "name": "page.setIcon", "args": { "id": "link", "icon": { "type": "emoji", "value": "📄" } } }),
    ] {
        let result = call(
            &mcp,
            "blok_execute",
            json!({ "handle": handle, "commands": [command] }),
        )
        .await;
        assert_eq!(result["ok"], true, "{result}");
    }
    let child = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "child-1", "view": { "detail": "full" } }),
    )
    .await;
    let child = call(&mcp, "blok_read", json!({ "handle": child["handle"] })).await;
    assert_eq!(child["page"]["title"], "Commits", "{child}");
    assert_eq!(
        child["page"]["icon"],
        json!({ "type": "emoji", "value": "📄" }),
        "{child}"
    );
    assert_eq!(
        checks
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, id, w)| p == "alice" && id == "child-1" && *w)
            .count(),
        2
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn room_page_creation_refuses_read_only_and_reports_orphaned_pages() {
    let dir = TestDir::new();
    let host = Arc::new(PageHost {
        refuse_after: Some(1),
        ..PageHost::default()
    });
    let mcp = mcp_on_rooms_with(
        dir.path(),
        Hooks {
            page_creator: Some(host.clone()),
            ..Hooks::default()
        },
        true,
    )
    .await;
    let opened = call(&mcp, "blok_open", json!({ "documentId": "doc" })).await;
    let denied = call(
        &mcp,
        "blok_execute",
        json!({ "handle": opened["handle"], "commands": [page_insert("readonly")] }),
    )
    .await;
    assert_eq!(denied["error"]["code"], "READ_ONLY", "{denied}");
    assert!(host.asked.lock().unwrap().is_empty());
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let handle = opened["handle"].clone();
    let orphan = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [page_insert("one"), page_insert("two")] }),
    )
    .await;
    assert_eq!(orphan["error"]["code"], "ORPHANED_SIDE_EFFECT", "{orphan}");
    assert_eq!(
        orphan["error"]["details"]["orphaned"][0]["prepared"]["pageId"], "child-1",
        "{orphan}"
    );
    let denied = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [page_insert("three")] }),
    )
    .await;
    assert_eq!(denied["error"]["code"], "FORBIDDEN", "{denied}");
    let read = call(
        &mcp,
        "blok_read",
        json!({ "handle": handle, "detail": "full" }),
    )
    .await;
    assert_eq!(read["blocks"].as_array().unwrap().len(), 1, "{read}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rooms_without_a_host_creator_do_not_advertise_page_creation() {
    let dir = TestDir::new();
    let mcp = mcp_on_rooms_with(dir.path(), Hooks::default(), true).await;
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let description = call(
        &mcp,
        "blok_describe",
        json!({ "handle": opened["handle"], "tool": "page" }),
    )
    .await;
    assert_eq!(description["tool"]["insertable"], false, "{description}");
    let result = call(
        &mcp,
        "blok_execute",
        json!({ "handle": opened["handle"], "commands": [page_insert("page")] }),
    )
    .await;
    assert_eq!(result["ok"], false, "{result}");
    let read = call(
        &mcp,
        "blok_read",
        json!({ "handle": opened["handle"], "detail": "full" }),
    )
    .await;
    assert_eq!(read["blocks"].as_array().unwrap().len(), 1, "{read}");
}

struct TestDir(std::path::PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "blok-mcp-room-pages-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn room_page_target_refuses_an_inaccessible_child_without_mutation() {
    let dir = TestDir::new();
    let host = Arc::new(PageHost::default());
    let mcp = mcp_on_rooms_with(
        dir.path(),
        Hooks {
            page_creator: Some(host),
            authorize: Some(Arc::new(
                |principal: String, id: String, write: bool| async move {
                    principal == "alice" && (id == "doc" || !write)
                },
            )),
            ..Hooks::default()
        },
        true,
    )
    .await;
    let opened = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    let handle = opened["handle"].clone();
    let made = call(
        &mcp,
        "blok_execute",
        json!({ "handle": handle, "commands": [page_insert("link")] }),
    )
    .await;
    assert_eq!(made["ok"], true, "{made}");
    let denied = call(&mcp, "blok_execute", json!({ "handle": handle, "commands": [{ "name": "page.rename", "args": { "id": "link", "title": "Secret" } }] })).await;
    assert_eq!(denied["error"]["code"], "FORBIDDEN", "{denied}");
    let child = call(&mcp, "blok_open", json!({ "documentId": "child-1" })).await;
    let read = call(&mcp, "blok_read", json!({ "handle": child["handle"] })).await;
    assert!(read["page"].get("title").is_none(), "{read}");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_parent_denies_before_the_host_creator_runs() {
    let dir = TestDir::new();
    let host = Arc::new(PageHost::default());
    let mcp = mcp_on_rooms_with(
        dir.path(),
        Hooks {
            page_creator: Some(host.clone()),
            authorize: Some(Arc::new(|_: String, _: String, write: bool| async move {
                !write
            })),
            ..Hooks::default()
        },
        true,
    )
    .await;
    let denied = call(
        &mcp,
        "blok_open",
        json!({ "documentId": "doc", "write": true }),
    )
    .await;
    assert_eq!(denied["error"]["code"], "FORBIDDEN", "{denied}");
    assert!(host.asked.lock().unwrap().is_empty());
}

struct BrokenPageHost(bool);
impl PageCreator for BrokenPageHost {
    fn create<'a>(
        &'a self,
        _: &'a Cancel,
        _: &'a PageCreateRequest,
    ) -> HostFuture<'a, Option<String>> {
        Box::pin(async move {
            if self.0 {
                Ok(Some("..".into()))
            } else {
                Err(blok_blokagent::Error::Host("secret host failure".into()))
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn room_page_creation_sanitizes_host_errors_and_rejects_invalid_ids() {
    for invalid_id in [false, true] {
        let dir = TestDir::new();
        let mcp = mcp_on_rooms_with(
            dir.path(),
            Hooks {
                page_creator: Some(Arc::new(BrokenPageHost(invalid_id))),
                ..Hooks::default()
            },
            true,
        )
        .await;
        let opened = call(
            &mcp,
            "blok_open",
            json!({ "documentId": "doc", "write": true }),
        )
        .await;
        let result = call(
            &mcp,
            "blok_execute",
            json!({ "handle": opened["handle"], "commands": [page_insert("link")] }),
        )
        .await;
        assert_eq!(result["error"]["code"], "SOURCE_UNAVAILABLE", "{result}");
        assert!(!result.to_string().contains("secret"), "{result}");
        let read = call(
            &mcp,
            "blok_read",
            json!({ "handle": opened["handle"], "detail": "full" }),
        )
        .await;
        assert_eq!(read["blocks"].as_array().unwrap().len(), 1, "{read}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn room_page_creator_requires_page_map_and_an_unambiguous_room_owner() {
    for extra in [
        json!({ "pageTitles": "off" }),
        json!({ "sync": { "url": "ws://127.0.0.1:9/sync" } }),
        json!({ "source": { "kind": "files", "dir": "/tmp/unused-room-page-source" } }),
    ] {
        let mut options = json!({ "transport": { "kind": "stdio" }, "auth": { "kind": "none" }, "pageTitles": "page-map" });
        options
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let hooks = Hooks {
            rooms: Some(Arc::new(Executor::new_on_runtime(pool(), None))),
            page_creator: Some(Arc::new(PageHost::default())),
            ..Hooks::default()
        };
        let result = Mcp::build(Arc::new(Bundle::new(1).unwrap()), &options, hooks).await;
        assert!(
            matches!(result, Err(blok_mcp::server::BuildError::Config(_))),
            "invalid room options must be rejected: {options}"
        );
    }
}
