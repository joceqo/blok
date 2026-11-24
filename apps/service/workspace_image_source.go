package cloud

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var errRemoteWorkspaceImage = errors.New("use a public HTTPS PNG, JPEG, GIF or WebP image within the upload limit; authenticated sources, private addresses and redirects are refused")

var publicImageIPv6 = netip.MustParsePrefix("2000::/3")

var reservedImageNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("::/96"), netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3fff::/20"),
}

func publicWorkspaceImageIP(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	if address.Is6() && !publicImageIPv6.Contains(address) {
		return false
	}
	for _, network := range reservedImageNetworks {
		if network.Contains(address) {
			return false
		}
	}
	return true
}

// DNS is checked once and the connection is made to that exact public IP.
// No environment proxy, credential forwarding or redirects can bypass the check.
func newWorkspaceImageHTTPClient(lookup func(context.Context, string) ([]netip.Addr, error), dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	if dial == nil {
		dial = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	transport := &http.Transport{DisableCompression: true, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 64 << 10, MaxIdleConns: 8, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, target string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(target)
		if err != nil {
			return nil, errRemoteWorkspaceImage
		}
		addresses, err := lookup(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, errRemoteWorkspaceImage
		}
		for _, address := range addresses {
			if !publicWorkspaceImageIP(address) {
				return nil, errRemoteWorkspaceImage
			}
		}
		for _, address := range addresses {
			conn, err := dial(ctx, network, net.JoinHostPort(address.Unmap().String(), port))
			if err == nil {
				return conn, nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
		}
		return nil, errRemoteWorkspaceImage
	}
	return &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func downloadWorkspaceImage(ctx context.Context, raw string, client *http.Client, limit int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	parsed, err := url.Parse(raw)
	if err != nil || len(raw) > 4096 || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.Hostname() == "" {
		return "", errRemoteWorkspaceImage
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "", errRemoteWorkspaceImage
	}
	if address, err := netip.ParseAddr(host); err == nil && !publicWorkspaceImageIP(address) {
		return "", errRemoteWorkspaceImage
	}
	if client == nil {
		client = newWorkspaceImageHTTPClient(nil, nil)
		defer client.CloseIdleConnections()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", errRemoteWorkspaceImage
	}
	request.Header.Set("Accept", "image/png, image/jpeg, image/gif, image/webp")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errRemoteWorkspaceImage
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > int64(limit) {
		return "", errRemoteWorkspaceImage
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil || len(data) == 0 || len(data) > limit {
		return "", errRemoteWorkspaceImage
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
	default:
		return "", errRemoteWorkspaceImage
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}
