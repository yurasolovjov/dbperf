// Package grpc implements TargetRegistry and LeaseService over the store.
package grpc

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
	"github.com/yurasolovjov/dbperf/services/registry/internal/store"
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func toProto(t store.Target) *registryv1.Target {
	return &registryv1.Target{
		TargetId: t.ID, Name: t.Name, Dsn: t.DSN, IntervalSec: t.IntervalSec, StatementTimeoutMs: t.StatementTimeoutMs,
		Enabled: t.Enabled, Labels: t.Labels, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt, Revision: t.Revision,
	}
}

// validate checks the fields a client may set and fills defaults.
func validate(t *store.Target) error {
	if !nameRe.MatchString(t.Name) {
		return status.Error(codes.InvalidArgument, "name: 1..128 characters of [A-Za-z0-9._-]")
	}
	u, err := url.Parse(t.DSN)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host == "" {
		return status.Error(codes.InvalidArgument, "dsn: expected postgres://user:pass@host:port/db")
	}
	if t.IntervalSec == 0 {
		t.IntervalSec = 10
	}
	if t.IntervalSec < 1 || t.IntervalSec > 3600 {
		return status.Error(codes.InvalidArgument, "interval_sec: 1..3600")
	}
	if t.StatementTimeoutMs == 0 {
		t.StatementTimeoutMs = 5000
	}
	if t.StatementTimeoutMs < 100 || t.StatementTimeoutMs > 600000 {
		return status.Error(codes.InvalidArgument, "statement_timeout_ms: 100..600000")
	}
	return nil
}

func storeErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, store.ErrNotFound):
		return status.Error(codes.NotFound, "target not found")
	case errors.Is(err, store.ErrAlreadyExists):
		return status.Error(codes.AlreadyExists, "name already exists")
	case errors.Is(err, store.ErrRevision):
		return status.Error(codes.FailedPrecondition, "revision mismatch")
	case errors.Is(err, store.ErrConflict):
		return status.Error(codes.Aborted, "transaction conflict, retry")
	case errors.Is(err, store.ErrSession):
		return status.Error(codes.Aborted, "session expired")
	}
	if _, ok := status.FromError(err); ok {
		return err
	}
	return status.Error(codes.Unavailable, err.Error())
}

func sessionID(leaseID int64) string { return strconv.FormatInt(leaseID, 16) }

func parseSession(s string) (int64, error) {
	v, err := strconv.ParseInt(s, 16, 64)
	if err != nil || v == 0 {
		return 0, status.Error(codes.PermissionDenied, "bad session_id")
	}
	return v, nil
}
