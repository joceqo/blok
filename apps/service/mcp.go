package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/JackUait/blok/packages/server/go/v2/blokagent"
	"github.com/JackUait/blok/packages/server/go/v2/blokmcp"
	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpUserKey struct{}

func mcpText(v any) *mcp.CallToolResult {
	b, _ := json.Marshal(v)
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}
}

func mcpError(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}
}

func (s *Service) initMCP() error {
	rooms, err := s.Blok.AgentExecutor()
	if err != nil {
		return err
	}
	s.mcpTimingEnabled = mcpTimingFlag()
	if s.mcpTimingEnabled {
		s.mcpTraceWriter = newMCPTraceWriter(s.saveMCPTiming)
	}
	attached, err := blokmcp.Embed(blokmcp.Options{
		Rooms:      rooms,
		PageTitles: "page-map",
		CreatePage: s.createMCPPageDocument,
		Authorize:  s.authorizeMCPDocument,
		OnTiming:   s.recordMCPTiming,
	}, blokmcp.EmbedOptions{Caller: func(ctx context.Context, _ *mcp.CallToolRequest) (*blokmcp.CallerIdentity, error) {
		u, ok := ctx.Value(mcpUserKey{}).(identity)
		if !ok {
			return nil, nil
		}
		return &blokmcp.CallerIdentity{Principal: u.ID}, nil
	}})
	if err != nil {
		return err
	}
	s.MCP = attached
	sdk := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		server := mcp.NewServer(&mcp.Implementation{Name: "blok-cloud", Version: "1.1.0"}, &mcp.ServerOptions{Instructions: "Start with blok_capabilities to discover your identity, roles and management tools. Use native MCP tools for teamspaces, members, workspace and instance administration; no session cookie or REST fallback is needed. Workspace admin and instance admin are distinct. Never assume admin grants private-page access. Invitations send email and account deletion is permanent: use only for the user's explicit request. Workspace pages are listed and created with workspace tools. Use blok_move_page to reparent an existing page and its subtree without recreating it. Use blok_delete_page to move a page and its descendants to trash without replacing the workspace index. Document content is edited with blok_open, blok_read and blok_execute. To write the body of a new empty database row, explicitly call blok_open_row_body with workspace, pageId=physical containing document and rowId, then blok_open its returned body pageId and use blok_execute there. Row properties and comments remain in the containing document. For nested rows, use their physical body document ID. Do not insert body blocks under the source row as a replacement for this flow; existing inline content needs the offline migration. Each blok_execute remains atomic within its opened document.\n\n" + attached.Instructions()})
		s.registerMCPManagement(server)
		s.registerMCPDebugTraces(server)
		server.AddTool(&mcp.Tool{Name: "blok_list_workspaces", Description: "List workspaces available to the signed-in user.", InputSchema: json.RawMessage(`{"type":"object","properties":{}}`)}, s.mcpListWorkspaces)
		server.AddTool(&mcp.Tool{Name: "blok_list_teamspaces", Description: "List real closed teamspaces nested in a workspace; metadata does not grant content access.", InputSchema: json.RawMessage(`{"type":"object","properties":{"workspace":{"type":"string"},"includeArchived":{"type":"boolean"}},"required":["workspace"]}`)}, s.mcpListTeamspaces)
		server.AddTool(&mcp.Tool{Name: "blok_list_pages", Description: "List pages in a workspace by slug. parentId is the containing document used for storage and access. When present, location.blockId in location.blockDocumentId identifies the structural parent; location.documentId is the visible routing root and location.rows is its authorized row breadcrumb path; location.rows carries each rowId, databaseId and documentId. It is a read-only projection, not a destination argument for create/move.", InputSchema: json.RawMessage(`{"type":"object","properties":{"workspace":{"type":"string"}},"required":["workspace"]}`)}, s.mcpListPages)
		server.AddTool(&mcp.Tool{Name: "blok_create_page", Description: "Create a page. To create inside a database row, use parentId=containing document ID and parentRowId=row block ID. Migrated body document IDs also work directly. Use a stable requestId to retry safely without creating duplicates; changed arguments with the same key are refused. An interrupted placement returns recovery details with pageId. Root pages are private by default; with teamspaceId roots are shared only with that teamspace. Children inherit parent access. Use visibility=workspace explicitly for a shared root. Members and admins may create pages.", InputSchema: json.RawMessage(`{"type":"object","properties":{"workspace":{"type":"string"},"title":{"type":"string"},"parentId":{"type":"string"},"parentRowId":{"type":"string","minLength":1,"maxLength":256},"requestId":{"type":"string","minLength":1,"maxLength":200},"teamspaceId":{"type":"string"},"visibility":{"type":"string","enum":["private","workspace","inherit"]}},"required":["workspace","title"]}`)}, s.mcpCreatePage)
		server.AddTool(&mcp.Tool{Name: "blok_upload_image", Description: "Upload a private workspace image (PNG, JPEG, GIF or WebP, up to 5 MiB). Returns a persistent /files/ URL to use in document content. Requires workspace write access.", InputSchema: json.RawMessage(`{"type":"object","properties":{"workspace":{"type":"string"},"dataUrl":{"type":"string"}},"required":["workspace","dataUrl"],"additionalProperties":false}`)}, s.mcpUploadImage)
		server.AddTool(&mcp.Tool{Name: "blok_upload_file", Description: "Upload a private workspace file (" + strings.Join(UploadableFileExtensions(), ", ") + ", up to 25 MiB). fileName gives the extension and names the file card. Returns a persistent /files/ URL, the name and the size. Pictures go through blok_upload_image. Requires workspace write access.", InputSchema: json.RawMessage(`{"type":"object","properties":{"workspace":{"type":"string"},"dataUrl":{"type":"string"},"fileName":{"type":"string"}},"required":["workspace","dataUrl","fileName"],"additionalProperties":false}`)}, s.mcpUploadFile)
		if err := attached.Attach(server); err != nil {
			return nil
		}
		return server
	}, &mcp.StreamableHTTPOptions{Stateless: true, DisableLocalhostProtection: true})
	s.mcpHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// MCP uses explicit bearer credentials. A browser cookie cannot grant an agent access.
		if r.Header.Get("Origin") != "" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || len(r.Header.Get("Authorization")) <= len("Bearer ") {
			problem(w, http.StatusUnauthorized, "Bearer token required")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
		u, err := s.mcpIdentity(r)
		if err != nil {
			problem(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}
		sdk.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mcpUserKey{}, u)))
	})
	return nil
}

// A page block links to a separate document. The block's parentId may be a
// database row, but the document must inherit the containing room's workspace
// and access, exactly as a page created by the editor does.
func (s *Service) createMCPPageDocument(ctx context.Context, request blokagent.PageCreateRequest) (string, error) {
	if request.Principal == "" || request.ParentDocumentID == "" {
		return "", blokmcp.ErrPageRefused
	}
	var ws Workspace
	err := s.DB.QueryRow(ctx, `SELECT w.id,w.slug,w.name FROM pages p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1 AND NOT p.deleted AND NOT p.trashed`, request.ParentDocumentID).Scan(&ws.ID, &ws.Slug, &ws.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", blokmcp.ErrPageRefused
	}
	if err != nil {
		return "", err
	}
	// createScopedPage checks membership, parent edit access and depth again in
	// its transaction. Actor attribution and suggested ids never grant access.
	created, err := s.createScopedPage(ctx, identity{ID: request.Principal}, ws, "Nouvelle page", request.ParentDocumentID, "", visInherit)
	if err != nil {
		var refused scopedPageRefusal
		if errors.As(err, &refused) {
			return "", blokmcp.ErrPageRefused
		}
		return "", err
	}
	return created.ID, nil
}

// La porte des outils d'édition MCP. Elle est distincte de celle du temps réel
// et de celle des routes HTTP, et doit répondre comme elles : un jeton MCP porte
// l'identité de son propriétaire, jamais davantage.
func (s *Service) authorizeMCPDocument(ctx context.Context, principal, documentID string, write bool) (bool, error) {
	required := levelView
	if write {
		required = levelEdit
	}
	return s.authorizePageLevel(ctx, principal, documentID, required)
}

func (s *Service) authorizePageLevel(ctx context.Context, principal, documentID string, required level) (bool, error) {
	var trashed bool
	e := s.DB.QueryRow(ctx, `SELECT trashed FROM pages WHERE id=$1 AND NOT deleted`, documentID).Scan(&trashed)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil || trashed {
		return false, e
	}
	granted, e := s.effectiveLevel(ctx, s.DB, principal, documentID)
	if e != nil {
		return false, e
	}
	return granted >= required, nil
}

func (s *Service) mcpIdentity(r *http.Request) (identity, error) {
	var u identity
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	u.Session = hash(token)
	err := s.DB.QueryRow(r.Context(), `SELECT u.id,u.email,u.name,ia.user_id IS NOT NULL
		FROM mcp_tokens t JOIN users u ON u.id=t.user_id
		LEFT JOIN instance_admins ia ON ia.user_id=u.id
		WHERE t.id=$1 AND t.expires_at>now()`, u.Session).Scan(&u.ID, &u.Email, &u.Name, &u.InstanceAdmin)
	if err == nil {
		_, _ = s.DB.Exec(r.Context(), `UPDATE mcp_tokens SET last_used_at=now() WHERE id=$1`, u.Session)
	}
	return u, err
}

// A token that never expires still carries an expiry: the column is NOT NULL
// and all four lookups filter on `expires_at>now()`, so a far sentinel keeps
// one code path instead of making nullability a special case everywhere.
const neverExpires = 100 * 365 * 24 * time.Hour

// Only the offered durations are accepted. An unknown code is refused rather
// than falling back to the default, so a typo cannot mint a longer credential.
func tokenLifetime(code string) (time.Duration, bool) {
	const day = 24 * time.Hour
	switch code {
	case "":
		return 90 * day, true
	case "1d":
		return day, true
	case "7d":
		return 7 * day, true
	case "30d":
		return 30 * day, true
	case "90d":
		return 90 * day, true
	case "1y":
		return 365 * day, true
	case "never":
		return neverExpires, true
	}
	return 0, false
}

// Postgres reads a plain second count as an interval; no string formatting of
// a duration can drift from what tokenLifetime returned.
func intervalOf(d time.Duration) string {
	return strconv.FormatInt(int64(d/time.Second), 10) + " seconds"
}

func (s *Service) mcpTokens(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		rows, err := s.DB.Query(r.Context(), `SELECT id,label,created_at,expires_at,last_used_at FROM mcp_tokens WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC`, u.ID)
		if err != nil {
			problem(w, 503, "Tokens unavailable")
			return
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, label string
			var created, expires time.Time
			var lastUsed *time.Time
			if rows.Scan(&id, &label, &created, &expires, &lastUsed) != nil {
				problem(w, 503, "Tokens unavailable")
				return
			}
			out = append(out, map[string]any{"id": id, "label": label, "createdAt": created, "expiresAt": expires, "lastUsedAt": lastUsed})
		}
		if rows.Err() != nil {
			problem(w, 503, "Tokens unavailable")
			return
		}
		jsonOut(w, 200, map[string]any{"tokens": out})
		return
	}
	if r.Method != http.MethodPost {
		problem(w, 405, "Method not allowed")
		return
	}
	var in struct {
		Label     string `json:"label"`
		ExpiresIn string `json:"expiresIn"`
	}
	if !body(w, r, &in) {
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" || len(in.Label) > 80 {
		problem(w, 400, "Invalid token name")
		return
	}
	lifetime, ok := tokenLifetime(in.ExpiresIn)
	if !ok {
		problem(w, 400, "Invalid token lifetime")
		return
	}
	if !s.rate(r.Context(), "mcp-token:"+u.ID, 10) {
		problem(w, 429, "Too many tokens created")
		return
	}
	var count int
	if s.DB.QueryRow(r.Context(), `SELECT count(*) FROM mcp_tokens WHERE user_id=$1 AND expires_at>now()`, u.ID).Scan(&count) != nil {
		problem(w, 503, "Tokens unavailable")
		return
	}
	if count >= 10 {
		problem(w, 409, "Revoke an existing token first")
		return
	}
	token := opaque()
	var created, expires time.Time
	err := s.DB.QueryRow(r.Context(), `INSERT INTO mcp_tokens(id,user_id,label,expires_at) VALUES($1,$2,$3,now()+$4::interval) RETURNING created_at,expires_at`, hash(token), u.ID, in.Label, intervalOf(lifetime)).Scan(&created, &expires)
	if err != nil {
		problem(w, 503, "Could not create token")
		return
	}
	jsonOut(w, 201, map[string]any{"id": hash(token), "label": in.Label, "token": token, "createdAt": created, "expiresAt": expires})
}

func (s *Service) revokeMCPToken(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	tag, err := s.DB.Exec(r.Context(), `DELETE FROM mcp_tokens WHERE id=$1 AND user_id=$2`, r.PathValue("id"), u.ID)
	if err != nil {
		problem(w, 503, "Could not revoke token")
		return
	}
	if tag.RowsAffected() == 0 {
		problem(w, 404, "Token not found")
		return
	}
	jsonOut(w, 200, map[string]bool{"ok": true})
}

func (s *Service) rotateMCPToken(w http.ResponseWriter, r *http.Request) {
	u, ok := s.require(w, r)
	if !ok {
		return
	}
	if !s.rate(r.Context(), "mcp-token:"+u.ID, 10) {
		problem(w, 429, "Too many token changes")
		return
	}
	token := opaque()
	var label string
	var created, expires time.Time
	// Rotating replaces the secret, not the policy: the new token keeps exactly
	// the lifetime the old one was created with.
	err := s.DB.QueryRow(r.Context(), `UPDATE mcp_tokens SET id=$1,expires_at=now()+(expires_at-created_at),created_at=now(),last_used_at=NULL WHERE id=$2 AND user_id=$3 AND expires_at>now() RETURNING label,created_at,expires_at`, hash(token), r.PathValue("id"), u.ID).Scan(&label, &created, &expires)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			problem(w, 404, "Token not found")
		} else {
			problem(w, 503, "Could not rotate token")
		}
		return
	}
	jsonOut(w, 200, map[string]any{"id": hash(token), "label": label, "token": token, "createdAt": created, "expiresAt": expires})
}

func (s *Service) mcpListWorkspaces(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	u := ctx.Value(mcpUserKey{}).(identity)
	list, err := s.workspaces(ctx, u.ID)
	if err != nil {
		return mcpError("Could not list workspaces"), nil
	}
	return mcpText(map[string]any{"workspaces": list}), nil
}

func (s *Service) mcpWorkspace(ctx context.Context, slug string) (Workspace, bool) {
	u := ctx.Value(mcpUserKey{}).(identity)
	if !slugPattern.MatchString(slug) {
		return Workspace{}, false
	}
	ws, err := s.lookupWorkspace(ctx, slug, u.ID)
	return ws, err == nil && ws.Role != ""
}

func (s *Service) mcpListPages(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args struct {
		Workspace string `json:"workspace"`
	}
	if json.Unmarshal(req.Params.Arguments, &args) != nil {
		return mcpError("Invalid arguments"), nil
	}
	ws, ok := s.mcpWorkspace(ctx, args.Workspace)
	if !ok {
		return mcpError("Workspace unavailable"), nil
	}
	standings, _, err := s.workspaceStandings(ctx, s.DB, ctx.Value(mcpUserKey{}).(identity).ID, ws.ID)
	if err != nil {
		return mcpError("Could not list pages"), nil
	}
	rows, err := s.DB.Query(ctx, `SELECT id,`+pageListMetadataSQL+`,public_id::text FROM pages WHERE workspace_id=$1 AND NOT deleted AND NOT trashed ORDER BY (metadata->>'position')::numeric NULLS LAST,id`, ws.ID)
	if err != nil {
		return mcpError("Could not list pages"), nil
	}
	defer rows.Close()
	pages := []json.RawMessage{}
	for rows.Next() {
		var id, publicID string
		var raw json.RawMessage
		if rows.Scan(&id, &raw, &publicID) != nil {
			return mcpError("Could not list pages"), nil
		}
		if standings[id].Level < levelView {
			continue
		}
		var metadata map[string]any
		if json.Unmarshal(raw, &metadata) != nil {
			return mcpError("Invalid metadata"), nil
		}
		metadata["publicId"] = publicID
		metadata["teamspaceId"] = nil
		if standings[id].TeamspaceID != "" {
			metadata["teamspaceId"] = standings[id].TeamspaceID
		}
		encoded, _ := json.Marshal(metadata)
		pages = append(pages, encoded)
	}
	if rows.Err() != nil {
		return mcpError("Could not list pages"), nil
	}
	rows.Close()
	locations := newPageLocationReader(ctx, s, s.DB, ctx.Value(mcpUserKey{}).(identity).ID, ws.ID)
	if err = locations.decorate(pages); err != nil {
		return mcpError("Could not list page locations"), nil
	}
	return mcpText(map[string]any{"pages": pages}), nil
}

func (s *Service) mcpCreatePage(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args struct{ Workspace, Title, ParentID, ParentRowID, RequestID, TeamspaceID, Visibility string }
	if json.Unmarshal(req.Params.Arguments, &args) != nil {
		return managementFailure(400, "Invalid arguments"), nil
	}
	ws, ok := s.mcpWorkspace(ctx, args.Workspace)
	if !ok {
		return managementFailure(404, "Workspace unavailable"), nil
	}
	u := ctx.Value(mcpUserKey{}).(identity)
	if len(args.ParentRowID) > 256 || len(args.RequestID) > 200 {
		return managementFailure(400, "Invalid parentRowId or requestId"), nil
	}
	target, e := s.resolvePlacementTarget(ctx, u, ws.ID, args.ParentID, args.ParentRowID)
	if e != nil {
		return managementFailure(placementStatus(e), e.Error()), nil
	}
	options := pageCreatePlacement{RequestID: args.RequestID, Digest: placementRequestDigest(args.Title, args.ParentID, args.ParentRowID, args.TeamspaceID, args.Visibility)}
	if target.Row != "" {
		options.Target = &target
		options.Plan, e = s.planPlacement(ctx, u, "", "", args.Title, target)
		if e != nil {
			return managementFailure(placementStatus(e), e.Error()), nil
		}
	}
	out, e := s.createScopedPage(ctx, u, ws, args.Title, target.Document, args.TeamspaceID, args.Visibility, options)
	if e != nil {
		return managementFailure(placementStatus(e), e.Error()), nil
	}
	out, e = s.finishCreatedPlacement(ctx, u, ws, out)
	if e != nil {
		details := map[string]any{"pageId": out.ID, "requestId": args.RequestID, "parentId": args.ParentID, "parentRowId": args.ParentRowID, "retry": "Repeat create with the same requestId, or blok_move_page with this pageId and destination"}
		if plan, loadErr := s.loadPlacement(ctx, s.DB, out.ID); loadErr == nil && plan != nil {
			details["operationId"] = plan.Operation
		}
		return managementFailureWithDetails(placementStatus(e), e.Error(), details), nil
	}
	return mcpText(out), nil
}

func (s *Service) mcpUploadImage(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args struct {
		Workspace string `json:"workspace"`
		DataURL   string `json:"dataUrl"`
	}
	if json.Unmarshal(req.Params.Arguments, &args) != nil {
		return mcpError("Invalid arguments"), nil
	}
	ws, ok := s.mcpWorkspace(ctx, args.Workspace)
	if !ok || capOf(ws.Role) < levelEdit {
		return mcpError("Write access required"), nil
	}
	if _, _, err := decodeWorkspaceImage(args.DataURL, maxWorkspaceImage); err != nil {
		return mcpError("Use a PNG, JPEG, GIF or WebP image up to 5 MiB"), nil
	}
	imageURL, err := s.storeWorkspaceImage(ctx, ws, args.DataURL, maxWorkspaceImage)
	if err != nil {
		return mcpError("Could not save image"), nil
	}
	return mcpText(map[string]string{"url": imageURL}), nil
}

func (s *Service) mcpUploadFile(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args struct {
		Workspace string `json:"workspace"`
		DataURL   string `json:"dataUrl"`
		FileName  string `json:"fileName"`
	}
	if json.Unmarshal(req.Params.Arguments, &args) != nil {
		return mcpError("Invalid arguments"), nil
	}
	ws, ok := s.mcpWorkspace(ctx, args.Workspace)
	if !ok || capOf(ws.Role) < levelEdit {
		return mcpError("Write access required"), nil
	}
	url, size, err := s.storeWorkspaceFile(ctx, ws, args.DataURL, args.FileName, maxWorkspaceFile)
	if err != nil {
		return mcpError("Send a base64 data URL named with one of: " + strings.Join(UploadableFileExtensions(), ", ")), nil
	}

	return mcpText(map[string]any{"url": url, "fileName": args.FileName, "size": size}), nil
}

func (s *Service) mcpListTeamspaces(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args struct {
		Workspace       string
		IncludeArchived bool
	}
	if json.Unmarshal(req.Params.Arguments, &args) != nil {
		return mcpError("Invalid arguments"), nil
	}
	ws, ok := s.mcpWorkspace(ctx, args.Workspace)
	if !ok {
		return mcpError("Workspace unavailable"), nil
	}
	list, e := s.listTeamspaces(ctx, s.DB, ctx.Value(mcpUserKey{}).(identity).ID, ws.ID, args.IncludeArchived)
	if e != nil {
		return mcpError("Could not list teamspaces"), nil
	}
	return mcpText(map[string]any{"teamspaces": list}), nil
}
