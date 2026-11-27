package cloud

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/JackUait/blok/packages/server/go/v2/blokdocs"
)

const (
	maxImportZIP      = 64 << 20
	maxImportEntry    = 32 << 20
	maxImportExpanded = 128 << 20
)

func visibleZIPFiles(raw []byte) ([]*zip.File, error) {
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, err
	}
	if len(archive.File) > 5000 {
		return nil, errors.New("archive exceeds 5000 entries")
	}
	var total uint64
	var files []*zip.File
	for _, f := range archive.File {
		if f.Flags&1 != 0 {
			return nil, errors.New("encrypted ZIP entries are unsupported")
		}
		if f.UncompressedSize64 > maxImportEntry {
			return nil, errors.New("archive entry exceeds 32 MiB")
		}
		total += f.UncompressedSize64
		if total > maxImportExpanded {
			return nil, errors.New("expanded archive exceeds 128 MiB")
		}
		if f.FileInfo().IsDir() {
			continue
		}
		visible := true
		for _, part := range strings.Split(f.Name, "/") {
			if part == ".." || part == "" || strings.ContainsAny(part, "\\\x00") {
				return nil, errors.New("invalid archive path")
			}
			if strings.HasPrefix(part, ".") || part == "__MACOSX" {
				visible = false
			}
		}
		if visible {
			files = append(files, f)
		}
	}
	return files, nil
}

func readZIPEntry(f *zip.File) ([]byte, error) {
	reader, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, int64(f.UncompressedSize64)+1))
	if err != nil {
		return nil, err
	}
	if uint64(len(data)) != f.UncompressedSize64 {
		return nil, errors.New("invalid ZIP entry size")
	}
	return data, nil
}

// Decompress and encode files in Go, outside the JS engine. Unpredictable
// placeholders keep binary data out of the engine heap, including during link repair.
func importZIPEntries(ctx context.Context, raw []byte) ([]blokdocs.WorkspaceImportEntry, *strings.Replacer, error) {
	files, err := visibleZIPFiles(raw)
	if err == nil && len(files) == 1 && strings.EqualFold(path.Ext(files[0].Name), ".zip") {
		var inner []byte
		inner, err = readZIPEntry(files[0])
		if err == nil {
			files, err = visibleZIPFiles(inner)
		}
	}
	if err != nil {
		return nil, nil, err
	}
	if len(files) == 0 {
		return nil, nil, errors.New("empty ZIP archive")
	}
	prefix := "__blok_asset_" + opaque() + "_"
	var replacements []string
	var entries []blokdocs.WorkspaceImportEntry
	for i, f := range files {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		data, err := readZIPEntry(f)
		if err != nil {
			return nil, nil, err
		}
		var value string
		switch strings.ToLower(path.Ext(f.Name)) {
		case ".md", ".markdown", ".html", ".htm", ".csv":
			if !utf8.Valid(data) {
				return nil, nil, errors.New("invalid UTF-8 document")
			}
			value = strings.TrimPrefix(string(data), "\uFEFF")
		default:
			value = fmt.Sprintf("%s%d__", prefix, i)
			replacements = append(replacements, value, base64.StdEncoding.EncodeToString(data))
		}
		entries = append(entries, blokdocs.WorkspaceImportEntry{Name: f.Name, Size: f.UncompressedSize64, Value: value})
	}
	return entries, strings.NewReplacer(replacements...), nil
}
