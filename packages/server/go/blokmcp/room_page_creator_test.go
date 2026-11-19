package blokmcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/JackUait/blok/packages/server/go/v2/blokagent"
)

func newRoomCreator(t *testing.T, document string, pages *hostPages, authorize func(context.Context, string, string, bool) (bool, error)) (*Server, func(string, map[string]any) map[string]any) {
	t.Helper()
	host := roomHost(t, document)
	rooms, err := host.AgentExecutor()
	if err != nil {
		t.Fatal(err)
	}
	var create func(context.Context, blokagent.PageCreateRequest) (string, error)
	if pages != nil {
		create = pages.create
	}
	server, err := New(Options{Transport: Transport{Kind: "stdio"}, Auth: Auth{Kind: "none"}, Rooms: rooms, PageTitles: "page-map", CreatePage: create, Authorize: authorize, AgentActor: func(string, string) Actor {
		return Actor{ID: "agent-other", Name: "Desktop", OnBehalfOf: new("attribution-only")}
	}})
	if err != nil {
		t.Fatalf("host page creator must work with in-process rooms: %v", err)
	}
	t.Cleanup(server.Close)
	who, err := server.actorFor(context.Background(), "alice", new("Desktop"))
	if err != nil {
		t.Fatal(err)
	}
	return server, func(name string, args map[string]any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(args)
		result, err := server.dispatch(context.Background(), &toolCall{name: name, arguments: raw, caller: who})
		if err != nil {
			t.Fatal(err)
		}
		return structured(t, result.answer)
	}
}

func roomPageCommands(t *testing.T, raw string) []any {
	t.Helper()
	var commands []any
	if err := json.Unmarshal([]byte(raw), &commands); err != nil {
		t.Fatal(err)
	}
	return commands
}

func TestInProcessRoomsAcceptAHostPageCreator(t *testing.T) {
	pages := &hostPages{}
	_, call := newRoomCreator(t, `{"blocks":[]}`, pages, nil)
	handle := call("blok_open", map[string]any{"documentId": "doc", "write": true})["handle"]
	ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, onePage)})
	if ran["ok"] != true {
		t.Fatalf("insert: %v", ran)
	}
	read := call("blok_read", map[string]any{"handle": handle})
	if !strings.Contains(fmt.Sprint(read), "page-1") {
		t.Fatalf("missing page: %v", read)
	}
	if len(pages.requests) != 1 {
		t.Fatalf("requests: %v", pages.requests)
	}
	req := pages.requests[0]
	if req.Principal != "alice" || req.ParentDocumentID != "doc" || !validPageID(req.SuggestedPageID) || req.Actor.OnBehalfOf == nil || *req.Actor.OnBehalfOf != "attribution-only" {
		t.Fatalf("request: %+v", req)
	}
}

func TestInProcessRoomCreatesAPageInsideARow(t *testing.T) {
	pages := &hostPages{}
	_, call := newRoomCreator(t, `{"blocks":[{"id":"db","type":"database","content":["row"],"data":{"title":"Sprints","schema":[],"views":[]}},{"id":"row","type":"database-row","parent":"db","content":[],"data":{"properties":{}}}]}`, pages, nil)
	handle := call("blok_open", map[string]any{"documentId": "doc", "write": true})["handle"]
	ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, `[{"name":"block.insert","args":{"type":"page","id":"commits","parentId":"row","position":"end"}}]`)})
	if ran["ok"] != true {
		t.Fatalf("nested insert: %v", ran)
	}
	read := call("blok_read", map[string]any{"handle": handle})
	if !strings.Contains(fmt.Sprint(read), "page-1") || len(pages.requests) != 1 || pages.requests[0].ParentDocumentID != "doc" {
		t.Fatalf("read %v, requests %+v", read, pages.requests)
	}
}

func TestInProcessRoomPageRenameAuthorizesTheChildForThePrincipal(t *testing.T) {
	for _, allow := range []bool{true, false} {
		t.Run(fmt.Sprint(allow), func(t *testing.T) {
			var childWrites int
			_, call := newRoomCreator(t, `{"blocks":[{"id":"link","type":"page","data":{"pageId":"child"}}]}`, &hostPages{}, func(_ context.Context, principal, id string, write bool) (bool, error) {
				if principal != "alice" {
					t.Errorf("wrong principal %q", principal)
				}
				if id == "child" && write {
					childWrites++
					return allow, nil
				}
				return true, nil
			})
			handle := call("blok_open", map[string]any{"documentId": "doc", "write": true})["handle"]
			ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, `[{"name":"page.rename","args":{"id":"link","title":"Commits"}}]`)})
			if childWrites != 1 || (ran["ok"] == true) != allow {
				t.Fatalf("rename %v, checks %d", ran, childWrites)
			}
			if !allow && codeOf(t, ran) != "FORBIDDEN" {
				t.Fatalf("denial %v", ran)
			}
			child := call("blok_open", map[string]any{"documentId": "child", "write": false})["handle"]
			read := call("blok_read", map[string]any{"handle": child})
			page, _ := read["page"].(map[string]any)
			if (page["title"] == "Commits") != allow {
				t.Fatalf("child %v", read)
			}
		})
	}
}

func TestInProcessRoomCreatorRefusalsAndInvalidIDsHaveNoParentEffects(t *testing.T) {
	cases := []struct {
		name, id string
		err      error
		code     string
	}{
		{"refused", "", ErrPageRefused, "FORBIDDEN"},
		{"private error", "", errors.New("private host secret"), "SOURCE_UNAVAILABLE"},
		{"empty", "", nil, "SOURCE_UNAVAILABLE"},
		{"dot", "..", nil, "SOURCE_UNAVAILABLE"},
		{"control", "secret\n", nil, "SOURCE_UNAVAILABLE"},
		{"long", strings.Repeat("a", 513), nil, "SOURCE_UNAVAILABLE"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pages := &hostPages{answers: []func(context.Context) (string, error){answer(tc.id, tc.err)}}
			_, call := newRoomCreator(t, `{"blocks":[]}`, pages, nil)
			handle := call("blok_open", map[string]any{"documentId": "doc", "write": true})["handle"]
			ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, onePage)})
			if codeOf(t, ran) != tc.code || strings.Contains(fmt.Sprint(ran), "private host secret") {
				t.Fatalf("refusal: %v", ran)
			}
			read := call("blok_read", map[string]any{"handle": handle})
			if strings.Contains(fmt.Sprint(read), "np0") {
				t.Fatalf("parent mutated: %v", read)
			}
		})
	}
}

func TestInProcessRoomReadOnlyAndInvalidBatchesNeverCreatePages(t *testing.T) {
	pages := &hostPages{}
	_, call := newRoomCreator(t, `{"blocks":[]}`, pages, nil)
	for _, write := range []bool{false, true} {
		handle := call("blok_open", map[string]any{"documentId": "doc", "write": write})["handle"]
		commands := onePage
		if write {
			commands = `[{"name":"block.insert","args":{"type":"page","parentId":"missing","position":"end"}}]`
		}
		ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, commands)})
		if ran["ok"] == true || len(pages.requests) != 0 {
			t.Fatalf("ran %v, creates %d", ran, len(pages.requests))
		}
	}
}

func TestInProcessRoomReportsPagesOrphanedByLaterCreatorFailure(t *testing.T) {
	pages := &hostPages{answers: []func(context.Context) (string, error){answer("created-child", nil), answer("", errors.New("private host secret"))}}
	_, call := newRoomCreator(t, `{"blocks":[]}`, pages, nil)
	handle := call("blok_open", map[string]any{"documentId": "doc", "write": true})["handle"]
	ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, `[{"name":"block.insert","args":{"type":"page","id":"p1","position":"end"}},{"name":"block.insert","args":{"type":"page","id":"p2","position":"end"}}]`)})
	if codeOf(t, ran) != "ORPHANED_SIDE_EFFECT" || !strings.Contains(fmt.Sprint(ran), "created-child") || strings.Contains(fmt.Sprint(ran), "private host secret") {
		t.Fatalf("orphan report %v", ran)
	}
	read := call("blok_read", map[string]any{"handle": handle})
	if strings.Contains(fmt.Sprint(read), "created-child") {
		t.Fatalf("parent changed %v", read)
	}
}

func codeOf(t *testing.T, result map[string]any) string {
	t.Helper()
	failure, _ := result["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func TestInProcessRoomPageContractMatchesItsCreator(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			var pages *hostPages
			if enabled {
				pages = &hostPages{}
			}
			_, call := newRoomCreator(t, `{"blocks":[]}`, pages, nil)
			handle := call("blok_open", map[string]any{"documentId": "doc", "write": true})["handle"]
			description := call("blok_describe", map[string]any{"handle": handle, "tool": "page"})
			tool, _ := description["tool"].(map[string]any)
			if (tool["insertable"] != false) != enabled {
				t.Fatalf("page contract enabled %v: %v", enabled, description)
			}
			ran := call("blok_execute", map[string]any{"handle": handle, "commands": roomPageCommands(t, onePage)})
			if (ran["ok"] == true) != enabled {
				t.Fatalf("page insert enabled %v: %v", enabled, ran)
			}
		})
	}
}

// Existing mixed room/source configurations remain valid without the new
// creator hook; the hook must not silently choose one of two creation hosts.
func TestInProcessRoomsKeepExistingConfigurationWithoutCreator(t *testing.T) {
	for name, options := range map[string]Options{
		"source": {Source: &Source{Kind: "files", Dir: t.TempDir()}},
		"sync":   {Sync: &Sync{URL: "ws://127.0.0.1:9/sync"}, Tickets: &Tickets{Kind: "secret", Secret: "s"}},
	} {
		t.Run(name, func(t *testing.T) {
			options.Transport = Transport{Kind: "stdio"}
			options.Auth = Auth{Kind: "none"}
			options.Rooms = &blokagent.Executor{}
			server, err := New(options)
			if err != nil {
				t.Fatal(err)
			}
			server.Close()
		})
	}
}
