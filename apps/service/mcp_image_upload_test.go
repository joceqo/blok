package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func imageMCPCall(t *testing.T, world *readsWorld, user, method string, params any) map[string]any {
	t.Helper()
	token := "image-upload-test-" + user
	if _, err := world.service.DB.Exec(world.ctx, `INSERT INTO mcp_tokens(id,user_id,label,expires_at) VALUES($1,$2,'upload test',now()+interval '1 hour') ON CONFLICT(id) DO NOTHING`, hash(token), user); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, world.server.URL+"/mcp", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("MCP HTTP %d: %.256s", response.StatusCode, raw)
	}
	if strings.Contains(string(raw), "data: ") {
		raw = []byte(strings.SplitN(strings.SplitN(string(raw), "data: ", 2)[1], "\n", 2)[0])
	}
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("invalid MCP response: %v", err)
	}
	return envelope
}

func TestMCPImageUploadSourceSchema(t *testing.T) {
	world := newReadsWorld(t)
	envelope := imageMCPCall(t, world, "alice", "tools/list", map[string]any{})
	result, ok := envelope["result"].(map[string]any)
	if !ok {
		t.Fatalf("missing tools result: %v", envelope["error"])
	}
	tools, ok := result["tools"].([]any)
	if !ok {
		t.Fatal("missing tools")
	}
	for _, entry := range tools {
		tool := entry.(map[string]any)
		if tool["name"] != "blok_upload_image" {
			continue
		}
		schema := tool["inputSchema"].(map[string]any)
		properties := schema["properties"].(map[string]any)
		if _, ok := properties["url"]; !ok {
			t.Fatal("image upload has no HTTPS URL source")
		}
		if _, ok := properties["filePath"]; ok {
			t.Fatal("remote MCP cannot read a client file path")
		}
		if schema["additionalProperties"] != false {
			t.Fatal("unexpected upload arguments must be refused")
		}
		if alternatives, ok := schema["oneOf"].([]any); !ok || len(alternatives) != 2 {
			t.Fatal("declare exactly one of dataUrl or url")
		}
		return
	}
	t.Fatal("image upload tool missing")
}

func TestMCPImageUploadLargeCaptureCrossesTransport(t *testing.T) {
	world := newReadsWorld(t)
	var source bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	if err := encoder.Encode(&source, image.NewNRGBA(image.Rect(0, 0, 2048, 1024))); err != nil {
		t.Fatal(err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(source.Bytes())
	if len(dataURL) <= 8<<20 {
		t.Fatal("fixture must exceed the former MCP JSON request cap")
	}
	envelope := imageMCPCall(t, world, "alice", "tools/call", map[string]any{"name": "blok_upload_image", "arguments": map[string]any{"workspace": "equipe", "dataUrl": dataURL}})
	result, ok := envelope["result"].(map[string]any)
	if !ok || result["isError"] == true {
		t.Fatalf("large image upload refused: %v", envelope["error"])
	}
	content := result["content"].([]any)[0].(map[string]any)["text"].(string)
	var uploaded struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(content), &uploaded); err != nil || !strings.HasPrefix(uploaded.URL, "/files/") {
		t.Fatal("missing private image URL")
	}
	data, err := os.ReadFile(filepath.Join(world.service.Config.DataDirectory, "uploads", filepath.Base(uploaded.URL)))
	if err != nil {
		t.Fatal(err)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 2048 || config.Height != 1024 {
		t.Fatalf("capture dimensions lost: %+v %v", config, err)
	}
}

func TestMCPImageUploadHTTPSImportAndAuthorization(t *testing.T) {
	world := newReadsWorld(t)
	data, err := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNG, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	world.service.imageClient = &http.Client{Transport: imageRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("MCP credential leaked to image source")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data))}, nil
	})}
	envelope := imageMCPCall(t, world, "alice", "tools/call", map[string]any{"name": "blok_upload_image", "arguments": map[string]any{"workspace": "equipe", "url": "https://images.example.test/capture.png"}})
	result, ok := envelope["result"].(map[string]any)
	if !ok || result["isError"] == true || requests != 1 {
		t.Fatalf("HTTPS image import failed: %v", envelope)
	}
	if _, err := world.service.DB.Exec(world.ctx, `UPDATE memberships SET role='viewer' WHERE workspace_id='w' AND user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	envelope = imageMCPCall(t, world, "alice", "tools/call", map[string]any{"name": "blok_upload_image", "arguments": map[string]any{"workspace": "equipe", "url": "https://images.example.test/capture.png"}})
	result, ok = envelope["result"].(map[string]any)
	if !ok || result["isError"] != true || requests != 1 {
		t.Fatal("viewer image source must not be fetched")
	}
	for _, args := range []map[string]any{
		{"workspace": "equipe", "filePath": "/Users/anyone/capture.png"},
		{"workspace": "equipe", "filePath": "/Users/anyone/capture.png", "dataUrl": tinyPNG},
		{"workspace": "equipe", "url": "https://images.example.test/capture.png", "dataUrl": tinyPNG},
	} {
		envelope = imageMCPCall(t, world, "bob", "tools/call", map[string]any{"name": "blok_upload_image", "arguments": args})
		result, _ := envelope["result"].(map[string]any)
		if envelope["error"] == nil && result["isError"] != true {
			t.Fatal("invalid image source combination accepted")
		}
	}
}

func TestMCPImageUploadCancellationDuringDownload(t *testing.T) {
	world := newReadsWorld(t)
	ctx, cancel := context.WithCancel(context.WithValue(world.ctx, mcpUserKey{}, identity{User: User{ID: "alice"}}))
	defer cancel()
	world.service.imageClient = &http.Client{Transport: imageRoundTripFunc(func(*http.Request) (*http.Response, error) { cancel(); return nil, context.Canceled })}
	result, err := world.service.mcpUploadImage(ctx, mcpRequestFor(t, map[string]any{"workspace": "equipe", "url": "https://images.example.test/x.png"}))
	if err != nil || !result.IsError {
		t.Fatalf("cancellation not reported: %v", err)
	}
	encoded, _ := json.Marshal(result)
	if !bytes.Contains(encoded, []byte("Image upload canceled")) {
		t.Fatalf("lost cancellation: %s", encoded)
	}
}
