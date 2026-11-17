package cloud

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// rowBodyPlan describes a copy and its source projection; it performs no writes.
// Body descendants move together. Database comment threads remain with their
// row (and property ids), where the editor and MCP comment commands read them.
type rowBodyPlan struct {
	Source        json.RawMessage
	Body          json.RawMessage
	DescendantIDs []string
	AlreadyMoved  bool
}

// planRowBody accepts only an unambiguous flat block tree. The caller must read
// the authoritative live document and provide its own durable migration gate;
// this pure projection is not a concurrency or persistence protocol.
func planRowBody(document json.RawMessage, rowID, pageID string) (rowBodyPlan, error) {
	var zero rowBodyPlan
	if rowID == "" || !pageIDPattern.MatchString(pageID) {
		return zero, fmt.Errorf("row and valid destination page required")
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	var source map[string]any
	if err := decoder.Decode(&source); err != nil || source == nil {
		return zero, fmt.Errorf("document object required")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return zero, fmt.Errorf("document must contain one JSON object")
	}
	items, ok := source["blocks"].([]any)
	if !ok {
		return zero, fmt.Errorf("document blocks required")
	}
	blocks := make(map[string]map[string]any, len(items))
	parents := make(map[string]string, len(items))
	children := make(map[string][]string, len(items))
	for _, item := range items {
		block, ok := item.(map[string]any)
		if !ok {
			return zero, fmt.Errorf("block object required")
		}
		id, ok := block["id"].(string)
		if !ok || id == "" || blocks[id] != nil {
			return zero, fmt.Errorf("unique block id required")
		}
		kind, ok := block["type"].(string)
		if !ok || kind == "" {
			return zero, fmt.Errorf("block type required")
		}
		if _, ok := block["data"].(map[string]any); !ok {
			return zero, fmt.Errorf("block data required")
		}
		blocks[id] = block
		if parent := block["parent"]; parent != nil {
			value, ok := parent.(string)
			if !ok || value == "" {
				return zero, fmt.Errorf("invalid block parent")
			}
			parents[id] = value
		}
		if content := block["content"]; content != nil {
			list, ok := content.([]any)
			if !ok {
				return zero, fmt.Errorf("invalid block content")
			}
			seen := map[string]bool{}
			for _, raw := range list {
				child, ok := raw.(string)
				if !ok || child == "" || seen[child] {
					return zero, fmt.Errorf("unique child references required")
				}
				seen[child] = true
				children[id] = append(children[id], child)
			}
		}
	}
	listed := make(map[string]string, len(blocks))
	for id, ids := range children {
		for _, child := range ids {
			if blocks[child] == nil || parents[child] != id || listed[child] != "" {
				return zero, fmt.Errorf("ambiguous child relationship")
			}
			listed[child] = id
		}
	}
	for id, parent := range parents {
		if blocks[parent] == nil || listed[id] != parent {
			return zero, fmt.Errorf("orphaned or unlisted block")
		}
	}
	// Iterative walks bound stack use even for hostile deeply nested input.
	state := make(map[string]uint8, len(blocks))
	for id := range blocks {
		path := []string{}
		for current := id; current != "" && state[current] != 2; current = parents[current] {
			if state[current] == 1 {
				return zero, fmt.Errorf("cyclic block tree")
			}
			state[current] = 1
			path = append(path, current)
		}
		for _, current := range path {
			state[current] = 2
		}
	}
	row := blocks[rowID]
	if row == nil || row["type"] != "database-row" {
		return zero, fmt.Errorf("database row required")
	}
	if parent := blocks[parents[rowID]]; parent == nil || parent["type"] != "database" {
		return zero, fmt.Errorf("row must belong to a database")
	}
	data := row["data"].(map[string]any)
	bodyRoots := []string{}
	retainedRoots := []any{}
	for _, id := range children[rowID] {
		if blocks[id]["type"] == "database-comment" {
			retainedRoots = append(retainedRoots, id)
		} else {
			bodyRoots = append(bodyRoots, id)
		}
	}
	plan := rowBodyPlan{DescendantIDs: []string{}}
	if existing, exists := data["pageId"]; exists && existing != nil {
		value, valid := existing.(string)
		if !valid || value != pageID || len(bodyRoots) != 0 {
			return zero, fmt.Errorf("row page requires explicit reconciliation")
		}
		plan.AlreadyMoved = true
	}
	moved := make(map[string]bool)
	bodyBlocks := []any{}
	stack := []string{}
	for index := len(bodyRoots) - 1; index >= 0; index-- {
		stack = append(stack, bodyRoots[index])
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		moved[id] = true
		plan.DescendantIDs = append(plan.DescendantIDs, id)
		block := blocks[id]
		if parents[id] == rowID {
			delete(block, "parent")
		}
		bodyBlocks = append(bodyBlocks, block)
		for index := len(children[id]) - 1; index >= 0; index-- {
			stack = append(stack, children[id][index])
		}
	}
	if !plan.AlreadyMoved {
		data["pageId"] = pageID
		data["bodyBlocks"] = true
		if len(retainedRoots) == 0 {
			delete(row, "content")
		} else {
			row["content"] = retainedRoots
		}
	}
	kept := make([]any, 0, len(items)-len(moved))
	for _, item := range items {
		if !moved[item.(map[string]any)["id"].(string)] {
			kept = append(kept, item)
		}
	}
	source["blocks"] = kept
	var err error
	plan.Source, err = json.Marshal(source)
	if err != nil {
		return zero, err
	}
	plan.Body, err = json.Marshal(map[string]any{"blocks": bodyBlocks})
	if err != nil {
		return zero, err
	}
	return plan, nil
}
