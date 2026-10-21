package registry

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// PostgresSource reads targets and leases from the dbperf_targets table of a
// metadata database. One pgconn connection, reconnected on error.
type PostgresSource struct {
	DSN             string
	DefaultInterval time.Duration
	DefaultTimeout  time.Duration
	LeaseTTL        time.Duration

	conn *pgconn.PgConn
}

// Schema is the DDL of the metadata table.
const Schema = `
CREATE TABLE IF NOT EXISTS dbperf_targets (
    target_id     int PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    dsn           text NOT NULL,
    interval_sec  int NOT NULL DEFAULT 10,
    enabled       bool NOT NULL DEFAULT true,
    owner         text,
    lease_until   timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dbperf_targets_lease_idx ON dbperf_targets (lease_until) WHERE enabled;
`

func (s *PostgresSource) connect(ctx context.Context) (*pgconn.PgConn, error) {
	if s.conn != nil && !s.conn.IsClosed() {
		return s.conn, nil
	}
	cfg, err := pgconn.ParseConfig(s.DSN)
	if err != nil {
		return nil, fmt.Errorf("registry dsn: %w", err)
	}
	cfg.RuntimeParams["application_name"] = "dbperf-registry"
	cfg.ConnectTimeout = 5 * time.Second
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("registry connect: %w", err)
	}
	s.conn = conn
	return conn, nil
}

func (s *PostgresSource) exec(ctx context.Context, sql string, args ...string) ([][][]byte, error) {
	conn, err := s.connect(ctx)
	if err != nil {
		return nil, err
	}
	params := make([][]byte, len(args))
	for i, a := range args {
		params[i] = []byte(a)
	}
	res := conn.ExecParams(ctx, sql, params, nil, nil, nil).Read()
	if res.Err != nil {
		_ = conn.Close(ctx)
		s.conn = nil
		return nil, res.Err
	}
	return res.Rows, nil
}

// EnsureSchema creates the metadata table.
func (s *PostgresSource) EnsureSchema(ctx context.Context) error {
	conn, err := s.connect(ctx)
	if err != nil {
		return err
	}
	_, err = conn.Exec(ctx, Schema).ReadAll()
	return err
}

// List implements TargetSource.
func (s *PostgresSource) List(ctx context.Context) ([]Target, error) {
	rows, err := s.exec(ctx, `SELECT target_id, name, dsn, interval_sec, enabled FROM dbperf_targets ORDER BY target_id`)
	if err != nil {
		return nil, fmt.Errorf("list targets: %w", err)
	}
	out := make([]Target, 0, len(rows))
	for _, r := range rows {
		id, _ := strconv.ParseUint(string(r[0]), 10, 32)
		sec, _ := strconv.Atoi(string(r[3]))
		t := Target{
			ID:               uint32(id),
			Name:             string(r[1]),
			DSN:              string(r[2]),
			Interval:         time.Duration(sec) * time.Second,
			StatementTimeout: s.DefaultTimeout,
			Enabled:          string(r[4]) == "t",
		}
		if t.Interval <= 0 {
			t.Interval = s.DefaultInterval
		}
		out = append(out, t)
	}
	return out, nil
}

// Acquire implements Lease: keeps the targets already owned and takes free
// ones up to want in total. SKIP LOCKED lets several instances race safely.
func (s *PostgresSource) Acquire(ctx context.Context, instance string, want int) ([]uint32, error) {
	ttl := strconv.Itoa(int(s.LeaseTTL.Seconds()))
	owned, err := s.exec(ctx, `
		UPDATE dbperf_targets SET lease_until = now() + ($2 || ' seconds')::interval
		WHERE owner = $1 AND enabled
		RETURNING target_id`, instance, ttl)
	if err != nil {
		return nil, fmt.Errorf("renew owned: %w", err)
	}
	ids := make([]uint32, 0, want)
	for _, r := range owned {
		ids = append(ids, parseID(r[0]))
	}
	if free := want - len(ids); free > 0 {
		taken, err := s.exec(ctx, `
			UPDATE dbperf_targets t SET owner = $1, lease_until = now() + ($2 || ' seconds')::interval
			FROM (
				SELECT target_id FROM dbperf_targets
				WHERE enabled AND (owner IS NULL OR lease_until IS NULL OR lease_until < now())
				ORDER BY target_id
				LIMIT $3
				FOR UPDATE SKIP LOCKED
			) f
			WHERE t.target_id = f.target_id
			RETURNING t.target_id`, instance, ttl, strconv.Itoa(free))
		if err != nil {
			return nil, fmt.Errorf("acquire free: %w", err)
		}
		for _, r := range taken {
			ids = append(ids, parseID(r[0]))
		}
	}
	return ids, nil
}

// Renew implements Lease.
func (s *PostgresSource) Renew(ctx context.Context, instance string, ids []uint32) error {
	if len(ids) == 0 {
		return nil
	}
	ttl := strconv.Itoa(int(s.LeaseTTL.Seconds()))
	_, err := s.exec(ctx, `
		UPDATE dbperf_targets SET lease_until = now() + ($2 || ' seconds')::interval
		WHERE owner = $1 AND target_id = ANY($3::int[])`, instance, ttl, idArray(ids))
	return err
}

// Release implements Lease: frees every target of the instance so others can
// take them immediately.
func (s *PostgresSource) Release(ctx context.Context, instance string) error {
	_, err := s.exec(ctx, `UPDATE dbperf_targets SET owner = NULL, lease_until = NULL WHERE owner = $1`, instance)
	return err
}

// Close closes the connection.
func (s *PostgresSource) Close(ctx context.Context) {
	if s.conn != nil {
		_ = s.conn.Close(ctx)
		s.conn = nil
	}
}

func parseID(b []byte) uint32 {
	v, _ := strconv.ParseUint(string(b), 10, 32)
	return uint32(v)
}

func idArray(ids []uint32) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatUint(uint64(id), 10)
	}
	return "{" + strings.Join(parts, ",") + "}"
}
