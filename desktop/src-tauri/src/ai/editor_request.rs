use super::{MAX_OUTPUT_TOKENS, text_model};
use serde_json::{Value, json};

const MAX_REQUEST_BYTES: usize = 512 * 1024;
const INVALID: &str = "Le format de la demande d’édition n’est pas valide.";

fn tool_name(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("blok_read" | "blok_describe" | "blok_execute")
    )
}

fn text_part(part: &Value) -> bool {
    match part["type"].as_str() {
        Some("input_text" | "output_text") => part["text"].is_string(),
        Some("refusal") => part["refusal"].is_string(),
        _ => false,
    }
}

fn editor_item(item: &Value) -> bool {
    match item["type"].as_str() {
        None | Some("message") => {
            matches!(item["role"].as_str(), Some("user" | "assistant"))
                && (item["content"].is_string()
                    || item["content"]
                        .as_array()
                        .is_some_and(|parts| parts.iter().all(text_part)))
        }
        Some("function_call") => {
            tool_name(&item["name"]) && item["call_id"].is_string() && item["arguments"].is_string()
        }
        Some("function_call_output") => item["call_id"].is_string() && item["output"].is_string(),
        Some("reasoning") => item["encrypted_content"].is_string(),
        _ => false,
    }
}

/// Only forward text and editor function calls. The host owns provider options and credentials.
pub(super) fn body(request: &Value) -> Result<Value, String> {
    if serde_json::to_vec(request).map_err(|_| INVALID)?.len() > MAX_REQUEST_BYTES {
        return Err("Le contexte de l’éditeur dépasse la taille autorisée.".into());
    }
    let model = request["model"]
        .as_str()
        .filter(|value| text_model(value))
        .ok_or(INVALID)?;
    let system = request["instructions"].as_str().ok_or(INVALID)?;
    let input = request["input"].as_array().ok_or(INVALID)?;
    let tools = request["tools"].as_array().ok_or(INVALID)?;
    if input.is_empty()
        || input.len() > 256
        || !input.iter().all(editor_item)
        || tools.is_empty()
        || tools.len() > 3
        || !tools.iter().all(|tool| {
            tool["type"] == "function" && tool_name(&tool["name"]) && tool["parameters"].is_object()
        })
    {
        return Err(INVALID.into());
    }
    Ok(json!({
        "model": model, "instructions": system, "input": input, "tools": tools,
        "store": false, "stream": false, "max_output_tokens": MAX_OUTPUT_TOKENS,
        "include": ["reasoning.encrypted_content"]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        json!({"model":"gpt-example","instructions":"Réponds","tools":[
          {"type":"function","name":"blok_execute","parameters":{"type":"object"},"strict":false}],
          "input":[{"role":"user","content":"Modifie ce bloc"},
            {"type":"function_call","call_id":"call-1","name":"blok_execute","arguments":"{}"},
            {"type":"function_call_output","call_id":"call-1","output":"ok"}]})
    }
    #[test]
    fn forwards_the_editor_turn_with_host_owned_limits() {
        let mut req = request();
        req["store"] = json!(true);
        req["max_output_tokens"] = json!(900000);
        let out = body(&req).unwrap();
        assert_eq!(out["input"], req["input"]);
        assert_eq!(out["tools"], req["tools"]);
        assert_eq!(out["store"], false);
        assert_eq!(out["max_output_tokens"], MAX_OUTPUT_TOKENS);
    }
    #[test]
    fn refuses_other_tools_and_file_references() {
        let mut req = request();
        req["tools"][0]["type"] = json!("web_search");
        assert!(body(&req).is_err());
        let mut req = request();
        req["input"][0]["content"] = json!([{"type":"input_file","file_id":"f"}]);
        assert!(body(&req).is_err());
        let mut req = request();
        req["input"][0]["content"] = json!("x".repeat(MAX_REQUEST_BYTES));
        assert!(body(&req).is_err());
    }
}
