package cloud

import (
	"context"
	"errors"
)

// Normal hosts share this lock; the offline migration takes it exclusively.
// Scope it to the PostgreSQL schema so isolated instances do not block each other.
func (s *Service) acquireRowBodyGuard(ctx context.Context) error {
	conn, err := s.DB.Acquire(ctx)
	if err != nil {
		return err
	}
	var acquired bool
	err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock_shared(774839103,hashtext(current_schema()))`).Scan(&acquired)
	if err != nil || !acquired {
		conn.Release()
		if err != nil {
			return err
		}
		return errors.New("row-body maintenance is running; start the service after it finishes")
	}
	s.maintenanceGuard = conn
	return nil
}

func (s *Service) releaseRowBodyGuard() {
	if s.maintenanceGuard == nil {
		return
	}
	conn := s.maintenanceGuard
	s.maintenanceGuard = nil
	conn.Exec(context.Background(), `SELECT pg_advisory_unlock_shared(774839103,hashtext(current_schema()))`)
	conn.Release()
}
