package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Location is a read-only projection of the block tree, not a second hierarchy.
// parentId remains the containing document used for storage and permissions.
type pageLocation struct {
	DocumentID      string            `json:"documentId"`
	BlockID         string            `json:"blockId"`
	BlockDocumentID string            `json:"blockDocumentId"`
	Rows            []pageLocationRow `json:"rows"`
}
type pageLocationRow struct {
	DocumentID string `json:"documentId"`
	RowID      string `json:"rowId"`
	DatabaseID string `json:"databaseId"`
	Title      string `json:"title"`
	Icon       string `json:"icon,omitempty"`
}
type locationMetadata struct {
	ID        string `json:"id"`
	ParentID  string `json:"parentId"`
	RowBodyOf *struct {
		DocumentID string `json:"documentId"`
		RowID      string `json:"rowId"`
	} `json:"rowBodyOf"`
}
type locationBlock struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	ParentID string `json:"parentId"`
	Data     struct {
		PageID     string                     `json:"pageId"`
		Title      string                     `json:"title"`
		Icon       string                     `json:"icon"`
		Properties map[string]json.RawMessage `json:"properties"`
		Schema     []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"schema"`
	} `json:"data"`
}
type pageLocationReader struct {
	service         *Service
	q               querier
	ctx             context.Context
	user, workspace string
	metadata        map[string]*locationMetadata
	blocks          map[string]map[string]locationBlock
}

func newPageLocationReader(ctx context.Context, s *Service, q querier, user, workspace string) *pageLocationReader {
	return &pageLocationReader{s, q, ctx, user, workspace, map[string]*locationMetadata{}, map[string]map[string]locationBlock{}}
}
func (r *pageLocationReader) document(id string) (*locationMetadata, error) {
	if value, ok := r.metadata[id]; ok {
		return value, nil
	}
	r.metadata[id] = nil
	var raw []byte
	err := r.q.QueryRow(r.ctx, `SELECT metadata FROM pages WHERE id=$1 AND workspace_id=$2 AND NOT deleted AND NOT trashed`, id, r.workspace).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	access, err := r.service.effectiveLevel(r.ctx, r.q, r.user, id)
	if err != nil {
		return nil, err
	}
	if access < levelView {
		return nil, nil
	}
	var value locationMetadata
	if json.Unmarshal(raw, &value) != nil || value.ID != id {
		return nil, nil
	}
	r.metadata[id] = &value
	return &value, nil
}
func (r *pageLocationReader) documentBlocks(id string) (map[string]locationBlock, error) {
	if value, ok := r.blocks[id]; ok {
		return value, nil
	}
	r.blocks[id] = nil
	// Keep text, table cells and other body data in Postgres. Each parent is
	// projected only once even when hundreds of child pages share a document.
	var raw []byte
	err := r.q.QueryRow(r.ctx, `SELECT coalesce(jsonb_agg(jsonb_build_object(
 'id',b->'id','type',b->'type','parentId',b->'parent','data',
 CASE b->>'type'
 WHEN 'page' THEN jsonb_build_object('pageId',b->'data'->'pageId')
 WHEN 'database-row' THEN jsonb_build_object('pageId',b->'data'->'pageId','title',b->'data'->'title','icon',b->'data'->'icon','properties',b->'data'->'properties')
 WHEN 'database' THEN jsonb_build_object('schema',b->'data'->'schema')
 ELSE '{}'::jsonb END)), '[]'::jsonb)
 FROM pages p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.content->'blocks')='array' THEN p.content->'blocks' ELSE '[]'::jsonb END) b
 WHERE p.id=$1 AND p.workspace_id=$2 AND NOT p.deleted AND NOT p.trashed`, id, r.workspace).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var blocks []locationBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return nil, nil
	}
	result := map[string]locationBlock{}
	for _, b := range blocks {
		if b.ID == "" {
			return nil, nil
		}
		if _, exists := result[b.ID]; exists {
			return nil, nil
		}
		result[b.ID] = b
	}
	r.blocks[id] = result
	return result, nil
}
func (r *pageLocationReader) rowsFrom(documentID, blockID string) ([]pageLocationRow, bool, error) {
	blocks, err := r.documentBlocks(documentID)
	if err != nil {
		return nil, false, err
	}
	if blocks == nil {
		return nil, false, nil
	}
	rows := []pageLocationRow{}
	seen := map[string]bool{}
	for blockID != "" {
		if seen[blockID] {
			return nil, false, nil
		}
		seen[blockID] = true
		b, ok := blocks[blockID]
		if !ok {
			return nil, false, nil
		}
		if b.Type == "database-row" {
			db, ok := blocks[b.ParentID]
			if !ok || db.Type != "database" {
				return nil, false, nil
			}
			title := b.Data.Title
			for _, property := range db.Data.Schema {
				if property.Type == "title" {
					var value string
					if json.Unmarshal(b.Data.Properties[property.ID], &value) == nil {
						title = value
					}
					break
				}
			}
			if strings.TrimSpace(title) == "" {
				title = "Sans titre"
			}
			rows = append(rows, pageLocationRow{documentID, b.ID, db.ID, title, b.Data.Icon})
		}
		blockID = b.ParentID
	}
	slices.Reverse(rows)
	return rows, true, nil
}

// Cross separate row-body documents only through a validated two-way link.
func (r *pageLocationReader) bodyPath(doc *locationMetadata, seen map[string]bool) (string, []pageLocationRow, bool, error) {
	if seen[doc.ID] || len(seen) >= maxPageDepth {
		return "", nil, false, nil
	}
	seen[doc.ID] = true
	if doc.RowBodyOf == nil {
		return doc.ID, nil, true, nil
	}
	body := doc.RowBodyOf
	if body.DocumentID == "" || body.RowID == "" || body.DocumentID != doc.ParentID {
		return "", nil, false, nil
	}
	parent, err := r.document(body.DocumentID)
	if err != nil || parent == nil {
		return "", nil, false, err
	}
	blocks, err := r.documentBlocks(parent.ID)
	if err != nil {
		return "", nil, false, err
	}
	row, ok := blocks[body.RowID]
	if !ok || row.Type != "database-row" || row.Data.PageID != doc.ID {
		return "", nil, false, nil
	}
	root, outer, ok, err := r.bodyPath(parent, seen)
	if err != nil || !ok {
		return "", nil, false, err
	}
	rows, ok, err := r.rowsFrom(parent.ID, row.ID)
	if err != nil || !ok {
		return "", nil, false, err
	}
	return root, append(outer, rows...), true, nil
}

// A shared child may be readable through a hidden body even when the body's
// source page is private. Such a child must be presented as a shared root.
func (r *pageLocationReader) hiddenParentUnavailable(parentID string) (bool, error) {
	if parentID == "" {
		return false, nil
	}
	parent, err := r.document(parentID)
	if err != nil || parent == nil || parent.RowBodyOf == nil {
		return false, err
	}
	_, _, available, err := r.bodyPath(parent, map[string]bool{})
	return !available, err
}

func (r *pageLocationReader) location(meta *locationMetadata) (*pageLocation, error) {
	if meta.RowBodyOf != nil {
		root, rows, ok, err := r.bodyPath(meta, map[string]bool{})
		if err != nil || !ok || len(rows) == 0 {
			return nil, err
		}
		return &pageLocation{DocumentID: root, BlockID: meta.RowBodyOf.RowID, BlockDocumentID: meta.RowBodyOf.DocumentID, Rows: rows}, nil
	}
	if meta.ParentID == "" {
		return nil, nil
	}
	parent, err := r.document(meta.ParentID)
	if err != nil || parent == nil {
		return nil, err
	}
	blocks, err := r.documentBlocks(parent.ID)
	if err != nil {
		return nil, err
	}
	parentID := ""
	found := false
	for _, block := range blocks {
		if block.Type != "page" || block.Data.PageID != meta.ID {
			continue
		}
		if found && parentID != block.ParentID {
			return nil, nil
		}
		found = true
		parentID = block.ParentID
	}
	if !found {
		return nil, nil
	}
	rows, ok, err := r.rowsFrom(parent.ID, parentID)
	if err != nil || !ok {
		return nil, err
	}
	root, outer, ok, err := r.bodyPath(parent, map[string]bool{meta.ID: true})
	if err != nil || !ok {
		return nil, err
	}
	rows = append(outer, rows...)
	if len(rows) == 0 {
		return nil, nil
	}
	blockDocumentID := parent.ID
	if parentID == "" && parent.RowBodyOf != nil {
		parentID = parent.RowBodyOf.RowID
		blockDocumentID = parent.RowBodyOf.DocumentID
	}
	return &pageLocation{DocumentID: root, BlockID: parentID, BlockDocumentID: blockDocumentID, Rows: rows}, nil
}
func (r *pageLocationReader) decorate(pages []json.RawMessage) error {
	for i, raw := range pages {
		var meta locationMetadata
		if json.Unmarshal(raw, &meta) != nil {
			continue
		}
		loc, err := r.location(&meta)
		if err != nil {
			return err
		}
		var value map[string]json.RawMessage
		if json.Unmarshal(raw, &value) != nil {
			continue
		}
		delete(value, "location")
		if loc != nil {
			value["location"], err = json.Marshal(loc)
			if err != nil {
				return err
			}
		}
		pages[i], err = json.Marshal(value)
		if err != nil {
			return err
		}
	}
	return nil
}
