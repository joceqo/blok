package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func workspacePNG(t *testing.T, width, height int, compression png.CompressionLevel) []byte {
	t.Helper()
	picture := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			picture.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 41, A: uint8(128 + x%127)})
		}
	}
	var out bytes.Buffer
	encoder := png.Encoder{CompressionLevel: compression}
	if err := encoder.Encode(&out, picture); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func workspaceImageDataURL(mime string, data []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func TestWorkspaceImageAcceptsLargerSource(t *testing.T) {
	data := workspacePNG(t, 1800, 900, png.NoCompression)
	if len(data) <= 5<<20 {
		t.Fatal("fixture does not exceed the old image limit")
	}
	if _, _, err := decodeWorkspaceImage(workspaceImageDataURL("image/png", data), maxWorkspaceImage); err != nil {
		t.Fatalf("a readable 6 MiB screenshot must be accepted: %v", err)
	}
}

func TestWorkspaceImageRejectsExcessiveDimensions(t *testing.T) {
	for _, size := range [][2]uint32{{16385, 1}, {1, 16385}, {8000, 8000}} {
		data := workspacePNG(t, 1, 1, png.DefaultCompression)
		binary.BigEndian.PutUint32(data[16:20], size[0])
		binary.BigEndian.PutUint32(data[20:24], size[1])
		binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
		if _, _, err := decodeWorkspaceImage(workspaceImageDataURL("image/png", data), maxWorkspaceImage); err == nil {
			t.Fatalf("accepted oversized image dimensions %dx%d", size[0], size[1])
		}
	}
}

func TestWorkspaceImageRejectsTruncatedHeader(t *testing.T) {
	data := workspacePNG(t, 1, 1, png.DefaultCompression)
	if _, _, err := decodeWorkspaceImage(workspaceImageDataURL("image/png", data[:20]), maxWorkspaceImage); err == nil {
		t.Fatal("accepted sniffable PNG magic without a decodable image header")
	}
}

func TestWorkspaceImageOptimizesWithoutChangingPixels(t *testing.T) {
	source := workspacePNG(t, 96, 64, png.NoCompression)
	data, extension, err := prepareWorkspaceImage(context.Background(), workspaceImageDataURL("image/png", source), maxWorkspaceImage)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) >= len(source) || extension != ".png" {
		t.Fatalf("expected a smaller PNG, got %d from %d", len(data), len(source))
	}
	before, err := png.Decode(bytes.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	after, err := png.Decode(bytes.NewReader(data))
	if err != nil || before.Bounds() != after.Bounds() {
		t.Fatalf("image bounds changed: %v", err)
	}
	for y := 0; y < 64; y++ {
		for x := 0; x < 96; x++ {
			if before.At(x, y) != after.At(x, y) {
				t.Fatalf("color or transparency changed at %d,%d", x, y)
			}
		}
	}
}

func TestWorkspaceImagePreservesAnimatedFormatsAndJPEG(t *testing.T) {
	palette := color.Palette{color.Transparent, color.NRGBA{R: 220, A: 255}}
	frame := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
	frame.SetColorIndex(1, 1, 1)
	var animatedGIF bytes.Buffer
	if err := gif.EncodeAll(&animatedGIF, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{10, 20}, LoopCount: 0}); err != nil {
		t.Fatal(err)
	}
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, frame, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		mime string
		data []byte
	}{
		{"image/gif", animatedGIF.Bytes()},
		{"image/jpeg", jpegData.Bytes()},
	}
	// Generated 2x2 lossless, alpha and animated WebP fixtures.
	for _, fixture := range []string{
		"UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAEAdQsmqVtsiBiOh/AAA=",
		"UklGRlQAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAyMjIyABWUDggKAAAAHABAJ0BKgIAAgABQCYloAJ0AUAAAP7r3i/8s//2W/7LeM/XFzZDeAA=",
		"UklGRtYAAABXRUJQVlA4WAoAAAASAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GTgAAAAAAAAAAAAEAAAEAAGQAAAJBTFBIBQAAAADIyMjIAFZQOCAoAAAAMAEAnQEqAgACAAFAJiWgAANwAP7r3i//+Wf/7Lf9lvGf/wbJFNdgAEFOTUZUAAAAAAAAAAAAAQAAAQAAlgAAAkFMUEgFAAAAAEZGRkYAVlA4IC4AAAAwAQCdASoCAAIAAUAmJaAAA3AA/vohl///MvP/+Whf/5aF/zLz//Fv2j+9tiAA",
	} {
		data, err := base64.StdEncoding.DecodeString(fixture)
		if err != nil {
			t.Fatal(err)
		}
		cases = append(cases, struct {
			mime string
			data []byte
		}{"image/webp", data})
	}
	for _, tc := range cases {
		actual, _, err := prepareWorkspaceImage(context.Background(), workspaceImageDataURL(tc.mime, tc.data), maxWorkspaceImage)
		if err != nil || !bytes.Equal(actual, tc.data) {
			t.Fatalf("changed original %s bytes or refused the image: %v", tc.mime, err)
		}
	}
}

func pngWithChunk(source []byte, name string, payload []byte) []byte {
	var chunk bytes.Buffer
	binary.Write(&chunk, binary.BigEndian, uint32(len(payload)))
	chunk.WriteString(name)
	chunk.Write(payload)
	binary.Write(&chunk, binary.BigEndian, crc32.ChecksumIEEE(chunk.Bytes()[4:]))
	data := append([]byte{}, source[:33]...)
	data = append(data, chunk.Bytes()...)
	return append(data, source[33:]...)
}

func TestWorkspaceImagePreservesPNGColorMetadataAndAnimation(t *testing.T) {
	source := workspacePNG(t, 32, 32, png.NoCompression)
	for name, payload := range map[string][]byte{"gAMA": {0, 0, 177, 143}, "acTL": {0, 0, 0, 1, 0, 0, 0, 0}} {
		original := pngWithChunk(source, name, payload)
		actual, _, err := prepareWorkspaceImage(context.Background(), workspaceImageDataURL("image/png", original), maxWorkspaceImage)
		if err != nil || !bytes.Equal(actual, original) {
			t.Fatalf("changed PNG %s metadata: %v", name, err)
		}
	}
}

func TestWorkspaceImageDoesNotExpandSmallImages(t *testing.T) {
	source, _, err := decodeWorkspaceImage(tinyPNG, maxWorkspaceImage)
	if err != nil {
		t.Fatal(err)
	}
	actual, _, err := prepareWorkspaceImage(context.Background(), tinyPNG, maxWorkspaceImage)
	if err != nil || len(actual) > len(source) {
		t.Fatalf("expanded a tiny image: %v", err)
	}
}

func TestWorkspaceImageRejectsCorruptPixelData(t *testing.T) {
	data := workspacePNG(t, 8, 8, png.NoCompression)
	data[len(data)-15] ^= 1
	if _, _, err := prepareWorkspaceImage(context.Background(), workspaceImageDataURL("image/png", data), maxWorkspaceImage); !errors.Is(err, ErrWorkspaceImage) {
		t.Fatalf("expected image validation error, got %v", err)
	}
}

func TestWorkspaceImageHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := prepareWorkspaceImage(ctx, tinyPNG, maxWorkspaceImage); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestWorkspaceImageBoundsOtherFormats(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 2, 2))
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, frame, nil); err != nil {
		t.Fatal(err)
	}
	jpegBytes := jpegData.Bytes()
	sof := bytes.Index(jpegBytes, []byte{0xff, 0xc0})
	if sof < 0 {
		t.Fatal("JPEG frame header missing")
	}
	binary.BigEndian.PutUint16(jpegBytes[sof+5:sof+7], 8000)
	binary.BigEndian.PutUint16(jpegBytes[sof+7:sof+9], 8000)
	var gifData bytes.Buffer
	if err := gif.Encode(&gifData, frame, nil); err != nil {
		t.Fatal(err)
	}
	gifBytes := gifData.Bytes()
	binary.LittleEndian.PutUint16(gifBytes[6:8], 8000)
	binary.LittleEndian.PutUint16(gifBytes[8:10], 8000)
	webpBytes, err := base64.StdEncoding.DecodeString("UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAEAdQsmqVtsiBiOh/AAA=")
	if err != nil {
		t.Fatal(err)
	}
	binary.LittleEndian.PutUint32(webpBytes[21:25], 8191|8191<<14|1<<28)
	for _, tc := range []struct {
		mime string
		data []byte
	}{{"image/jpeg", jpegBytes}, {"image/gif", gifBytes}, {"image/webp", webpBytes}} {
		if _, _, err := decodeWorkspaceImage(workspaceImageDataURL(tc.mime, tc.data), maxWorkspaceImage); err == nil {
			t.Fatalf("accepted %s with more than 48 MP", tc.mime)
		}
	}
}
