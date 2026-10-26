package query

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func TestTextFiltersAreBoundAndScoped(t *testing.T) {
	rng := Range{Start: time.Unix(1700000000, 0), End: time.Unix(1700000300, 0)}
	for _, lv := range levelsForTest() {
		payload := "x' OR 1=1 -- %_"
		cond, args, err := where(lv, 7, rng, []Filter{{Dim: DimQuery, Match: 1, Values: []string{payload}}, {Dim: DimDatname, Match: 2, Exclude: true, Values: []string{"Shop"}}}, true, "dbperf")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(cond, payload) || !strings.Contains(cond, "argMax(query, last_seen)") || !strings.Contains(cond, "positionCaseInsensitiveUTF8(text, ?)") || !strings.Contains(cond, "NOT ((lowerUTF8(datname)") {
			t.Fatalf("unexpected SQL: %s", cond)
		}
		if len(args) != 7 || args[4] != uint32(7) || args[5] != payload || args[6] != "Shop" {
			t.Fatalf("unbound/scopeless args: %#v", args)
		}
	}
}
func TestMetricBoundsAndZeroDenominators(t *testing.T) {
	p := func(v float64) *float64 { return &v }
	sql, args, err := metricHaving(&MetricRange{Min: p(1), Max: p(3)}, &MetricRange{Min: p(10)}, 0, 0)
	if err != nil || strings.Count(sql, "if(? = 0") != 3 || len(args) != 12 {
		t.Fatalf("%s %v %v", sql, args, err)
	}
	if args[0] != uint64(0) || args[4] != uint64(0) || args[8] != uint64(0) {
		t.Fatal(args)
	}
	for _, r := range []*MetricRange{{Min: p(-1)}, {Min: p(math.NaN())}, {Max: p(math.Inf(1))}, {Min: p(3), Max: p(1)}} {
		if _, _, err := metricHaving(r, nil, 10, 20); !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted invalid range %+v", r)
		}
	}
	if _, _, err := metricHaving(nil, &MetricRange{Max: p(101)}, 10, 20); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted >100%")
	}
}
func TestInvalidFilters(t *testing.T) {
	rng := Range{Start: time.Now(), End: time.Now().Add(time.Minute)}
	for _, f := range []Filter{{Dim: DimDatname, Match: 9}, {Dim: DimDatname, Values: []string{strings.Repeat("x", 4097)}}} {
		if _, _, err := where(levelsForTest()[0], 1, rng, []Filter{f}, false, ""); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid filter accepted")
		}
	}
}

func TestPIDKeepsRawStorageForCoarseCharts(t *testing.T) {
	s := &Service{levels: levelsForTest()}
	start := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	rng := Range{Start: start, End: start.Add(time.Hour)}
	al, err := s.align(rng, time.Minute, 120, []Dimension{DimPID}, nil)
	if err != nil || al.level.name != "raw" {
		t.Fatalf("%s %v", al.level.name, err)
	}
	al, err = s.align(rng, time.Minute, 120, nil, []Filter{{Dim: DimPID, Values: []string{"123"}}})
	if err != nil || al.level.name != "raw" {
		t.Fatalf("filtered %s %v", al.level.name, err)
	}
	rng.End = start.Add(24 * time.Hour)
	if _, err = s.align(rng, time.Minute, 120, []Dimension{DimPID}, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted PID outside raw range")
	}
}
