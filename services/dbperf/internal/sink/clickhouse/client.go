// Package clickhouse is layer 3: it buffers scraper batches and inserts them
// into ClickHouse in large batches.
package clickhouse

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"

	ch "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
)

// Open connects to ClickHouse with the native protocol and LZ4 compression.
func Open(ctx context.Context, cfg config.ClickHouse) (driver.Conn, error) {
	conn, err := ch.Open(&ch.Options{
		Addr: cfg.Addrs,
		Auth: ch.Auth{Database: cfg.Database, Username: cfg.User, Password: cfg.Password},
		Compression: &ch.Compression{Method: ch.CompressionLZ4},
		DialTimeout:  cfg.DialTimeout,
		MaxOpenConns: cfg.MaxOpenConns,
		MaxIdleConns: cfg.MaxOpenConns,
		Settings:     ch.Settings{"max_execution_time": 60},
	})
	if err != nil {
		return nil, fmt.Errorf("clickhouse open: %w", err)
	}
	pctx, cancel := context.WithTimeout(ctx, cfg.DialTimeout)
	defer cancel()
	if err := conn.Ping(pctx); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	return conn, nil
}

// Table names.
const (
	TableActivity = "pg_activity"
	TableSamples  = "pg_samples"
	TableTexts    = "pg_query_texts"
)

// chWriter inserts pending batches with clickhouse-go.
type chWriter struct {
	conn driver.Conn
	db   string
}

func (w *chWriter) writeActivity(ctx context.Context, b *pending) error {
	batch, err := w.conn.PrepareBatch(ctx, "INSERT INTO "+w.db+"."+TableActivity)
	if err != nil {
		return err
	}
	for i := range b.rows {
		r := &b.rows[i]
		if err := batch.Append(
			r.TargetID, r.TS, r.PID, r.LeaderPID,
			r.BackendType, r.Datname, r.Usename, r.ApplicationName,
			ipv6(r.ClientAddr),
			r.State, r.WaitEventType, r.WaitEvent,
			chTime(r.BackendStart), chTime(r.XactStart), chTime(r.QueryStart), chTime(r.StateChange),
			r.QueryHash,
		); err != nil {
			return err
		}
	}
	return batch.Send()
}

func (w *chWriter) writeSamples(ctx context.Context, b *pending) error {
	batch, err := w.conn.PrepareBatch(ctx, "INSERT INTO "+w.db+"."+TableSamples)
	if err != nil {
		return err
	}
	for i := range b.markers {
		m := &b.markers[i]
		if err := batch.Append(m.TargetID, m.TS, m.NActive, m.DurationMs); err != nil {
			return err
		}
	}
	return batch.Send()
}

func (w *chWriter) writeTexts(ctx context.Context, b *pending) error {
	batch, err := w.conn.PrepareBatch(ctx, "INSERT INTO "+w.db+"."+TableTexts)
	if err != nil {
		return err
	}
	for i := range b.texts {
		t := &b.texts[i]
		if err := batch.Append(t.TargetID, t.QueryHash, t.Query, t.LastSeen); err != nil {
			return err
		}
	}
	return batch.Send()
}

func ipv6(a netip.Addr) net.IP {
	if !a.IsValid() {
		return net.IPv6zero
	}
	b := a.As16()
	return net.IP(b[:])
}

// chTime maps the zero time to the DateTime epoch instead of year 1.
func chTime(t time.Time) time.Time {
	if t.IsZero() {
		return time.Unix(0, 0).UTC()
	}
	return t
}
