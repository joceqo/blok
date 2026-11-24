package cloud

import (
	"encoding/json"
	"net/http"
	"slices"
)

const aiEditorMaxBytes = 512 << 10

func aiKeys(obj map[string]any, allowed ...string) bool {
	for key := range obj {
		if !slices.Contains(allowed, key) {
			return false
		}
	}
	return true
}

func aiText(v any) string {
	text, _ := v.(string)
	return text
}

func editorFunction(name any) bool {
	switch name {
	case "blok_read", "blok_describe", "blok_execute":
		return true
	}
	return false
}

// The adapter carries the provider's typed assistant history between stateless
// calls. A new request must carry the content; a server-side reference is insufficient.
func editorItem(item map[string]any, reply bool) bool {
	kind := aiText(item["type"])
	if value, present := item["type"]; present && (kind == "" || value != kind) {
		return false
	}
	switch kind {
	case "", "message":
		if !aiKeys(item, "type", "id", "status", "phase", "role", "content") ||
			(item["role"] != "assistant" && (reply || item["role"] != "user")) {
			return false
		}
		if _, ok := item["content"].(string); ok {
			return true
		}
		parts, ok := item["content"].([]any)
		if !ok || len(parts) == 0 {
			return false
		}
		for _, part := range parts {
			p, _ := part.(map[string]any)
			switch aiText(p["type"]) {
			case "input_text", "output_text":
				if _, ok := p["text"].(string); !ok || !aiKeys(p, "type", "text", "annotations", "logprobs") {
					return false
				}
			case "refusal":
				if _, ok := p["refusal"].(string); !ok || !aiKeys(p, "type", "refusal") {
					return false
				}
			default:
				return false
			}
		}
		return true
	case "function_call":
		_, args := item["arguments"].(string)
		return args && editorFunction(item["name"]) && aiText(item["call_id"]) != "" &&
			aiKeys(item, "type", "call_id", "name", "arguments", "id", "status")
	case "function_call_output":
		_, output := item["output"].(string)
		return !reply && output && aiText(item["call_id"]) != "" && aiKeys(item, "type", "call_id", "output", "id", "status")
	case "reasoning":
		if !aiKeys(item, "type", "id", "encrypted_content", "summary", "content", "status") {
			return false
		}
		// Require a self-contained item rather than an ID-only reference.
		if item["encrypted_content"] == nil && item["summary"] == nil && item["content"] == nil {
			return false
		}
		if value := item["encrypted_content"]; value != nil {
			if _, ok := value.(string); !ok {
				return false
			}
		}
		for key, typ := range map[string]string{"summary": "summary_text", "content": "reasoning_text"} {
			if value := item[key]; value != nil {
				parts, ok := value.([]any)
				if !ok {
					return false
				}
				for _, part := range parts {
					p, _ := part.(map[string]any)
					if _, ok := p["text"].(string); !ok || p["type"] != typ || !aiKeys(p, "type", "text") {
						return false
					}
				}
			}
		}
		return true
	}
	return false
}

func validEditorRequest(in map[string]any) bool {
	if !aiKeys(in, "model", "instructions", "input", "tools", "store", "stream", "reasoning", "include", "max_output_tokens") ||
		!availableTextAIModel(aiText(in["model"])) {
		return false
	}
	if _, ok := in["instructions"].(string); !ok {
		return false
	}
	for _, k := range []string{"stream", "store"} {
		if value, present := in[k]; present && value != false {
			return false
		}
	}
	if value, present := in["reasoning"]; present {
		reason, _ := value.(map[string]any)
		if !aiKeys(reason, "effort") || !slices.Contains([]string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}, aiText(reason["effort"])) {
			return false
		}
	}
	if value, present := in["include"]; present {
		parts, ok := value.([]any)
		if !ok || len(parts) != 1 || parts[0] != "reasoning.encrypted_content" {
			return false
		}
	}
	items, ok := in["input"].([]any)
	if !ok || len(items) == 0 || len(items) > 256 {
		return false
	}
	for _, item := range items {
		value, ok := item.(map[string]any)
		if !ok || !editorItem(value, false) {
			return false
		}
	}
	tools, ok := in["tools"].([]any)
	if !ok || len(tools) > 3 {
		return false
	}
	seen := map[string]bool{}
	for _, tool := range tools {
		def, _ := tool.(map[string]any)
		name := aiText(def["name"])
		params, ok := def["parameters"].(map[string]any)
		if def["type"] != "function" || !editorFunction(name) || seen[name] || !ok || params["type"] != "object" ||
			!aiKeys(def, "type", "name", "description", "parameters", "strict") {
			return false
		}
		if _, ok := def["description"].(string); !ok {
			return false
		}
		if strict, exists := def["strict"]; exists {
			if _, ok := strict.(bool); !ok {
				return false
			}
		}
		seen[name] = true
	}
	return true
}

func (s *Service) aiEditorRespond(w http.ResponseWriter, r *http.Request, u identity, ws Workspace) {
	if r.Method != http.MethodPost {
		problem(w, 405, "Méthode non autorisée")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, aiEditorMaxBytes)
	var in map[string]any
	if !body(w, r, &in) {
		return
	}
	if !validEditorRequest(in) {
		problem(w, 400, "Requête de l’assistant d’édition invalide")
		return
	}
	credential, ok := s.aiSelected(w, r, u, ws, "")
	if !ok {
		return
	}
	in["store"], in["stream"], in["max_output_tokens"] = false, false, aiMaxOutputTokens
	raw, ok := s.aiResponse(w, r, u, credential, in)
	if !ok {
		return
	}
	var out struct {
		Status     string           `json:"status"`
		Model      string           `json:"model,omitempty"`
		Output     []map[string]any `json:"output"`
		Incomplete *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details,omitempty"`
	}
	if json.Unmarshal(raw, &out) != nil || (out.Status != "completed" && out.Status != "incomplete") || out.Output == nil || (len(out.Output) == 0 && out.Status == "completed") {
		aiFailure(w, 502)
		return
	}
	offered := map[string]bool{}
	for _, tool := range in["tools"].([]any) {
		offered[aiText(tool.(map[string]any)["name"])] = true
	}
	for _, item := range out.Output {
		if !editorItem(item, true) || (item["type"] == "function_call" && !offered[aiText(item["name"])]) {
			aiFailure(w, 502)
			return
		}
	}
	jsonOut(w, 200, out)
}
