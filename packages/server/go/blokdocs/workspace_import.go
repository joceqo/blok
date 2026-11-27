package blokdocs

import (
	"context"
	"encoding/json"
)

// WorkspaceImportEntry supplies UTF-8 page text or the base64 payload of an attachment.
// A host can substitute an opaque token for large binary payloads and expand it after conversion.
type WorkspaceImportEntry struct {
	Name  string `json:"name"`
	Size  uint64 `json:"size"`
	Value string `json:"value"`
}

type WorkspaceImport struct {
	Name    string                 `json:"name"`
	RootID  string                 `json:"rootId"`
	Source  *string                `json:"source,omitempty"`
	Entries []WorkspaceImportEntry `json:"entries,omitempty"`
}

type ImportedPage struct {
	ID       string          `json:"id"`
	ParentID *string         `json:"parentId"`
	Document json.RawMessage `json:"document"`
}

// ImportWorkspace converts a Markdown/CSV file or the entries of a workspace ZIP.
func (c *Converter) ImportWorkspace(ctx context.Context, input WorkspaceImport) ([]ImportedPage, error) {
	data, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	out, err := c.invoke(ctx, "workspaceImport", string(data))
	if err != nil {
		return nil, err
	}
	var pages []ImportedPage
	err = json.Unmarshal([]byte(out), &pages)
	return pages, err
}
