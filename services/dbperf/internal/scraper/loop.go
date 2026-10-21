package scraper

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"math/rand/v2"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/registry"
)

// Metrics is the subset of telemetry the loop reports.
type Metrics interface {
	ObserveScrape(targetID uint32, d time.Duration, rows int, err error)
}

// Loop drives one target: one connection, one query per tick.
type Loop struct {
	target  registry.Target
	cfg     config.Scraper
	emit    Emitter
	status  *registry.StatusStore
	metrics Metrics
	log     *slog.Logger

	conn     *pgconn.PgConn
	version  int
	sql      string
	seen     *hashLRU
	backoff  time.Duration
	cancel   context.CancelFunc
	done     chan struct{}
}

func newLoop(t registry.Target, cfg config.Scraper, emit Emitter, status *registry.StatusStore, m Metrics, log *slog.Logger) *Loop {
	return &Loop{
		target:  t,
		cfg:     cfg,
		emit:    emit,
		status:  status,
		metrics: m,
		log:     log.With("target", t.Name, "target_id", t.ID),
		seen:    newHashLRU(cfg.QueryCacheSize),
		done:    make(chan struct{}),
	}
}

// start runs the loop in its own goroutine.
func (l *Loop) start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	l.cancel = cancel
	go func() {
		defer close(l.done)
		l.run(ctx)
	}()
}

// stop cancels the loop and waits for it to finish.
func (l *Loop) stop() {
	if l.cancel != nil {
		l.cancel()
	}
	<-l.done
}

func (l *Loop) run(ctx context.Context) {
	defer l.close()
	// Spread targets over the interval so an instance does not fire all its
	// queries in the same second.
	phase := time.Duration(phaseOf(l.target.ID)) % l.target.Interval
	select {
	case <-ctx.Done():
		return
	case <-time.After(phase):
	}
	ticker := time.NewTicker(l.target.Interval)
	defer ticker.Stop()
	l.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.tick(ctx)
		}
	}
}

func (l *Loop) tick(ctx context.Context) {
	if l.conn == nil || l.conn.IsClosed() {
		if !l.reconnect(ctx) {
			return
		}
	}
	ts := time.Now().UTC().Truncate(time.Second)
	started := time.Now()
	qctx, cancel := context.WithTimeout(ctx, l.target.StatementTimeout+time.Second)
	rows, err := l.collect(qctx, ts)
	cancel()
	dur := time.Since(started)
	l.metrics.ObserveScrape(l.target.ID, dur, len(rows), err)
	if err != nil {
		l.fail(err)
		l.close()
		return
	}
	l.status.Update(l.target.ID, func(s *registry.Status) {
		s.State = registry.StateConnected
		s.DisconnectedSince = time.Time{}
		s.LastError = ""
		s.LastSampleAt = ts
		s.LastSampleDurationMs = int32(min(dur.Milliseconds(), 65535))
	})
}

func (l *Loop) collect(ctx context.Context, ts time.Time) ([]ActivityRow, error) {
	res := l.conn.ExecParams(ctx, l.sql, nil, nil, nil, []int16{0}).Read()
	if res.Err != nil {
		return nil, res.Err
	}
	rows, err := parseRows(l.target.ID, ts, res.Rows)
	if err != nil {
		return nil, err
	}
	b := Batch{
		Marker: SampleMarker{TargetID: l.target.ID, TS: ts, NActive: uint16(min(len(rows), 65535)), DurationMs: uint16(min(time.Since(ts).Milliseconds(), 65535))},
		Rows:   rows,
	}
	for i := range rows {
		if l.seen.Touch(rows[i].QueryHash) {
			b.Texts = append(b.Texts, QueryText{TargetID: l.target.ID, QueryHash: rows[i].QueryHash, Query: rows[i].QueryText, LastSeen: ts})
		}
		rows[i].QueryText = "" // the sink does not need it per row
	}
	l.emit.Emit(b)
	return rows, nil
}

func (l *Loop) reconnect(ctx context.Context) bool {
	if l.backoff > 0 {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(l.backoff):
		}
	}
	cctx, cancel := context.WithTimeout(ctx, l.cfg.ConnectTimeout+l.cfg.StatementTimeout)
	defer cancel()
	conn, version, err := connect(cctx, l.target, l.cfg)
	if err != nil {
		l.fail(err)
		l.bumpBackoff()
		return false
	}
	l.conn = conn
	l.version = version
	l.sql = activitySQL(version, l.cfg.QueryMaxLen, conn.PID())
	l.backoff = 0
	l.status.Update(l.target.ID, func(s *registry.Status) {
		s.ServerVersionNum = int32(version)
	})
	l.log.Info("connected", "server_version_num", version)
	return true
}

func (l *Loop) bumpBackoff() {
	if l.backoff == 0 {
		l.backoff = l.cfg.ReconnectMin
	} else {
		l.backoff = min(l.backoff*2, l.cfg.ReconnectMax)
	}
	// jitter ±20 %
	j := time.Duration(rand.Int64N(int64(l.backoff)/5+1)) - l.backoff/10
	l.backoff += j
}

func (l *Loop) fail(err error) {
	l.log.Warn("scrape failed", "err", err)
	l.status.Update(l.target.ID, func(s *registry.Status) {
		if s.State != registry.StateDisconnected {
			s.DisconnectedSince = time.Now().UTC()
		}
		s.State = registry.StateDisconnected
		s.LastError = err.Error()
	})
}

func (l *Loop) close() {
	if l.conn != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = l.conn.Close(ctx)
		cancel()
		l.conn = nil
	}
}

// connect opens the single connection of a target and reads the server version.
func connect(ctx context.Context, t registry.Target, cfg config.Scraper) (*pgconn.PgConn, int, error) {
	pc, err := pgconn.ParseConfig(t.DSN)
	if err != nil {
		return nil, 0, fmt.Errorf("parse dsn: %w", err)
	}
	pc.RuntimeParams["application_name"] = "dbperf"
	pc.RuntimeParams["statement_timeout"] = strconv.FormatInt(t.StatementTimeout.Milliseconds(), 10)
	pc.RuntimeParams["idle_in_transaction_session_timeout"] = "0"
	pc.ConnectTimeout = cfg.ConnectTimeout
	conn, err := pgconn.ConnectConfig(ctx, pc)
	if err != nil {
		return nil, 0, err
	}
	res := conn.ExecParams(ctx, versionSQL, nil, nil, nil, []int16{0}).Read()
	if res.Err != nil {
		_ = conn.Close(ctx)
		return nil, 0, fmt.Errorf("server version: %w", res.Err)
	}
	if len(res.Rows) != 1 || len(res.Rows[0]) != 1 {
		_ = conn.Close(ctx)
		return nil, 0, errors.New("server version: unexpected result")
	}
	v, err := strconv.Atoi(string(res.Rows[0][0]))
	if err != nil {
		_ = conn.Close(ctx)
		return nil, 0, fmt.Errorf("server version: %w", err)
	}
	return conn, v, nil
}

func phaseOf(id uint32) int64 {
	h := fnv.New32a()
	var b [4]byte
	b[0], b[1], b[2], b[3] = byte(id), byte(id>>8), byte(id>>16), byte(id>>24)
	_, _ = h.Write(b[:])
	return int64(h.Sum32()) * int64(time.Millisecond)
}
