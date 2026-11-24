package cloud

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// A document carries files as well as pictures — a CSV of leave days, a PDF,
// a spreadsheet — and MCP could upload none of them. File sources and image
// sources each have a separate 25 MiB limit.
const maxWorkspaceFile = 25 << 20

// What /files/ will serve. Not a denylist: a type absent here is refused, so a
// new one is a decision someone makes, not an oversight. HTML, SVG and XML stay
// out on purpose — /files/ answers on the app's own origin, and markup served
// from there is markup the app is trusted for. The `sandbox` CSP on that route
// is the second lock; this list is the first.
var uploadableFiles = map[string]struct{}{
	".csv": {}, ".tsv": {}, ".txt": {}, ".md": {}, ".json": {}, ".ics": {},
	".pdf": {}, ".zip": {},
	".xlsx": {}, ".xls": {}, ".docx": {}, ".doc": {}, ".pptx": {}, ".ppt": {},
	".odt": {}, ".ods": {}, ".odp": {},
}

// UploadableFileExtensions lists what blok_upload_file takes, for its description.
func UploadableFileExtensions() []string {
	out := make([]string, 0, len(uploadableFiles))
	for extension := range uploadableFiles {
		out = append(out, strings.TrimPrefix(extension, "."))
	}

	return out
}

// decodeWorkspaceFile reads a base64 data URL into bytes and the extension the
// stored file takes. fileName gives the extension and must be a plain name.
func decodeWorkspaceFile(raw string, fileName string, limit int) ([]byte, string, error) {
	if len(raw) > base64.StdEncoding.EncodedLen(limit)+128 {
		return nil, "", errors.New("file too large")
	}
	header, encoded, ok := strings.Cut(raw, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(header, ";base64") {
		return nil, "", errors.New("expected a base64 data url")
	}
	// A name, never a path: the stored name is minted here, but a caller that
	// can steer it at all is a caller worth stopping early.
	if fileName == "" || fileName != path.Base(fileName) || strings.ContainsAny(fileName, `/\`) {
		return nil, "", errors.New("file name must be a plain name")
	}
	extension := strings.ToLower(path.Ext(fileName))
	if _, ok := uploadableFiles[extension]; !ok {
		return nil, "", errors.New("unsupported file type")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > limit {
		return nil, "", errors.New("invalid or oversized file")
	}
	// The extension can lie; the bytes cannot. A CSV holding a page of markup
	// would be served from this origin as that markup.
	if strings.HasPrefix(http.DetectContentType(data), "text/html") {
		return nil, "", errors.New("markup is refused")
	}

	return data, extension, nil
}

// storeWorkspaceFile saves the file in the private asset store, as pictures are.
func (s *Service) storeWorkspaceFile(ctx context.Context, ws Workspace, raw string, fileName string, limit int) (string, int, error) {
	data, extension, err := decodeWorkspaceFile(raw, fileName, limit)
	if err != nil {
		return "", 0, err
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return "", 0, err
	}
	name := hex.EncodeToString(random) + extension
	directory := filepath.Join(s.Config.DataDirectory, "uploads")
	if err = os.MkdirAll(directory, 0700); err != nil {
		return "", 0, err
	}
	stored := filepath.Join(directory, name)
	if err = os.WriteFile(stored, data, 0600); err != nil {
		return "", 0, err
	}
	if _, err = s.DB.Exec(ctx, "INSERT INTO assets(name,workspace_id) VALUES($1,$2)", name, ws.ID); err != nil {
		os.Remove(stored)
		return "", 0, err
	}

	return "/files/" + name, len(data), nil
}
