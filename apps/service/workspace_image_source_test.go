package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

type imageRoundTripFunc func(*http.Request) (*http.Response, error)

func (f imageRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRemoteWorkspaceImagePublicAddresses(t *testing.T) {
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"} {
		if !publicWorkspaceImageIP(netip.MustParseAddr(raw)) {
			t.Fatalf("public address rejected: %s", raw)
		}
	}
	for _, raw := range []string{"0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "fec0::1", "3fff::1"} {
		if publicWorkspaceImageIP(netip.MustParseAddr(raw)) {
			t.Fatalf("private/reserved address accepted: %s", raw)
		}
	}
}

func TestRemoteWorkspaceImagePinsValidatedDNS(t *testing.T) {
	calls := 0
	dialed := ""
	client := newWorkspaceImageHTTPClient(func(context.Context, string) ([]netip.Addr, error) {
		calls++
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}, func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialed = address
		return nil, errors.New("fixture stops before connecting")
	})
	_, _ = client.Transport.(*http.Transport).DialContext(context.Background(), "tcp", "images.example.test:443")
	if calls != 1 || dialed != "8.8.8.8:443" {
		t.Fatalf("DNS was not pinned: %d %s", calls, dialed)
	}
	client = newWorkspaceImageHTTPClient(func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	}, func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("mixed public/private DNS must not dial")
		return nil, nil
	})
	if _, err := client.Transport.(*http.Transport).DialContext(context.Background(), "tcp", "images.example.test:443"); err == nil {
		t.Fatal("private DNS result accepted")
	}
}

func TestRemoteWorkspaceImageDownload(t *testing.T) {
	data, err := base64.StdEncoding.DecodeString(strings.SplitN(tinyPNG, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: imageRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("credentials forwarded to image source")
		}
		if r.Header.Get("Accept-Encoding") != "identity" {
			t.Fatal("source may be transparently decompressed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data))}, nil
	})}
	raw, err := downloadWorkspaceImage(context.Background(), "https://images.example.test/dashboard.png", client, len(data))
	if err != nil || raw != tinyPNG {
		t.Fatalf("image import failed: %v", err)
	}
	for _, input := range []string{"http://images.example.test/x", "file:///tmp/x", "https://user:secret@images.example.test/x", "https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://images.example.test/x#fragment"} {
		if _, err := downloadWorkspaceImage(context.Background(), input, client, len(data)); err == nil {
			t.Fatalf("unsafe URL accepted: %s", input)
		}
	}
	if _, err := downloadWorkspaceImage(context.Background(), "https://images.example.test/x", client, len(data)-1); err == nil {
		t.Fatal("oversized content length accepted")
	}
}

func TestRemoteWorkspaceImageRejectsRedirectsAndUnboundedStreams(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		length int64
	}{
		{"redirect", 302, "", 0}, {"missing", 404, "", 0}, {"html", 200, "<html>not an image</html>", -1}, {"oversized stream", 200, strings.Repeat("x", 65), -1},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: imageRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: test.status, Header: http.Header{"Location": []string{"https://127.0.0.1/secret"}}, Body: io.NopCloser(strings.NewReader(test.body)), ContentLength: test.length}, nil
			}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			if _, err := downloadWorkspaceImage(context.Background(), "https://images.example.test/x", client, 64); err == nil {
				t.Fatal("invalid image source accepted")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := downloadWorkspaceImage(ctx, "https://images.example.test/x", nil, 64); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}
