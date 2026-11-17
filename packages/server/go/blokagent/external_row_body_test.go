package blokagent

import (
	"encoding/json"
	"strings"
	"testing"
)

// Exercise the committed runtime embedded by the production Go MCP host.
func TestExternalRowBodyEditsThroughEmbeddedRuntime(t *testing.T) {
	document := `{"blocks":[
		{"id":"db","type":"database","data":{"schema":[{"id":"t","name":"Title","type":"title","position":"a0"},{"id":"done","name":"Done","type":"checkbox","position":"a1"}],"views":[{"id":"v","name":"Table","type":"table","position":"a0","sorts":[],"filters":[],"visibleProperties":[]}],"activeViewId":"v"},"content":["r"]},
		{"id":"r","type":"database-row","parent":"db","data":{"properties":{"t":"Sprint","done":false},"position":"a0","pageId":"body-doc"}}
	]}`
	executor := sharedExecutor(t)
	update := `{"name":"database.setRowValues","args":{"id":"db","rowId":"r","values":{"done":true}}}`
	result := paRun(t, executor, document, `{"commands":[`+update+`]}`, nil)
	if result.DocumentJSON == nil {
		t.Fatalf("cell update failed: %s", result.ResultJSON)
	}
	var saved struct {
		Blocks []struct {
			ID   string
			Data map[string]any
		}
	}
	if err := json.Unmarshal([]byte(*result.DocumentJSON), &saved); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, block := range saved.Blocks {
		if block.ID == "r" {
			found = true
			if block.Data["pageId"] != "body-doc" || block.Data["properties"].(map[string]any)["done"] != true {
				t.Fatalf("cell edit changed the body pointer or lost the value: %v", block.Data)
			}
		}
	}
	if !found {
		t.Fatal("cell edit removed the row")
	}
	for _, command := range []string{
		`{"name":"block.insert","args":{"type":"paragraph","parentId":"r","data":{"text":"Invisible"}}}`,
		`{"name":"database.duplicateRow","args":{"id":"db","rowId":"r"}}`,
		`{"name":"block.update","args":{"id":"r","data":{"pageId":null}}}`,
	} {
		failed := paRun(t, executor, document, `{"commands":[`+update+`,`+command+`]}`, nil)
		if failed.DocumentJSON != nil || !strings.Contains(failed.ResultJSON, "pageId") {
			t.Fatalf("unsafe batch was saved or lacked routing guidance: %s", failed.ResultJSON)
		}
	}
}
