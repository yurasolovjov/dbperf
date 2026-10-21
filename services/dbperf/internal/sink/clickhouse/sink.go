package clickhouse

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/scraper"
)

// Metrics is the telemetry the sink reports.
type Metrics interface {
	ObserveFlush(table string, rows int, err error)
	SetPending(n int)
	SetBuffered(n int)
	AddDropped(n int)
}

// writer is the insert backend; chWriter in production, a fake in tests.
type writer interface {
	writeActivity(ctx context.Context, b *pending) error
	writeSamples(ctx context.Context, b *pending) error
	writeTexts(ctx context.Context, b *pending) error
}

// pending is a closed buffer waiting for a successful insert.
type pending struct {
	rows    []scraper.ActivityRow
	markers []scraper.SampleMarker
	texts   []scraper.QueryText
	done    [3]bool // activity, samples, texts already inserted
	created time.Time
}

func (p *pending) size() int { return len(p.rows) + len(p.markers) + len(p.texts) }

// Sink collects batches from scrapers and writes them in large inserts.
type Sink struct {
	cfg     config.ClickHouse
	w       writer
	metrics Metrics
	log     *slog.Logger

	in      chan scraper.Batch
	open    *pending
	queue   []*pending
	backoff time.Duration
	nextTry time.Time
}

// New creates a sink over an open connection.
func New(cfg config.ClickHouse, conn driver.Conn, m Metrics, log *slog.Logger) *Sink {
	return newSink(cfg, &chWriter{conn: conn, db: cfg.Database}, m, log)
}

func newSink(cfg config.ClickHouse, w writer, m Metrics, log *slog.Logger) *Sink {
	return &Sink{
		cfg:     cfg,
		w:       w,
		metrics: m,
		log:     log,
		in:      make(chan scraper.Batch, 32768), // an instance with 5 000 targets emits ~500 batches per second
		open:    &pending{created: time.Now()},
	}
}

// Emit implements scraper.Emitter. It never blocks a scraper: when the
// channel is full the batch is dropped and counted.
func (s *Sink) Emit(b scraper.Batch) {
	select {
	case s.in <- b:
	default:
		s.metrics.AddDropped(len(b.Rows) + 1 + len(b.Texts))
	}
}

// Run flushes buffers on the configured interval or size until ctx is
// cancelled, then makes a final attempt to write what is left.
func (s *Sink) Run(ctx context.Context) error {
	ticker := time.NewTicker(s.cfg.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.rotate()
			s.nextTry = time.Time{}
			fctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			s.drain(fctx)
			cancel()
			return ctx.Err()
		case b := <-s.in:
			s.append(b)
			if len(s.open.rows) >= s.cfg.FlushRows {
				s.rotate()
				s.drain(ctx)
			}
		case <-ticker.C:
			s.rotate()
			s.drain(ctx)
		}
	}
}

func (s *Sink) append(b scraper.Batch) {
	s.open.rows = append(s.open.rows, b.Rows...)
	s.open.markers = append(s.open.markers, b.Marker)
	s.open.texts = append(s.open.texts, b.Texts...)
	s.metrics.SetBuffered(len(s.open.rows))
}

// rotate closes the open buffer and queues it, dropping the oldest pending
// batch when the queue is full.
func (s *Sink) rotate() {
	if s.open.size() == 0 {
		return
	}
	s.queue = append(s.queue, s.open)
	s.open = &pending{created: time.Now()}
	s.metrics.SetBuffered(0)
	for len(s.queue) > s.cfg.MaxPendingBatches {
		dropped := s.queue[0]
		s.queue = s.queue[1:]
		s.metrics.AddDropped(dropped.size())
		s.log.Warn("pending queue full, dropping oldest batch", "rows", len(dropped.rows), "age", time.Since(dropped.created))
	}
	s.metrics.SetPending(len(s.queue))
}

// drain writes pending batches in order and stops at the first failure.
func (s *Sink) drain(ctx context.Context) {
	if len(s.queue) == 0 || time.Now().Before(s.nextTry) {
		return
	}
	for len(s.queue) > 0 {
		p := s.queue[0]
		if err := s.write(ctx, p); err != nil {
			s.backoff = min(max(s.backoff*2, time.Second), 30*time.Second)
			s.nextTry = time.Now().Add(s.backoff)
			s.log.Warn("insert failed, will retry", "err", err, "pending", len(s.queue), "backoff", s.backoff)
			s.metrics.SetPending(len(s.queue))
			return
		}
		s.queue = s.queue[1:]
	}
	s.backoff = 0
	s.nextTry = time.Time{}
	s.metrics.SetPending(0)
}

func (s *Sink) write(ctx context.Context, p *pending) error {
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var errs []error
	if !p.done[0] && len(p.rows) > 0 {
		err := s.w.writeActivity(wctx, p)
		s.metrics.ObserveFlush(TableActivity, len(p.rows), err)
		if err != nil {
			errs = append(errs, err)
		} else {
			p.done[0] = true
		}
	}
	if !p.done[1] && len(p.markers) > 0 {
		err := s.w.writeSamples(wctx, p)
		s.metrics.ObserveFlush(TableSamples, len(p.markers), err)
		if err != nil {
			errs = append(errs, err)
		} else {
			p.done[1] = true
		}
	}
	if !p.done[2] && len(p.texts) > 0 {
		err := s.w.writeTexts(wctx, p)
		s.metrics.ObserveFlush(TableTexts, len(p.texts), err)
		if err != nil {
			errs = append(errs, err)
		} else {
			p.done[2] = true
		}
	}
	return errors.Join(errs...)
}
