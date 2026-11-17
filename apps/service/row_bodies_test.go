package cloud

import (
	"encoding/json"
	"reflect"
	"testing"
)

func rowPlanJSON(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func rowPlanBlock(t *testing.T, doc map[string]any, id string) map[string]any {
	t.Helper()
	for _, item := range doc["blocks"].([]any) {
		block := item.(map[string]any)
		if block["id"] == id {
			return block
		}
	}
	t.Fatalf("missing block %q", id)
	return nil
}

func TestRowBodyPlanPreservesSubtreeAndOtherRows(t *testing.T) {
	// The flat array is deliberately not DFS ordered: content is authoritative.
	input := json.RawMessage(`{"title":"Source","custom":{"keep":true},"blocks":[
		{"id":"db","type":"database","data":{"schema":[]},"content":["row","other"]},
		{"id":"row","type":"database-row","parent":"db","data":{"properties":{"title":"Task"},"position":"a","unknown":7},"content":["list","comment","paragraph"]},
		{"id":"child","type":"paragraph","parent":"list","data":{"text":"Nested"},"indent":2,"createdAt":9007199254740991},
		{"id":"paragraph","type":"paragraph","parent":"row","data":{"text":"Last"},"tunes":{"alignment":"right"},"lastEditedBy":"alice","lastEditedAt":123},
		{"id":"other","type":"database-row","parent":"db","data":{"properties":{"title":"Other"}},"content":["other-body"]},
		{"id":"list","type":"list","parent":"row","content":["child"],"data":{"text":"First","style":"unordered"}},
		{"id":"other-body","type":"paragraph","parent":"other","data":{"text":"Keep"}},
		{"id":"comment","type":"comment-thread","parent":"row","data":{"messages":[{"text":"Keep annotation"}]}}
	]}`)
	before := append([]byte(nil), input...)
	plan, err := planRowBody(input, "row", "row-page")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.DescendantIDs, []string{"list", "child", "comment", "paragraph"}) {
		t.Fatalf("body membership/order changed: %v", plan.DescendantIDs)
	}
	if plan.AlreadyMoved {
		t.Fatal("unmigrated row reported already moved")
	}
	body := rowPlanJSON(t, plan.Body)
	blocks := body["blocks"].([]any)
	if len(blocks) != 4 {
		t.Fatalf("body lost content: %v", blocks)
	}
	original := rowPlanJSON(t, input)
	for index, id := range plan.DescendantIDs {
		got := blocks[index].(map[string]any)
		want := rowPlanBlock(t, original, id)
		if want["parent"] == "row" {
			delete(want, "parent")
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("block %s metadata/content changed: got %#v want %#v", id, got, want)
		}
	}
	source := rowPlanJSON(t, plan.Source)
	if len(source["blocks"].([]any)) != 4 || source["title"] != "Source" || !reflect.DeepEqual(source["custom"], original["custom"]) {
		t.Fatalf("source projection changed unrelated data: %#v", source)
	}
	for _, id := range []string{"db", "other", "other-body"} {
		if !reflect.DeepEqual(rowPlanBlock(t, source, id), rowPlanBlock(t, original, id)) {
			t.Fatalf("unrelated block %s changed", id)
		}
	}
	row := rowPlanBlock(t, source, "row")
	if _, exists := row["content"]; exists {
		t.Fatal("source row retained migrated child references")
	}
	wantData := rowPlanBlock(t, original, "row")["data"].(map[string]any)
	wantData["pageId"] = "row-page"
	wantData["bodyBlocks"] = true
	if !reflect.DeepEqual(row["data"], wantData) {
		t.Fatalf("row properties lost: %#v", row["data"])
	}
	if !reflect.DeepEqual([]byte(input), before) {
		t.Fatal("planner mutated input")
	}
	again, err := planRowBody(input, "row", "row-page")
	if err != nil || !reflect.DeepEqual(plan, again) {
		t.Fatalf("plan is not deterministic: %v", err)
	}
}

func TestRowBodyPlanRejectsInvalidOrAmbiguousTrees(t *testing.T) {
	for _, tc := range []struct{ name, document, row, page string }{
		{"missing row", `{"blocks":[]}`, "row", "page"},
		{"not row", `{"blocks":[{"id":"row","type":"paragraph","data":{}}]}`, "row", "page"},
		{"row without database", `{"blocks":[{"id":"row","type":"database-row","data":{}}]}`, "row", "page"},
		{"non database parent", `{"blocks":[{"id":"db","type":"paragraph","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{}}]}`, "row", "page"},
		{"duplicate id", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{}},{"id":"row","type":"database-row","parent":"db","data":{}}]}`, "row", "page"},
		{"missing child", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{},"content":["absent"]}]}`, "row", "page"},
		{"unlisted child", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{}},{"id":"body","type":"paragraph","parent":"row","data":{}}]}`, "row", "page"},
		{"wrong child parent", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{},"content":["body"]},{"id":"body","type":"paragraph","parent":"db","data":{}}]}`, "row", "page"},
		{"duplicate child reference", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{},"content":["body","body"]},{"id":"body","type":"paragraph","parent":"row","data":{}}]}`, "row", "page"},
		{"cycle", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{},"content":["body"]},{"id":"body","type":"paragraph","parent":"row","data":{},"content":["row"]}]}`, "row", "page"},
		{"orphan", `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":{}},{"id":"orphan","type":"paragraph","parent":"missing","data":{}}]}`, "row", "page"},
		{"empty target", `{"blocks":[]}`, "row", ""},
		{"invalid JSON", `{"blocks":`, "row", "page"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := planRowBody(json.RawMessage(tc.document), tc.row, tc.page); err == nil {
				t.Fatal("unsafe plan accepted")
			}
		})
	}
}

func TestRowBodyPlanEmptyAndExistingPage(t *testing.T) {
	for _, tc := range []struct {
		name, data, content string
		already, reject     bool
	}{
		{"empty body", `{}`, "", false, false},
		{"empty array", `{}`, `,"content":[]`, false, false},
		{"same page", `{"pageId":"page","bodyBlocks":true}`, "", true, false},
		{"different page", `{"pageId":"other"}`, "", false, true},
		{"same page with remaining legacy", `{"pageId":"page"}`, `,"content":["body"]`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := `{"blocks":[{"id":"db","type":"database","data":{},"content":["row"]},{"id":"row","type":"database-row","parent":"db","data":` + tc.data + tc.content + `}`
			if tc.name == "same page with remaining legacy" {
				doc += `,{"id":"body","type":"paragraph","parent":"row","data":{"text":"Do not discard"}}`
			}
			doc += `]}`
			plan, err := planRowBody(json.RawMessage(doc), "row", "page")
			if tc.reject {
				if err == nil {
					t.Fatal("conflicting destination/legacy accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if plan.AlreadyMoved != tc.already || len(plan.DescendantIDs) != 0 {
				t.Fatalf("unexpected empty-body plan: %#v", plan)
			}
			if len(rowPlanJSON(t, plan.Body)["blocks"].([]any)) != 0 {
				t.Fatal("empty body invented content")
			}
			if tc.already && !reflect.DeepEqual(rowPlanJSON(t, plan.Source), rowPlanJSON(t, json.RawMessage(doc))) {
				t.Fatal("retry changed migrated source")
			}
		})
	}
}
