package clickhouse

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/scraper"
)

type fakeWriter struct {
	mu       sync.Mutex
	fail     bool
	activity int
	samples  int
	texts    int
}

func (f *fakeWriter) writeActivity(_ context.Context, b *pending) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("down")
	}
	f.activity += len(b.rows)
	return nil
}
func (f *fakeWriter) writeSamples(_ context.Context, b *pending) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("down")
	}
	f.samples += len(b.markers)
	return nil
}
func (f *fakeWriter) writeTexts(_ context.Context, b *pending) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("down")
	}
	f.texts += len(b.texts)
	return nil
}

type nopMetrics struct{ dropped int }

func (m *nopMetrics) ObserveFlush(string, int, error) {}
func (m *nopMetrics) SetPending(int)                  {}
func (m *nopMetrics) SetBuffered(int)                 {}
func (m *nopMetrics) AddDropped(n int)                { m.dropped += n }

func batch(id uint32, n int) scraper.Batch {
	b := scraper.Batch{Marker: scraper.SampleMarker{TargetID: id, TS: time.Now(), NActive: uint16(n)}}
	for i := 0; i < n; i++ {
		b.Rows = append(b.Rows, scraper.ActivityRow{TargetID: id, PID: int32(i)})
	}
	b.Texts = append(b.Texts, scraper.QueryText{TargetID: id, QueryHash: 1, Query: "SELECT 1"})
	return b
}

func TestSinkFlushesBySize(t *testing.T) {
	cfg := config.Default().ClickHouse
	cfg.FlushRows = 1000
	cfg.FlushInterval = time.Hour
	w := &fakeWriter{}
	s := newSink(cfg, w, &nopMetrics{}, slog.Default())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = s.Run(ctx); close(done) }()
	for i := 0; i < 10; i++ {
		s.Emit(batch(uint32(i), 100))
	}
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.activity != 1000 || w.samples != 10 || w.texts != 10 {
		t.Fatalf("written: activity=%d samples=%d texts=%d", w.activity, w.samples, w.texts)
	}
}

func TestSinkRetriesAndDrops(t *testing.T) {
	cfg := config.Default().ClickHouse
	cfg.FlushRows = 1000
	cfg.FlushInterval = 20 * time.Millisecond
	cfg.MaxPendingBatches = 2
	w := &fakeWriter{fail: true}
	m := &nopMetrics{}
	s := newSink(cfg, w, m, slog.Default())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = s.Run(ctx); close(done) }()
	for i := 0; i < 5; i++ {
		s.Emit(batch(1, 10))
		time.Sleep(30 * time.Millisecond) // each lands in its own batch
	}
	w.mu.Lock()
	w.fail = false
	w.mu.Unlock()
	time.Sleep(1500 * time.Millisecond) // backoff is at least 1 s
	cancel()
	<-done
	w.mu.Lock()
	defer w.mu.Unlock()
	if m.dropped == 0 {
		t.Fatal("expected drops with a queue of 2")
	}
	if w.activity == 0 || w.activity > 20 {
		t.Fatalf("expected at most two surviving batches, wrote %d rows", w.activity)
	}
}
