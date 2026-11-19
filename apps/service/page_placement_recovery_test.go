package cloud

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Seed before the first room opens, then inspect/mutate through the real live
// state/edit ports rather than patching a stale SQL export during recovery.
func recoveryRowWorld(t *testing.T) (*readsWorld, string, identity) {
	t.Helper()
	w := newReadsWorld(t)
	body := seedRowParent(t, w, true)
	var content map[string]any
	var raw []byte
	if err := w.service.DB.QueryRow(w.ctx, `SELECT content FROM pages WHERE id='prive'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &content); err != nil {
		t.Fatal(err)
	}
	content["blocks"] = append(content["blocks"].([]any), map[string]any{
		"id": "source-pointer", "type": "page",
		"data":         map[string]any{"pageId": "enfant", "title": "Commits personnalisés", "icon": "📚", "description": "Keep this custom field"},
		"tunes":        map[string]any{"alignment": "right"},
		"lastEditedBy": "bob", "lastEditedAt": 123,
	})
	raw, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.service.DB.Exec(w.ctx, `UPDATE pages SET content=$1 WHERE id='prive'`, raw); err != nil {
		t.Fatal(err)
	}
	return w, body, identity{User: User{ID: "bob"}, Session: hash(tokenBob)}
}

func recoveryState(t *testing.T, w *readsWorld, u identity, document string) placementSnapshot {
	t.Helper()
	state, err := w.service.placementState(w.ctx, u, document)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func recoveryPointers(state placementSnapshot) []placementBlock {
	var pointers []placementBlock
	for _, block := range state.Blocks {
		if block.Type == "page" && block.Data["pageId"] == "enfant" {
			pointers = append(pointers, block)
		}
	}
	return pointers
}

func recoveryMove() map[string]any {
	return map[string]any{"workspace": "equipe", "pageId": "enfant", "parentId": "prive", "parentRowId": "sprint"}
}

func TestMCPPlacementRecoveryPreservesPointerFields(t *testing.T) {
	w, body, u := recoveryRowWorld(t)
	before := recoveryPointers(recoveryState(t, w, u, "prive"))
	if len(before) != 1 || before[0].Data["icon"] != "📚" {
		t.Fatalf("invalid live source fixture: %#v", before)
	}
	managementCall(t, w, "bob", "blok_move_page", recoveryMove(), false)
	after := recoveryPointers(recoveryState(t, w, u, body))
	if len(after) != 1 {
		t.Fatalf("destination must contain exactly one pointer: %#v", after)
	}
	var original, copied map[string]any
	if err := json.Unmarshal(before[0].Original, &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(after[0].Original, &copied); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"data", "tunes", "lastEditedBy", "lastEditedAt"} {
		if !reflect.DeepEqual(original[key], copied[key]) {
			t.Errorf("pointer %s was not preserved: before=%#v after=%#v", key, original[key], copied[key])
		}
	}
	if pointers := recoveryPointers(recoveryState(t, w, u, "prive")); len(pointers) != 0 {
		t.Fatalf("source pointer survived completed move: %#v", pointers)
	}
	assertRowSubpage(t, w, "enfant", body)
}

func recoveryPlan(t *testing.T, w *readsWorld, u identity) *pagePlacement {
	t.Helper()
	target, err := w.service.resolvePlacementTarget(w.ctx, u, "w", "prive", "sprint")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := w.service.planPlacement(w.ctx, u, "enfant", "prive", "enfant", target)
	if err != nil || plan == nil {
		t.Fatalf("missing durable move plan: %v / %v", plan, err)
	}
	tx, err := w.service.DB.Begin(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(w.ctx)
	if err = w.service.savePlacement(w.ctx, tx, "enfant", plan); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(w.ctx); err != nil {
		t.Fatal(err)
	}
	return plan
}

func recoveryEdit(t *testing.T, w *readsWorld, u identity, document, key string, ops []map[string]any) {
	t.Helper()
	state := recoveryState(t, w, u, document)
	response, err := w.service.placementHTTP(w.ctx, u, document, "POST", "edit", state.Head, key, map[string]any{"ops": ops})
	if err != nil {
		t.Fatal(err)
	}
	if response.Code != 204 {
		t.Fatalf("live edit failed: %d %s", response.Code, response.Body.String())
	}
}

func TestMCPPlacementRecoveryAfterCopyDoesNotDuplicate(t *testing.T) {
	w, body, u := recoveryRowWorld(t)
	plan := recoveryPlan(t, w, u)
	// Simulate interruption after the real copy committed, before removal or
	// finalizing the durable plan. Resume through the public MCP transport.
	if err := w.service.applyPlacementStep(w.ctx, u, "w", "enfant", plan, true); err != nil {
		t.Fatal(err)
	}
	first := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), false)
	second := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), false)
	if first["revision"] != second["revision"] {
		t.Fatalf("retry changed the finalized revision: %v / %v", first, second)
	}
	pointers := recoveryPointers(recoveryState(t, w, u, body))
	if len(pointers) != 1 || pointers[0].ID != plan.Pointer {
		t.Fatalf("retry duplicated or replaced the committed copy: %#v", pointers)
	}
	if source := recoveryPointers(recoveryState(t, w, u, "prive")); len(source) != 0 {
		t.Fatalf("source retained after successful resume: %#v", source)
	}
	assertRowSubpage(t, w, "enfant", body)
}

func TestMCPPlacementRecoveryDoesNotTrustStaleCopyReceipt(t *testing.T) {
	w, body, u := recoveryRowWorld(t)
	plan := recoveryPlan(t, w, u)
	if err := w.service.applyPlacementStep(w.ctx, u, "w", "enfant", plan, true); err != nil {
		t.Fatal(err)
	}
	// A concurrent editor deletes the destination after the copy receipt was
	// committed. Replaying that receipt must not authorize source deletion.
	recoveryEdit(t, w, u, body, "delete-copy", []map[string]any{{"op": "remove", "id": plan.Pointer}})
	for attempt := 0; attempt < 2; attempt++ {
		failed := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), true)
		if failed["status"] != float64(409) {
			t.Fatalf("expected conflict after destination changed: %v", failed)
		}
		if source := recoveryPointers(recoveryState(t, w, u, "prive")); len(source) != 1 || source[0].ID != "source-pointer" {
			t.Fatalf("stale receipt lost the original: %#v", source)
		}
		if copies := recoveryPointers(recoveryState(t, w, u, body)); len(copies) != 0 {
			t.Fatalf("retry recreated a deliberately removed destination: %#v", copies)
		}
	}
}

func TestMCPPlacementRecoveryDoesNotTrustStaleRemovalReceipt(t *testing.T) {
	w, body, u := recoveryRowWorld(t)
	plan := recoveryPlan(t, w, u)
	for _, copy := range []bool{true, false} {
		if err := w.service.applyPlacementStep(w.ctx, u, "w", "enfant", plan, copy); err != nil {
			t.Fatal(err)
		}
	}
	var original map[string]any
	if err := json.Unmarshal(plan.SourceBlocks[0].Original, &original); err != nil {
		t.Fatal(err)
	}
	recoveryEdit(t, w, u, "prive", "restore-source", []map[string]any{{"op": "insert", "id": "source-pointer", "parent": nil, "after": nil, "block": original}})
	recreated, exists := findPlacementBlock(recoveryState(t, w, u, "prive"), "source-pointer")
	if !exists || !samePlacementBlock(recreated, plan.SourceBlocks[0]) {
		t.Fatal("fixture must recreate the identical original to exercise the stale removal receipt")
	}
	for attempt := 0; attempt < 2; attempt++ {
		failed := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), true)
		if failed["status"] != float64(409) {
			t.Fatalf("expected conflict after source recreated: %v", failed)
		}
		if source := recoveryPointers(recoveryState(t, w, u, "prive")); len(source) != 1 || source[0].ID != "source-pointer" {
			t.Fatalf("retry erased recreated source: %#v", source)
		}
		if copies := recoveryPointers(recoveryState(t, w, u, body)); len(copies) != 1 || copies[0].ID != plan.Pointer {
			t.Fatalf("retry duplicated/lost committed destination: %#v", copies)
		}
	}
}

func TestMCPPlacementRecoveryAfterLostFinalReceipt(t *testing.T) {
	w, body, u := recoveryRowWorld(t)
	// Lose only the orchestration receipt: the real room/journal commits
	// remain durable. No mock bypasses the copy/remove or MCP paths.
	for _, sql := range []string{
		`CREATE FUNCTION fail_placement_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.plan->>'applied' = 'true' THEN RAISE EXCEPTION 'lost placement acknowledgement'; END IF; RETURN NEW; END $$`,
		`CREATE TRIGGER fail_placement_ack BEFORE UPDATE ON page_placements FOR EACH ROW EXECUTE FUNCTION fail_placement_ack()`,
	} {
		if _, err := w.service.DB.Exec(w.ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	failed := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), true)
	if failed["status"] != float64(503) {
		t.Fatalf("expected interrupted acknowledgement: %v", failed)
	}
	copied := recoveryPointers(recoveryState(t, w, u, body))
	if len(copied) != 1 || len(recoveryPointers(recoveryState(t, w, u, "prive"))) != 0 {
		t.Fatalf("expected committed copy/removal despite lost receipt: %#v", copied)
	}
	if _, err := w.service.DB.Exec(w.ctx, `DROP TRIGGER fail_placement_ack ON page_placements`); err != nil {
		t.Fatal(err)
	}
	first := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), false)
	second := managementCall(t, w, "bob", "blok_move_page", recoveryMove(), false)
	if first["revision"] != second["revision"] {
		t.Fatalf("second retry changed final revision: %v / %v", first, second)
	}
	final := recoveryPointers(recoveryState(t, w, u, body))
	if len(final) != 1 || final[0].ID != copied[0].ID {
		t.Fatalf("lost receipt retry duplicated or replaced the pointer: %#v", final)
	}
	if source := recoveryPointers(recoveryState(t, w, u, "prive")); len(source) != 0 {
		t.Fatalf("retry recreated the removed source: %#v", source)
	}
	assertRowSubpage(t, w, "enfant", body)
}
