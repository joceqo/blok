//! Live handles on rooms in this process, for a host that embeds blok-mcp
//! next to its own Blok collab server (`Server::agent_executor()`). No
//! ticket and no socket: batches run through `Executor::execute_in_room`.

use std::sync::Arc;

use blok_blokagent::{
    Actor, Cancel, Error, Executor, HostFuture, Options, PageCreateRequest, PageCreator,
    PageLocation, PageTarget,
};
use serde_json::{Value, json};

use crate::errors::{Fault, HostError};
use crate::options::Authorize;

pub struct Rooms {
    executor: Arc<Executor>,
    options: Options,
    flags: Value,
    page_creator: Option<Arc<dyn PageCreator>>,
    authorize: Option<Arc<dyn Authorize>>,
}

/// What one room batch gave.
#[derive(Debug, Clone)]
pub struct Ran {
    /// The AgentResult as JSON text.
    pub result: String,
    /// The journal head "lineage:sequence", when the room keeps a journal.
    pub head: Option<(String, u64)>,
}

/// A journal head "lineage:sequence"; a room without a journal has none.
pub fn parse_head(revision: &str) -> Option<(String, u64)> {
    let (lineage, sequence) = revision.rsplit_once(':')?;
    let sequence = sequence.parse().ok()?;
    (!lineage.is_empty()).then(|| (lineage.to_owned(), sequence))
}

/// The actor JSON mcpActor gives, as the executor takes it.
pub fn actor_of(actor: &Value) -> Actor {
    let text = |key: &str| actor.get(key).and_then(Value::as_str).map(str::to_owned);
    Actor {
        id: text("id").unwrap_or_default(),
        name: text("name").unwrap_or_default(),
        on_behalf_of: text("onBehalfOf"),
    }
}

fn opt_text(value: Option<&Value>) -> Option<String> {
    value.filter(|v| !v.is_null()).map(Value::to_string)
}

impl Rooms {
    /// `flags` are the start flags mcpSurface took: the room contract gets
    /// the same custom tools, overrides and comment switch.
    pub fn new(executor: Arc<Executor>, flags: &Value) -> Rooms {
        Self::with_hooks(executor, flags, None, None)
    }

    pub(crate) fn with_hooks(
        executor: Arc<Executor>,
        flags: &Value,
        page_creator: Option<Arc<dyn PageCreator>>,
        authorize: Option<Arc<dyn Authorize>>,
    ) -> Rooms {
        let mut flags = flags.clone();
        // This override affects live contracts only, including mixed hosts.
        flags["liveCreatesPages"] = json!(page_creator.is_some());
        Rooms {
            executor,
            options: Options {
                custom_tools_json: opt_text(flags.get("manifest")),
                overrides_json: opt_text(flags.get("overrides")),
                disable_built_in_comments: flags.get("comments") == Some(&Value::Bool(false)),
                ..Options::default()
            },
            flags: flags.clone(),
            page_creator,
            authorize,
        }
    }

    /// The bundle gets the handle's own mcp input, so a room batch meets
    /// the contract blok_describe shows, and `approval` lets it ask.
    pub async fn run(
        &self,
        document_id: &str,
        batch: &Value,
        actor: &Value,
        write: bool,
        approval: Option<&Value>,
    ) -> Result<Ran, Fault> {
        self.run_as(document_id, batch, actor, write, approval, "")
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_as(
        &self,
        document_id: &str,
        batch: &Value,
        actor: &Value,
        write: bool,
        approval: Option<&Value>,
        principal: &str,
    ) -> Result<Ran, Fault> {
        let mut mcp = self.flags.clone();
        mcp["mode"] = json!("live");
        mcp["write"] = json!(write);
        let page_titles = self.flags.get("pageTitles").and_then(Value::as_str) == Some("page-map");
        let options = Options {
            page_titles,
            // The native executor prepares pages before its final write gate.
            // Keep host side effects unavailable even to direct read-only runs.
            page_target: (page_titles && write).then(|| {
                Arc::new(RoomPages {
                    creator: self.page_creator.clone(),
                    authorize: self.authorize.clone(),
                    principal: principal.to_owned(),
                    parent: document_id.to_owned(),
                }) as Arc<dyn PageTarget>
            }),
            mcp_json: Some(mcp.to_string()),
            approval_json: approval.map(Value::to_string),
            ..self.options.clone()
        };
        let execution = self
            .executor
            .execute_in_room(
                &Cancel::new(),
                document_id,
                &batch.to_string(),
                &actor_of(actor),
                Some(&options),
            )
            .await
            .map_err(|err| match err {
                Error::Host(ref host) if host.is::<RoomPageError>() => {
                    match host.downcast_ref::<RoomPageError>().expect("checked above") {
                        RoomPageError::Failed => HostError::surface(
                            "SOURCE_UNAVAILABLE",
                            crate::create_page::HOST_PAGE_FAILED,
                        )
                        .into(),
                        RoomPageError::Forbidden => {
                            HostError::surface("FORBIDDEN", "You may not write this page document.")
                                .into()
                        }
                    }
                }
                err if err.is_cancel() => {
                    HostError::failure("CANCELLED", crate::create_page::CANCELLED).into()
                }
                err => Fault::Internal(format!("{err:?}")),
            })?;
        Ok(Ran {
            head: parse_head(&execution.revision),
            result: execution.result_json,
        })
    }

    /// `blok_read` as a one-command batch: `{ ok, results: [view] }`.
    pub async fn read(
        &self,
        document_id: &str,
        view: &Value,
        actor: &Value,
        write: bool,
    ) -> Result<(Value, Ran), Fault> {
        self.read_as(document_id, view, actor, write, "").await
    }

    pub(crate) async fn read_as(
        &self,
        document_id: &str,
        view: &Value,
        actor: &Value,
        write: bool,
        principal: &str,
    ) -> Result<(Value, Ran), Fault> {
        let batch = json!({ "commands": [{ "name": "doc.read", "args": view }] });
        let ran = self
            .run_as(document_id, &batch, actor, write, None, principal)
            .await?;
        let result: Value =
            serde_json::from_str(&ran.result).map_err(|e| Fault::Internal(e.to_string()))?;
        if result.get("ok") != Some(&Value::Bool(true)) {
            let error = result.get("error").cloned().unwrap_or(Value::Null);
            return Err(HostError::as_is(error).into());
        }
        let view = result.pointer("/results/0").cloned().unwrap_or(Value::Null);
        Ok((view, ran))
    }
}

/// A room page target is scoped to the authenticated call, never the agent's
/// attribution. Creation stays entirely in the embedding host's hands.
struct RoomPages {
    creator: Option<Arc<dyn PageCreator>>,
    authorize: Option<Arc<dyn Authorize>>,
    principal: String,
    parent: String,
}

#[derive(Debug)]
enum RoomPageError {
    Failed,
    Forbidden,
}
impl std::fmt::Display for RoomPageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Failed => crate::create_page::HOST_PAGE_FAILED,
            Self::Forbidden => "You may not write this page document.",
        })
    }
}
impl std::error::Error for RoomPageError {}

impl PageTarget for RoomPages {
    fn resolve<'a>(
        &'a self,
        cancel: &'a Cancel,
        page_id: &'a str,
        _: &'a Actor,
    ) -> HostFuture<'a, Option<PageLocation>> {
        Box::pin(async move {
            cancel.check()?;
            if !crate::create_page::is_page_id(page_id) {
                return Err(Error::Host(Box::new(RoomPageError::Forbidden)));
            }
            if let Some(authorize) = &self.authorize {
                if !authorize
                    .allows(self.principal.clone(), page_id.to_owned(), true)
                    .await
                {
                    return Err(Error::Host(Box::new(RoomPageError::Forbidden)));
                }
            }
            Ok(Some(PageLocation::Room {
                doc_id: page_id.to_owned(),
            }))
        })
    }

    fn as_creator(&self) -> Option<&dyn PageCreator> {
        self.creator.as_ref().map(|_| self as &dyn PageCreator)
    }
}

impl PageCreator for RoomPages {
    fn create<'a>(
        &'a self,
        cancel: &'a Cancel,
        request: &'a PageCreateRequest,
    ) -> HostFuture<'a, Option<String>> {
        Box::pin(async move {
            let Some(creator) = &self.creator else {
                return Ok(None);
            };
            let mut request = request.clone();
            request.principal = Some(self.principal.clone());
            request.parent_document_id = Some(self.parent.clone());
            match creator.create(cancel, &request).await {
                Ok(None) => Ok(None),
                Ok(Some(page_id)) if crate::create_page::is_page_id(&page_id) => Ok(Some(page_id)),
                Ok(Some(page_id)) => {
                    eprintln!(
                        "blok-mcp: the host page creator answered no valid page id: {page_id:?}"
                    );
                    Err(Error::Host(Box::new(RoomPageError::Failed)))
                }
                Err(err) if err.is_cancel() => Err(err),
                Err(err) => {
                    eprintln!("blok-mcp: the host could not create a page: {err}");
                    Err(Error::Host(Box::new(RoomPageError::Failed)))
                }
            }
        })
    }
}

/// A live handle on an in-process room.
pub struct RoomSession {
    pub write: bool,
    /// Latched after APPLY_FAILED, as Node's live session does.
    pub read_only: bool,
    /// The room keeps a journal: writes are acknowledged with a sequence.
    pub journaled: bool,
}

/// What a room batch delivered, as Node's live session reports it.
pub fn delivery(ran: &Ran, ok: bool, writes: bool, journaled: bool) -> Option<Value> {
    if !ok || !writes || !journaled {
        return None;
    }
    Some(json!({
        "durable": true,
        "pending": false,
        "serverSequence": ran.head.as_ref().map(|(_, sequence)| *sequence),
        "savedVersion": null,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_journal_head() {
        assert_eq!(parse_head("abc:12"), Some(("abc".to_owned(), 12)));
        assert_eq!(parse_head("a:b:3"), Some(("a:b".to_owned(), 3)));
        assert_eq!(parse_head("h18aeb1425ab3a4"), None);
        assert_eq!(parse_head(":3"), None);
    }

    #[test]
    fn only_an_acknowledged_write_has_a_delivery() {
        let ran = Ran {
            result: String::new(),
            head: Some(("l".to_owned(), 4)),
        };
        assert_eq!(
            delivery(&ran, true, true, true),
            Some(
                json!({ "durable": true, "pending": false, "serverSequence": 4, "savedVersion": null })
            )
        );
        assert_eq!(delivery(&ran, true, false, true), None);
        assert_eq!(delivery(&ran, false, true, true), None);
        assert_eq!(delivery(&ran, true, true, false), None);
    }

    #[test]
    fn takes_the_actor_mcp_actor_gives() {
        let actor = actor_of(
            &json!({ "id": "agent:a:c", "name": "c (for a)", "kind": "agent", "onBehalfOf": "a" }),
        );
        assert_eq!(actor.id, "agent:a:c");
        assert_eq!(actor.on_behalf_of.as_deref(), Some("a"));
    }
}
