<<<<<<< HEAD
package cloud

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// Only explicitly trusted network peers can supply forwarded client IPs.
// Walk from the closest hop towards the client, stopping at the first
// untrusted address, so a caller cannot choose their own rate-limit key.
func (s *Service) clientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return host
	}
	trusted := func(ip netip.Addr) bool {
		for _, raw := range s.Config.TrustedProxyCIDRs {
			p, e := netip.ParsePrefix(strings.TrimSpace(raw))
			if e == nil && p.Contains(ip.Unmap()) {
				return true
			}
		}
		return false
	}
	if !trusted(peer) {
		return peer.String()
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		ip, e := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if e != nil {
			return peer.String()
		}
		peer = ip
		if !trusted(ip) {
			return ip.String()
		}
	}
	return peer.String()
}
func (s *Service) startAccessSweep() {
	ctx, cancel := context.WithCancel(context.Background())
	s.accessCancel = cancel
	s.accessDone = make(chan struct{})
	go func() {
		defer close(s.accessDone)
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				s.recheckObserved(ctx)
			}
		}
	}()
}
func (s *Service) stopAccessSweep() {
	if s.accessCancel != nil {
		s.accessCancel()
		<-s.accessDone
	}
}
func (s *Service) observeDocument(doc string) func() {
	s.observedMu.Lock()
	s.observed[doc]++
	s.observedMu.Unlock()
	return func() {
		s.observedMu.Lock()
		s.observed[doc]--
		if s.observed[doc] <= 0 {
			delete(s.observed, doc)
		}
		s.observedMu.Unlock()
	}
}
func (s *Service) isObserved(doc string) bool {
	s.observedMu.Lock()
	defer s.observedMu.Unlock()
	return s.observed[doc] > 0
}
func (s *Service) recheckObserved(ctx context.Context) error {
	s.observedMu.Lock()
	docs := make([]string, 0, len(s.observed))
	for doc := range s.observed {
		docs = append(docs, doc)
	}
	s.observedMu.Unlock()
	var result error
	for _, doc := range docs {
		if err := ctx.Err(); err != nil {
			return errors.Join(result, err)
		}
		result = errors.Join(result, s.recheckDocument(ctx, doc))
	}
	return result
}

func (s *Service) recheckSessionAccess(w http.ResponseWriter, r *http.Request) {
	if !internalAuth(r, s.Config.InternalSecret) {
		problem(w, http.StatusUnauthorized, "Internal authorization required")
		return
	}
	if err := s.recheckObserved(r.Context()); err != nil {
		problem(w, http.StatusServiceUnavailable, "Collaboration access recheck failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Service) recheckDocument(ctx context.Context, doc string) error {
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	owned, err := s.nodeOwnsRoom(bounded, doc)
	if err != nil {
		return err
	}
	if owned {
		err = s.recheckNodeRoom(bounded, doc)
	} else {
		_, err = s.Blok.RecheckAccess(bounded, doc)
	}
	if err != nil && ctx.Err() == nil {
		slog.Error("collaboration access recheck failed", "document", doc, "error", err)
	}
	return err
}

func (s *Service) recheckWorkspace(ctx context.Context, workspace string) error {
	rows, err := s.DB.Query(ctx, "SELECT id FROM pages WHERE workspace_id=$1", workspace)
	if err != nil {
		slog.Error("access recheck query failed", "error", err)
		return err
	}
	defer rows.Close()
	var docs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		if s.isObserved(id) {
			docs = append(docs, id)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var result error
	for _, doc := range docs {
		if err := ctx.Err(); err != nil {
			return errors.Join(result, err)
		}
		result = errors.Join(result, s.recheckDocument(ctx, doc))
	}
	return result
}

func (s *Service) recheckWorkspaceAccess(w http.ResponseWriter, r *http.Request) {
	if !internalAuth(r, s.Config.InternalSecret) {
		problem(w, http.StatusUnauthorized, "Internal authorization required")
		return
	}
	if err := s.recheckWorkspace(r.Context(), r.PathValue("id")); err != nil {
		problem(w, http.StatusServiceUnavailable, "Collaboration access recheck failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
||||||| f8ef3c6b39
=======
package cloud

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// Only explicitly trusted network peers can supply forwarded client IPs.
// Walk from the closest hop towards the client, stopping at the first
// untrusted address, so a caller cannot choose their own rate-limit key.
func (s *Service) clientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return host
	}
	trusted := func(ip netip.Addr) bool {
		for _, raw := range s.Config.TrustedProxyCIDRs {
			p, e := netip.ParsePrefix(strings.TrimSpace(raw))
			if e == nil && p.Contains(ip.Unmap()) {
				return true
			}
		}
		return false
	}
	if !trusted(peer) {
		return peer.String()
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		ip, e := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if e != nil {
			return peer.String()
		}
		peer = ip
		if !trusted(ip) {
			return ip.String()
		}
	}
	return peer.String()
}
func (s *Service) startAccessSweep() {
	ctx, cancel := context.WithCancel(context.Background())
	s.accessCancel = cancel
	s.accessDone = make(chan struct{})
	go func() {
		defer close(s.accessDone)
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				s.recheckObserved(ctx)
			}
		}
	}()
}
func (s *Service) stopAccessSweep() {
	if s.accessCancel != nil {
		s.accessCancel()
		<-s.accessDone
	}
}
func (s *Service) observeDocument(doc string) func() {
	s.observedMu.Lock()
	s.observed[doc]++
	s.observedMu.Unlock()
	return func() {
		s.observedMu.Lock()
		s.observed[doc]--
		if s.observed[doc] <= 0 {
			delete(s.observed, doc)
		}
		s.observedMu.Unlock()
	}
}
func (s *Service) isObserved(doc string) bool {
	s.observedMu.Lock()
	defer s.observedMu.Unlock()
	return s.observed[doc] > 0
}
func (s *Service) recheckObserved(ctx context.Context) {
	s.observedMu.Lock()
	docs := make([]string, 0, len(s.observed))
	for doc := range s.observed {
		docs = append(docs, doc)
	}
	s.observedMu.Unlock()
	for _, doc := range docs {
		if ctx.Err() != nil {
			return
		}
		s.recheckDocument(ctx, doc)
	}
}
func (s *Service) recheckDocument(ctx context.Context, doc string) {
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, e := s.Blok.RecheckAccess(bounded, doc); e != nil && ctx.Err() == nil {
		slog.Error("collaboration access recheck failed", "document", doc, "error", e)
	}
}
func (s *Service) recheckWorkspace(ctx context.Context, workspace string) {
	rows, e := s.DB.Query(ctx, "SELECT id FROM pages WHERE workspace_id=$1", workspace)
	if e != nil {
		slog.Error("access recheck query failed", "error", e)
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if s.isObserved(id) {
			s.recheckDocument(ctx, id)
		}
	}
}
>>>>>>> origin/fix/self-host-review
