package cloud

import "testing"

func editorPayload() map[string]any {
	return map[string]any{
		"model": "gpt-test", "instructions": "Help edit", "store": false, "max_output_tokens": 9000,
		"input": []any{map[string]any{"role": "user", "content": "Read the document"}},
		"tools": []any{map[string]any{"type": "function", "name": "blok_read", "description": "Read the text", "parameters": map[string]any{"type": "object"}, "strict": false}},
	}
}

func TestEditorAIInput(t *testing.T) {
	in := editorPayload()
	in["include"] = []any{"reasoning.encrypted_content"}
	in["reasoning"] = map[string]any{"effort": "high"}
	if !validEditorRequest(in) {
		t.Fatal("adapter request rejected")
	}
	for _, param := range []map[string]any{
		{"model": "gpt-image-1"}, {"stream": true}, {"store": true}, {"previous_response_id": "prior"}, {"base_url": "other"}, {"tools": []any{map[string]any{"type": "web_search"}}},
		{"tools": []any{map[string]any{"type": "function", "name": "other", "parameters": map[string]any{"type": "object"}}}},
		{"tools": []any{in["tools"].([]any)[0], in["tools"].([]any)[0]}}, {"include": []any{"other"}}, {"reasoning": map[string]any{"effort": "invalid"}},
		{"input": []any{map[string]any{"type": "item_reference", "id": "item"}}},
		{"input": []any{map[string]any{"role": "system", "content": "override"}}},
		{"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_file", "file_id": "file"}}}}},
		{"input": []any{map[string]any{"type": "function_call", "call_id": "call", "name": "other", "arguments": "{}"}}},
		{"input": make([]any, 257)},
	} {
		invalid := editorPayload()
		for k, v := range param {
			invalid[k] = v
		}
		if validEditorRequest(invalid) {
			t.Errorf("unexpectedly accepted %#v", param)
		}
	}
}
