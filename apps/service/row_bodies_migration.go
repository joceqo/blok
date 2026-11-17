package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/JackUait/blok/packages/server/go/v2/blokserver"
	"github.com/jackc/pgx/v5"
)

type rowBodySnapshot struct {
	Document json.RawMessage
	Head     string
}
type rowBodyRuntime struct {
	engine   *blokserver.Server
	endpoint *http.Server
	listener net.Listener
	handler  http.Handler
}

// The only listening socket serves the authenticated internal document endpoint
// on loopback. The collaboration handler is called directly, never exposed.
func newRowBodyRuntime(cfg Config, endpoint http.Handler) (*rowBodyRuntime, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/internal/documents/{id}", endpoint)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go server.Serve(listener)
	auth := "none"
	engine, err := blokserver.New(blokserver.Options{Auth: &auth, PublicURL: "http://127.0.0.1/files", StorageDirectory: filepath.Join(cfg.DataDirectory, "uploads"), CollabEnabled: true, CollabJournal: true, CollabDirectory: filepath.Join(cfg.DataDirectory, "collab"), DocEndpoint: "http://" + listener.Addr().String() + "/internal/documents", DocEndpointAuth: "Bearer " + cfg.InternalSecret})
	if err != nil {
		server.Close()
		return nil, err
	}
	return &rowBodyRuntime{engine: engine, endpoint: server, listener: listener, handler: engine.Handler("")}, nil
}

func (r *rowBodyRuntime) close()                          { r.endpoint.Close() }
func (r *rowBodyRuntime) drain(ctx context.Context) error { return r.engine.Drain(ctx) }
func (r *rowBodyRuntime) request(ctx context.Context, method, documentID, action string) (*httptest.ResponseRecorder, error) {
	req := httptest.NewRequest(method, "http://127.0.0.1/sync/"+url.PathEscape(documentID)+"/"+action, nil).WithContext(ctx)
	response := httptest.NewRecorder()
	r.handler.ServeHTTP(response, req)
	if response.Code != http.StatusOK && response.Code != http.StatusNoContent {
		return nil, fmt.Errorf("maintenance %s %s failed (%d): %s", method, action, response.Code, strings.TrimSpace(response.Body.String()))
	}
	return response, nil
}
func (r *rowBodyRuntime) read(ctx context.Context, documentID string) (rowBodySnapshot, error) {
	response, err := r.request(ctx, http.MethodGet, documentID, "state")
	if err != nil {
		return rowBodySnapshot{}, err
	}
	if !json.Valid(response.Body.Bytes()) || response.Header().Get("ETag") == "" {
		return rowBodySnapshot{}, errors.New("authoritative document with durable head required")
	}
	return rowBodySnapshot{Document: append(json.RawMessage(nil), response.Body.Bytes()...), Head: response.Header().Get("ETag")}, nil
}
func (r *rowBodyRuntime) reset(ctx context.Context, documentID string) error {
	_, err := r.request(ctx, http.MethodPost, documentID, "reset")
	return err
}

// Reset first flushes the journal it replaces. SQL already holds the prepared
// projection, so those saves must be acknowledged without undoing that commit.
// This wrapper exists only inside exclusive offline maintenance.
func rowBodyMigrationEndpoint(next http.Handler, sourceID string, after json.RawMessage, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/documents/"+sourceID {
			next.ServeHTTP(w, r)
			return
		}
		if !internalAuth(r, secret) {
			problem(w, 401, "Internal authorization required")
			return
		}
		switch r.Method {
		case http.MethodGet:
			jsonOut(w, 200, map[string]any{"data": after, "version": "0"})
		case http.MethodPut:
			jsonOut(w, 200, map[string]string{"version": "0"})
		default:
			next.ServeHTTP(w, r)
		}
	})
}

type rowBodyMigrationSkip struct {
	RowID  string `json:"rowId"`
	Reason string `json:"reason"`
}
type rowBodyMigrationReport struct {
	Mode     string                 `json:"mode"`
	SourceID string                 `json:"sourceId"`
	Rows     int                    `json:"rows"`
	Blocks   int                    `json:"blocks"`
	Skipped  []rowBodyMigrationSkip `json:"skipped"`
}
type rowBodyPage struct {
	ID       string          `json:"id"`
	RowID    string          `json:"rowId"`
	Document json.RawMessage `json:"document"`
	Metadata json.RawMessage `json:"metadata"`
}

func migrationJSON(raw json.RawMessage) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var doc map[string]any
	if err := decoder.Decode(&doc); err != nil || doc == nil {
		return nil, errors.New("document object required")
	}
	return doc, nil
}

func planRowBodyMigration(sourceID string, before json.RawMessage) (json.RawMessage, []rowBodyPage, rowBodyMigrationReport, error) {
	report := rowBodyMigrationReport{SourceID: sourceID, Skipped: []rowBodyMigrationSkip{}}
	doc, err := migrationJSON(before)
	if err != nil {
		return nil, nil, report, err
	}
	items, ok := doc["blocks"].([]any)
	if !ok {
		return nil, nil, report, errors.New("document blocks required")
	}
	byID := map[string]map[string]any{}
	for _, raw := range items {
		block, ok := raw.(map[string]any)
		if !ok {
			return nil, nil, report, errors.New("invalid block")
		}
		id, ok := block["id"].(string)
		if !ok || id == "" || byID[id] != nil {
			return nil, nil, report, errors.New("unique block IDs required")
		}
		byID[id] = block
	}
	after := append(json.RawMessage(nil), before...)
	pages := []rowBodyPage{}
	for _, raw := range items {
		row := raw.(map[string]any)
		if row["type"] != "database-row" {
			continue
		}
		rowID := row["id"].(string)
		// Nested databases stay intact in their outer page in this version.
		ancestor, _ := row["parent"].(string)
		seen := map[string]bool{}
		nested := false
		for ancestor != "" {
			if seen[ancestor] {
				return nil, nil, report, errors.New("cyclic parent chain")
			}
			seen[ancestor] = true
			parent := byID[ancestor]
			if parent == nil {
				return nil, nil, report, errors.New("orphaned parent")
			}
			if parent["type"] == "database-row" {
				nested = true
				break
			}
			ancestor, _ = parent["parent"].(string)
		}
		if nested {
			report.Skipped = append(report.Skipped, rowBodyMigrationSkip{rowID, "nested-row"})
			continue
		}
		data, ok := row["data"].(map[string]any)
		if !ok {
			return nil, nil, report, errors.New("row data required")
		}
		if page, ok := data["pageId"].(string); ok && page != "" {
			report.Skipped = append(report.Skipped, rowBodyMigrationSkip{rowID, "existing-page"})
			continue
		}
		if template, ok := data["template"].(bool); ok && template {
			report.Skipped = append(report.Skipped, rowBodyMigrationSkip{rowID, "template"})
			continue
		}
		pageID := opaque()
		plan, err := planRowBody(after, rowID, pageID)
		if err != nil {
			return nil, nil, report, fmt.Errorf("row %s: %w", rowID, err)
		}
		if data["bodyBlocks"] != true {
			legacy := false
			properties, _ := data["properties"].(map[string]any)
			for _, value := range properties {
				if body, ok := value.(map[string]any); ok {
					if blocks, ok := body["blocks"].([]any); ok && len(blocks) > 0 {
						legacy = true
					}
				}
			}
			if legacy {
				report.Skipped = append(report.Skipped, rowBodyMigrationSkip{rowID, "legacy-body"})
				continue
			}
		}
		containsDatabase := false
		for _, id := range plan.DescendantIDs {
			kind := byID[id]["type"]
			if kind == "database" || kind == "database-row" {
				containsDatabase = true
				break
			}
		}
		if containsDatabase {
			report.Skipped = append(report.Skipped, rowBodyMigrationSkip{rowID, "nested-database"})
			continue
		}
		title := ""
		if value, ok := data["title"].(string); ok {
			title = value
		}
		if title == "" {
			title = "Row"
		}
		metadata, _ := json.Marshal(map[string]any{"id": pageID, "title": title, "parentId": sourceID, "rowBodyOf": map[string]string{"documentId": sourceID, "rowId": rowID}})
		pages = append(pages, rowBodyPage{ID: pageID, RowID: rowID, Document: plan.Body, Metadata: metadata})
		after = plan.Source
		report.Rows++
		report.Blocks += len(plan.DescendantIDs)
	}
	return after, pages, report, nil
}

// blokctlRows requires the normal service to be stopped and all old clients
// closed. The shared instance lock prevents admission while a plan is applied.
func blokctlRows(ctx context.Context, ops *Ops, args []string, out io.Writer) error {
	if len(args) < 2 || len(args) > 3 || args[0] != "migrate" || !pageIDPattern.MatchString(args[1]) {
		return errors.New("usage: blokctl rows migrate <page-id> [--apply|--resume] (default: dry run; stop the service and close old clients)")
	}
	var installed bool
	if err := ops.DB.QueryRow(ctx, `SELECT to_regclass('row_body_migrations') IS NOT NULL`).Scan(&installed); err != nil {
		return err
	}
	if !installed {
		return errors.New("start the new server once to install the row migration schema, then stop it before maintenance")
	}
	mode := "dry-run"
	if len(args) == 3 {
		switch args[2] {
		case "--apply":
			mode = "apply"
		case "--resume":
			mode = "resume"
		default:
			return errors.New("expected --apply or --resume")
		}
	}
	conn, err := ops.DB.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var locked bool
	if err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(774839103,hashtext(current_schema()))`).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return errors.New("stop the service before row-body maintenance")
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(774839103,hashtext(current_schema()))`)
	sourceID := args[1]
	var workspaceID string
	if err = ops.DB.QueryRow(ctx, `SELECT workspace_id FROM pages WHERE id=$1 AND NOT deleted AND NOT trashed`, sourceID).Scan(&workspaceID); err != nil {
		return fmt.Errorf("source page unavailable: %w", err)
	}
	service := ops.asService()
	endpoint := http.HandlerFunc(service.document)
	if mode == "resume" {
		return resumeRowBodyMigration(ctx, ops, endpoint, sourceID, out)
	}
	var completed bool
	if err = ops.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM row_body_migrations WHERE source_id=$1 AND state='complete')`, sourceID).Scan(&completed); err != nil {
		return err
	}
	if completed && mode == "apply" {
		return resumeRowBodyMigration(ctx, ops, endpoint, sourceID, out)
	}
	var pending bool
	if err = ops.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM row_body_migrations WHERE state='prepared')`).Scan(&pending); err != nil {
		return err
	}
	if pending {
		return errors.New("a prepared migration must be resumed first")
	}
	runtime, err := newRowBodyRuntime(ops.Config, endpoint)
	if err != nil {
		return err
	}
	snapshot, readErr := runtime.read(ctx, sourceID)
	drainErr := runtime.drain(ctx)
	runtime.close()
	if readErr != nil {
		return readErr
	}
	if drainErr != nil {
		return drainErr
	}
	after, pages, report, err := planRowBodyMigration(sourceID, snapshot.Document)
	if err != nil {
		return err
	}
	report.Mode = mode
	if mode == "dry-run" || len(pages) == 0 {
		return json.NewEncoder(out).Encode(report)
	}
	encodedPages, err := json.Marshal(pages)
	if err != nil {
		return err
	}
	tx, err := ops.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE`, workspaceID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO row_body_migrations(source_id,workspace_id,state,source_before,source_after,body_pages) VALUES($1,$2,'prepared',$3,$4,$5)`, sourceID, workspaceID, []byte(snapshot.Document), []byte(after), encodedPages); err != nil {
		return fmt.Errorf("prepare migration (use --resume for an existing record): %w", err)
	}
	for _, page := range pages {
		if _, err = tx.Exec(ctx, `INSERT INTO pages(id,workspace_id,metadata,content,visibility) VALUES($1,$2,$3,$4,'inherit')`, page.ID, workspaceID, []byte(page.Metadata), []byte(page.Document)); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE pages SET content=$2,version=version+1,lineage=NULL,sequence=NULL,admission_started=true WHERE id=$1`, sourceID, []byte(after)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE workspaces SET revision=revision+1 WHERE id=$1`, workspaceID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return resumeRowBodyMigration(ctx, ops, endpoint, sourceID, out)
}

func resumeRowBodyMigration(ctx context.Context, ops *Ops, endpoint http.Handler, sourceID string, out io.Writer) error {
	var state string
	var before, after, rawPages json.RawMessage
	err := ops.DB.QueryRow(ctx, `SELECT state,source_before,source_after,body_pages FROM row_body_migrations WHERE source_id=$1`, sourceID).Scan(&state, &before, &after, &rawPages)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("no prepared migration for this page")
	}
	if err != nil {
		return err
	}
	var pages []rowBodyPage
	if err = json.Unmarshal(rawPages, &pages); err != nil {
		return err
	}
	_, _, report, err := planRowBodyMigration(sourceID, before)
	if err != nil {
		return err
	}
	report.Mode = "complete"
	report.Rows = len(pages)
	report.Blocks = 0
	for _, page := range pages {
		doc, e := migrationJSON(page.Document)
		if e != nil {
			return e
		}
		blocks, ok := doc["blocks"].([]any)
		if !ok {
			return errors.New("invalid prepared body")
		}
		report.Blocks += len(blocks)
	}
	if state == "complete" {
		return json.NewEncoder(out).Encode(report)
	}
	if state != "prepared" {
		return errors.New("unknown migration state")
	}
	runtime, err := newRowBodyRuntime(ops.Config, rowBodyMigrationEndpoint(endpoint, sourceID, after, ops.Config.InternalSecret))
	if err != nil {
		return err
	}
	defer runtime.close()
	// No read of the source before reset: old-room projections are intentionally
	// intercepted for this entire runtime, including its final drain.
	if err = runtime.reset(ctx, sourceID); err != nil {
		runtime.drain(context.Background())
		return err
	}
	actual, readErr := runtime.read(ctx, sourceID)
	drainErr := runtime.drain(ctx)
	if readErr != nil {
		return readErr
	}
	if drainErr != nil {
		return drainErr
	}
	want, err := migrationJSON(after)
	if err != nil {
		return err
	}
	got, err := migrationJSON(actual.Document)
	if err != nil {
		return err
	}
	// Export time is generated on each read, not document content.
	delete(want, "time")
	delete(got, "time")
	if !reflect.DeepEqual(want, got) {
		return errors.New("reset verification differs from prepared source; migration remains prepared")
	}
	_, err = ops.DB.Exec(ctx, `UPDATE row_body_migrations SET state='complete',completed_at=now() WHERE source_id=$1 AND state='prepared'`, sourceID)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(report)
}
