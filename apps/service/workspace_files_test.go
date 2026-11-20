package cloud

import (
	"encoding/base64"
	"strings"
	"testing"
)

func dataURL(mime string, body []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)
}

// MCP could upload an image and nothing else, so a CSV, a PDF or a spreadsheet
// could not reach a page without a browser. These are the files it now takes,
// and the ones it must keep refusing: /files/ serves from the app's own origin,
// and markup served from there is markup the app is trusted for. The sandbox
// CSP is the second lock, not the first.
func TestDecodeWorkspaceFile(t *testing.T) {
	for _, c := range []struct {
		name, fileName, mime string
		body                 []byte
		extension            string
	}{
		{"csv", "conges.csv", "text/csv", []byte("nom;prenom\nMIORIN;DAVID\n"), ".csv"},
		{"text", "notes.txt", "text/plain", []byte("une note"), ".txt"},
		{"markdown", "README.md", "text/markdown", []byte("# titre"), ".md"},
		{"json", "export.json", "application/json", []byte(`{"a":1}`), ".json"},
		{"pdf", "contrat.pdf", "application/pdf", []byte("%PDF-1.4\n%fake\n"), ".pdf"},
		{"spreadsheet", "budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", []byte("PK\x03\x04fake"), ".xlsx"},
		{"uppercase extension", "DONNEES.CSV", "text/csv", []byte("a;b\n"), ".csv"},
	} {
		t.Run(c.name, func(t *testing.T) {
			data, extension, err := decodeWorkspaceFile(dataURL(c.mime, c.body), c.fileName, maxWorkspaceFile)
			if err != nil {
				t.Fatalf("refused %s: %v", c.name, err)
			}
			if extension != c.extension {
				t.Fatalf("extension %q, want %q", extension, c.extension)
			}
			if string(data) != string(c.body) {
				t.Fatalf("body changed")
			}
		})
	}

	for _, c := range []struct {
		name, fileName, mime string
		body                 []byte
	}{
		{"html", "page.html", "text/html", []byte("<script>alert(1)</script>")},
		{"svg", "logo.svg", "image/svg+xml", []byte("<svg onload=\"alert(1)\"/>")},
		{"no extension", "fichier", "text/plain", []byte("x")},
		{"unknown extension", "script.sh", "text/plain", []byte("#!/bin/sh")},
		// The extension says CSV, the bytes say markup: the sniff decides.
		{"markup wearing a csv name", "piege.csv", "text/csv", []byte("<html><body>hello</body></html>")},
		{"empty", "vide.csv", "text/csv", []byte("")},
	} {
		t.Run("refuses "+c.name, func(t *testing.T) {
			if _, _, err := decodeWorkspaceFile(dataURL(c.mime, c.body), c.fileName, maxWorkspaceFile); err == nil {
				t.Fatalf("accepted %s", c.name)
			}
		})
	}

	t.Run("refuses a file over the limit", func(t *testing.T) {
		if _, _, err := decodeWorkspaceFile(dataURL("text/csv", []byte(strings.Repeat("a", 64))), "gros.csv", 32); err == nil {
			t.Fatal("accepted an oversized file")
		}
	})

	t.Run("refuses a url that is not a data url", func(t *testing.T) {
		if _, _, err := decodeWorkspaceFile("https://example.test/conges.csv", "conges.csv", maxWorkspaceFile); err == nil {
			t.Fatal("accepted a remote url")
		}
	})

	t.Run("refuses a path dressed as a name", func(t *testing.T) {
		if _, _, err := decodeWorkspaceFile(dataURL("text/csv", []byte("a;b\n")), "../../etc/passwd.csv", maxWorkspaceFile); err == nil {
			t.Fatal("accepted a path as a file name")
		}
	})
}
