package blokmcp

import (
	"context"
	"errors"

	"github.com/JackUait/blok/packages/server/go/v2/blokagent"
)

// Each call binds its authenticated principal, independently of the actor's
// attribution fields. A contract-only target has no caller and cannot do IO.
type roomPageTarget struct {
	server *Server
	who    *caller
}

func (p roomPageTarget) Resolve(ctx context.Context, pageID string, _ blokagent.Actor) (blokagent.PageLocation, error) {
	if p.who == nil || !validPageID(pageID) {
		return nil, surfaceError("FORBIDDEN", "You may not write this page document.")
	}
	allowed, err := p.server.allowed(ctx, p.who.principal, pageID, true)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, surfaceError("FORBIDDEN", "You may not write this page document.")
	}
	return blokagent.RoomPage{DocID: pageID}, nil
}

type roomPageCreator struct{ roomPageTarget }

func (p roomPageCreator) Create(ctx context.Context, actor blokagent.Actor) (string, error) {
	return p.CreateFor(ctx, blokagent.PageCreateRequest{Actor: actor})
}

func (p roomPageCreator) CreateFor(ctx context.Context, request blokagent.PageCreateRequest) (string, error) {
	if p.who == nil || request.ParentDocumentID == "" {
		return "", nil
	}
	// Use the same attribution and identity as the stored-mode hook.
	bound := pageCreateRequest(request.ParentDocumentID, p.who)
	if validPageID(request.SuggestedPageID) {
		bound.SuggestedPageID = request.SuggestedPageID
	}
	id, err := p.server.options.CreatePage(ctx, bound)
	switch {
	case errors.Is(err, ErrPageRefused):
		return "", nil
	case err != nil && ctx.Err() != nil:
		return "", ctx.Err()
	case err != nil:
		logf("the host could not create a page: %v", err)
	case !validPageID(id):
		logf("the host page creator answered an invalid page id: %q", id)
	default:
		return id, nil
	}
	return "", surfaceError("SOURCE_UNAVAILABLE", hostPageFailed)
}
