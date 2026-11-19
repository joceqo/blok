package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPManagementRetainsPlacementRecoveryDetails(t *testing.T) {
	service := &Service{}
	operation := managementOperation{method: "POST", properties: map[string]any{}, handler: func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 503, map[string]any{"error": "Placement interrupted", "operationId": "op-1", "pageId": "page-1", "requestId": "request-1", "retry": true, "parentId": "host", "parentRowId": "sprint", "internalSecret": "must not escape"})
	}}
	result := service.callManagement(context.WithValue(context.Background(), mcpUserKey{}, identity{User: User{ID: "bob"}}), &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{}`)}}, operation)
	if !result.IsError || len(result.Content) != 1 {
		t.Fatal(result)
	}
	content, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatal(result)
	}
	var out struct {
		Status int `json:"status"`
		Error  struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(content.Text), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != 503 || out.Error.Code != "SERVICE_ERROR" || out.Error.Message != "Placement interrupted" {
		t.Fatal(content.Text)
	}
	if out.Error.Details["operationId"] != "op-1" || out.Error.Details["pageId"] != "page-1" || out.Error.Details["requestId"] != "request-1" || out.Error.Details["retry"] != true || out.Error.Details["parentId"] != "host" || out.Error.Details["parentRowId"] != "sprint" {
		t.Fatal(content.Text)
	}
	if len(out.Error.Details) != 6 {
		t.Fatalf("unexpected recovery data: %s", content.Text)
	}
}

func TestMCPManagementOmitsRecoveryDetailsWithoutPublicFields(t *testing.T) {
	service := &Service{}
	operation := managementOperation{method: "POST", properties: map[string]any{}, handler: func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 409, map[string]any{"error": "Placement interrupted", "internalSecret": "must not escape", "unknown": map[string]any{"pageId": "private"}})
	}}
	result := service.callManagement(context.WithValue(context.Background(), mcpUserKey{}, identity{User: User{ID: "bob"}}), &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`{}`)}}, operation)
	if !result.IsError || len(result.Content) != 1 {
		t.Fatal(result)
	}
	content, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatal(result)
	}
	expected := `{"error":{"code":"CONFLICT","message":"Placement interrupted"},"status":409}`
	if content.Text != expected {
		t.Fatalf("legacy response changed: %s", content.Text)
	}
	legacy := managementFailure(409, "Placement interrupted")
	if legacy.Content[0].(*mcp.TextContent).Text != expected {
		t.Fatal(legacy)
	}
}
