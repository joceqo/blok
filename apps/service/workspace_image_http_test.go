package cloud

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceImageHTTPAcceptsLargeCaptureAndStoresLosslessPrivateAsset(t *testing.T) {
	world := newReadsWorld(t)
	source := workspacePNG(t, 2048, 1024, png.NoCompression)
	dataURL := workspaceImageDataURL("image/png", source)
	if len(dataURL) <= 8<<20 {
		t.Fatal("fixture must exceed the former JSON transport cap")
	}
	uploaded := world.post(t, tokenAlice, "/api/workspaces/equipe/images", map[string]any{"dataUrl": dataURL}, http.StatusCreated)
	imageURL, ok := uploaded["url"].(string)
	if !ok || !strings.HasPrefix(imageURL, "/files/") {
		t.Fatal("missing persistent image URL")
	}
	stored, err := os.ReadFile(filepath.Join(world.service.Config.DataDirectory, "uploads", filepath.Base(imageURL)))
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) >= len(source) {
		t.Fatalf("capture was not optimized: %d >= %d", len(stored), len(source))
	}
	picture, err := png.Decode(bytes.NewReader(stored))
	if err != nil || picture.Bounds().Dx() != 2048 || picture.Bounds().Dy() != 1024 {
		t.Fatalf("capture dimensions changed: %v", err)
	}
	original, err := png.Decode(bytes.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	if picture.At(1023, 512) != original.At(1023, 512) {
		t.Fatal("capture color or transparency changed")
	}
	var owned bool
	if err := world.service.DB.QueryRow(world.ctx, `SELECT EXISTS(SELECT 1 FROM assets WHERE name=$1 AND workspace_id='w' AND document_id IS NULL)`, filepath.Base(imageURL)).Scan(&owned); err != nil || !owned {
		t.Fatalf("asset workspace ownership missing: %v", err)
	}
	if status, _ := world.get(t, "", imageURL); status == http.StatusOK {
		t.Fatal("private image became publicly readable")
	}
}

func TestWorkspaceImageHTTPPreservesWritePermissionsAndValidation(t *testing.T) {
	world := newReadsWorld(t)
	if _, err := world.service.DB.Exec(world.ctx, `UPDATE memberships SET role='viewer' WHERE workspace_id='w' AND user_id='bob'`); err != nil {
		t.Fatal(err)
	}
	world.post(t, tokenBob, "/api/workspaces/equipe/images", map[string]any{"dataUrl": tinyPNG}, http.StatusForbidden)
	world.post(t, tokenAlice, "/api/workspaces/equipe/images", map[string]any{"dataUrl": strings.Replace(tinyPNG, "image/png", "image/jpeg", 1)}, http.StatusBadRequest)
	corrupt, err := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNG, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	corrupt[len(corrupt)-15] ^= 1
	invalid := world.post(t, tokenAlice, "/api/workspaces/equipe/images", map[string]any{"dataUrl": workspaceImageDataURL("image/png", corrupt)}, http.StatusBadRequest)
	if message, _ := invalid["error"].(string); !strings.Contains(message, "invalid workspace image") {
		t.Fatalf("image validation was not surfaced as a client error: %v", invalid)
	}
	var count int
	if err := world.service.DB.QueryRow(world.ctx, `SELECT count(*) FROM assets`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("refused uploads created assets: %d %v", count, err)
	}
}
