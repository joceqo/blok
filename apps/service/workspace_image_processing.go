package cloud

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image/png"
	"io"
)

// ErrWorkspaceImage distinguishes caller-controlled image validation from a
// failure to persist an otherwise valid image.
var ErrWorkspaceImage = errors.New("invalid workspace image")

const maxWorkspaceImageDimension = 16384
const maxWorkspaceImagePixels = 48_000_000
const maxWorkspaceImageRequest = 36 << 20

// A decoded 48 MP PNG can occupy hundreds of MiB. Only one upload at a time
// may decode pixels; the others can leave the queue through their context.
var workspaceImageProcessing = make(chan struct{}, 1)

func prepareWorkspaceImage(ctx context.Context, raw string, limit int) ([]byte, string, error) {
	select {
	case <-ctx.Done():
		return nil, "", ctx.Err()
	case workspaceImageProcessing <- struct{}{}:
	}
	defer func() { <-workspaceImageProcessing }()
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	data, extension, err := decodeWorkspaceImage(raw, limit)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrWorkspaceImage, err)
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	if extension != ".png" {
		return data, extension, nil
	}
	canReencode, err := reencodablePNG(ctx, data)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", fmt.Errorf("%w: %v", ErrWorkspaceImage, err)
	}
	// Preserve animation and color interpretation. Also avoid the larger pixel
	// allocation of a very large 16-bit PNG; it can be stored unchanged.
	width, height := binary.BigEndian.Uint32(data[16:20]), binary.BigEndian.Uint32(data[20:24])
	if data[24] == 16 && uint64(width)*uint64(height) > maxWorkspaceImagePixels/2 {
		return data, extension, nil
	}
	picture, err := png.Decode(&contextImageReader{ctx, bytes.NewReader(data)})
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", fmt.Errorf("%w: malformed PNG pixels", ErrWorkspaceImage)
	}
	if !canReencode {
		return data, extension, nil
	}
	var optimized bytes.Buffer
	writer := &contextImageWriter{ctx: ctx, buffer: &optimized, limit: len(data)}
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	err = encoder.Encode(writer, picture)
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}
	if errors.Is(err, errImageWouldExpand) {
		return data, extension, nil
	}
	if err != nil {
		return nil, "", err
	}
	if optimized.Len() < len(data) {
		return optimized.Bytes(), extension, nil
	}
	return data, extension, nil
}

// Validate the chunk envelope before deciding whether encoding could discard
// animation or color metadata. PNG.Decode alone reads only the default image.
func reencodablePNG(ctx context.Context, data []byte) (bool, error) {
	canReencode := true
	for offset := 8; offset+12 <= len(data); {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		length := uint64(binary.BigEndian.Uint32(data[offset : offset+4]))
		end := uint64(offset) + length + 12
		if end > uint64(len(data)) {
			return false, errors.New("truncated PNG chunk")
		}
		chunk := data[offset+4 : int(end)-4]
		if crc32.ChecksumIEEE(chunk) != binary.BigEndian.Uint32(data[int(end)-4:int(end)]) {
			return false, errors.New("invalid PNG checksum")
		}
		switch string(chunk[:4]) {
		case "acTL", "iCCP", "sRGB", "gAMA", "cHRM", "cICP", "eXIf", "pHYs", "sBIT", "bKGD":
			canReencode = false
		case "IEND":
			return canReencode, nil
		}
		offset = int(end)
	}
	return false, errors.New("incomplete PNG")
}

type contextImageReader struct {
	ctx    context.Context
	source io.Reader
}

func (r *contextImageReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(data)
}

var errImageWouldExpand = errors.New("optimized image would grow")

type contextImageWriter struct {
	ctx    context.Context
	buffer *bytes.Buffer
	limit  int
}

func (w *contextImageWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if len(data) > w.limit-w.buffer.Len() {
		return 0, errImageWouldExpand
	}
	return w.buffer.Write(data)
}
