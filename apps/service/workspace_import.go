package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"

	"github.com/JackUait/blok/packages/server/go/v2/blokdocs"
	"github.com/jackc/pgx/v5"
)

var importAttempt = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Same scope and UUIDv8 as the Node service, including on a retry after a host switch.
func importRootID(parts ...string) string {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(parts)
	// JSON.stringify emits the two Unicode line separators literally, whereas
	// encoding/json escapes them even when HTML escaping is disabled.
	var canonical bytes.Buffer
	data := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	for i := 0; i < len(data); i++ {
		if data[i] == '\\' && i+1 < len(data) {
			if bytes.HasPrefix(data[i:], []byte(`\u2028`)) {
				canonical.WriteRune('\u2028')
				i += 5
				continue
			}
			if bytes.HasPrefix(data[i:], []byte(`\u2029`)) {
				canonical.WriteRune('\u2029')
				i += 5
				continue
			}
			canonical.Write(data[i : i+2])
			i++
			continue
		}
		canonical.WriteByte(data[i])
	}
	sum := sha256.Sum256(canonical.Bytes())
	sum[6] = sum[6]&15 | 128
	sum[8] = sum[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", sum[:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
}

func (s *Service) importExists(ctx context.Context, q querier, root, workspace string, user identity) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pages p JOIN page_shares sh ON sh.page_id=p.id
        WHERE p.id=$1 AND p.workspace_id=$2 AND sh.user_id=$3 AND sh.level='full' AND NOT p.trashed AND NOT p.deleted)`, root, workspace, user.ID).Scan(&exists)
	if err != nil || !exists {
		return false, err
	}
	access, err := s.effectiveLevelForSession(ctx, q, user.Session, root)
	return access == levelFull, err
}

func (s *Service) importWorkspace(w http.ResponseWriter, r *http.Request, u identity, ws Workspace, format string) {
	if r.Method != "POST" {
		problem(w, 405, "Method not allowed")
		return
	}
	if ws.Role == "viewer" {
		problem(w, 403, "Write access required")
		return
	}
	var input struct {
		Attempt string
		Name    string
		Source  *string
	}
	var raw []byte
	var fingerprint string
	switch format {
	case "zip":
		input.Attempt = r.URL.Query().Get("attempt")
		input.Name = r.URL.Query().Get("name")
	case "markdown", "csv":
		if !body(w, r, &input) {
			return
		}
		if input.Source == nil {
			problem(w, 400, "File contents required")
			return
		}
		fingerprint = *input.Source
	default:
		problem(w, 404, "Not found")
		return
	}
	ext := strings.ToLower(path.Ext(input.Name))
	if !importAttempt.MatchString(input.Attempt) || len(input.Name) > 1024 ||
		!(format == "zip" && ext == ".zip" || format == "csv" && ext == ".csv" || format == "markdown" && (ext == ".md" || ext == ".markdown")) {
		problem(w, 400, "Invalid import file")
		return
	}
	if format == "zip" {
		var err error
		raw, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxImportZIP))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				problem(w, 413, "ZIP archive exceeds 64 MiB")
			} else {
				problem(w, 400, "Invalid request body")
			}
			return
		}
		fingerprint = fmt.Sprintf("%x", sha256.Sum256(raw))
	}
	root := importRootID(ws.ID, u.ID, input.Attempt, input.Name, fingerprint)
	existing, err := s.importExists(r.Context(), s.DB, root, ws.ID, u)
	if err != nil {
		failed(w, 503, "Read failed", err)
		return
	}
	result := map[string]string{"id": root}
	if existing {
		jsonOut(w, 200, result)
		return
	}
	conversion := blokdocs.WorkspaceImport{Name: input.Name, RootID: root, Source: input.Source}
	var assets *strings.Replacer
	if format == "zip" {
		conversion.Entries, assets, err = importZIPEntries(r.Context(), raw)
		if err != nil {
			problem(w, 422, err.Error())
			return
		}
	}
	pages, err := s.Blok.DocumentConverter().ImportWorkspace(r.Context(), conversion)
	if err != nil {
		problem(w, 422, "File could not be converted to a Blok page")
		return
	}
	if len(pages) == 0 || pages[0].ID != root || pages[0].ParentID != nil {
		problem(w, 422, "Invalid import root")
		return
	}
	type row struct {
		ID       string          `json:"id"`
		Parent   *string         `json:"parent"`
		Metadata map[string]any  `json:"metadata"`
		Document json.RawMessage `json:"document"`
	}
	rows := make([]row, 0, len(pages))
	for _, p := range pages {
		var header struct {
			Title string
			Icon  struct{ Type, Value string }
		}
		if err = json.Unmarshal(p.Document, &header); err != nil || len(header.Title) > 4096 {
			problem(w, 422, "Invalid imported title")
			return
		}
		meta := map[string]any{"id": p.ID, "parentId": p.ParentID, "title": header.Title}
		if header.Icon.Type == "emoji" {
			meta["icon"] = header.Icon.Value
		}
		if assets != nil {
			p.Document = json.RawMessage(assets.Replace(string(p.Document)))
		}
		rows = append(rows, row{p.ID, p.ParentID, meta, p.Document})
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failed(w, 503, "Database unavailable", err)
		return
	}
	defer tx.Rollback(ctx)
	// Index writes take the same workspace lock. Recheck the live session and
	// membership after conversion and publish every page in one transaction.
	var role string
	err = tx.QueryRow(ctx, `SELECT m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
        JOIN sessions ss ON ss.user_id=m.user_id WHERE w.id=$1 AND m.user_id=$2 AND ss.id=$3 AND ss.expires_at>now()
        FOR UPDATE OF w FOR SHARE OF m,ss`, ws.ID, u.ID, u.Session).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || role == "viewer" {
		problem(w, 403, "Write access required")
		return
	}
	if err != nil {
		failed(w, 503, "Database unavailable", err)
		return
	}
	existing, err = s.importExists(ctx, tx, root, ws.ID, u)
	if err != nil {
		failed(w, 500, "Read failed", err)
		return
	}
	if existing {
		jsonOut(w, 200, result)
		return
	}
	tag, err := tx.Exec(ctx, `INSERT INTO pages(id,workspace_id,metadata,content,visibility)
        SELECT p->>'id',$1,(p->'metadata') || jsonb_build_object('position',n-1+(SELECT count(*) FROM pages WHERE workspace_id=$1)),
          p->'document',CASE WHEN p->>'parent' IS NULL THEN 'private' ELSE 'inherit' END
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS imported(p,n)
        ON CONFLICT(id) DO NOTHING`, ws.ID, rows)
	if err != nil {
		failed(w, 500, "Import failed", err)
		return
	}
	if tag.RowsAffected() != int64(len(rows)) {
		problem(w, 409, "Imported page no longer available")
		return
	}
	if _, err = tx.Exec(ctx, "INSERT INTO page_shares(page_id,user_id,level,granted_by) VALUES($1,$2,'full',$2)", root, u.ID); err == nil {
		_, err = tx.Exec(ctx, "UPDATE workspaces SET revision=revision+1 WHERE id=$1", ws.ID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failed(w, 500, "Import failed", err)
		return
	}
	jsonOut(w, 200, result)
}
