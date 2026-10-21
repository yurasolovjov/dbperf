package query

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func levelsForTest() []level {
	return []level{rawLevel("dbperf", 10*time.Second, 2*time.Hour), minuteLevel("dbperf")}
}

func TestChooseLevelRaw(t *testing.T) {
	start := time.Date(2026, 10, 21, 12, 0, 3, 0, time.UTC)
	rng := Range{Start: start, End: start.Add(time.Hour)}
	al := chooseLevel(rng, 2*time.Second, 2000, levelsForTest())
	if al.level.name != "raw" || al.step != 10*time.Second {
		t.Fatalf("got %s step %s", al.level.name, al.step)
	}
	if al.rng.Start.Second() != 0 || al.points != 361 {
		t.Fatalf("aligned %v points %d", al.rng, al.points)
	}
}

func TestChooseLevelMinuteForLongRange(t *testing.T) {
	start := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	rng := Range{Start: start, End: start.Add(24 * time.Hour)}
	al := chooseLevel(rng, 0, 720, levelsForTest())
	if al.level.name != "1m" {
		t.Fatalf("level %s", al.level.name)
	}
	if al.points > 720 || al.step%time.Minute != 0 {
		t.Fatalf("points %d step %s", al.points, al.step)
	}
}

func TestChooseLevelPrefersCoarserOnTie(t *testing.T) {
	start := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	rng := Range{Start: start, End: start.Add(time.Hour)}
	al := chooseLevel(rng, time.Minute, 2000, levelsForTest())
	if al.level.name != "1m" || al.points != 60 {
		t.Fatalf("got %s points %d", al.level.name, al.points)
	}
}

func TestWhereAndFilters(t *testing.T) {
	lv := rawLevel("dbperf", 10*time.Second, 0)
	start := time.Unix(1_700_000_000, 0)
	cond, args, err := where(lv, 7, Range{Start: start, End: start.Add(time.Minute)},
		[]Filter{{Dim: DimWaitEventType, Values: []string{"Lock", "IO"}}, {Dim: DimDatname, Values: []string{"shop"}, Exclude: true}},
		true, "dbperf")
	if err != nil {
		t.Fatal(err)
	}
	want := "target_id = ? AND ts >= ? AND ts < ? AND application_name != ? AND wait_event_type IN (?, ?) AND datname NOT IN (?)"
	if cond != want {
		t.Fatalf("cond: %s", cond)
	}
	if len(args) != 7 || args[3] != "dbperf" || args[4] != "Lock" || args[6] != "shop" {
		t.Fatalf("args: %v", args)
	}
	if _, err := dimExpr(DimPID, minuteLevel("dbperf")); err == nil {
		t.Fatal("pid on 1m level must be rejected")
	}
}

func TestPrefixCond(t *testing.T) {
	got := prefixCond("target_id = ? AND ts >= ? AND wait_event_type IN (?) AND toString(pid) IN (?)", "a.")
	if !strings.Contains(got, "a.target_id") || !strings.Contains(got, "a.ts >=") || !strings.Contains(got, "a.wait_event_type") || !strings.Contains(got, "toString(a.pid)") {
		t.Fatalf("got %s", got)
	}
	if strings.Contains(got, "a.a.") {
		t.Fatalf("double prefix: %s", got)
	}
}

func TestTopKeys(t *testing.T) {
	m := map[string]uint64{"b": 5, "a": 5, "c": 9, "d": 1}
	got := topKeys(m, 3)
	if strings.Join(got, ",") != "c,a,b" {
		t.Fatalf("got %v", got)
	}
}

func TestTopKeysSumAndPeak(t *testing.T) {
	sum := map[string]uint64{}
	peak := map[string]uint64{}
	// s0..s11: steady slices, sum 120-109 spread over the range, peak 1.
	for i := 0; i < 12; i++ {
		k := fmt.Sprintf("s%02d", i)
		sum[k] = uint64(120 - i)
		peak[k] = 1
	}
	// burst: one bucket at 50, small sum.
	sum["burst"], peak["burst"] = 50, 50
	got := topKeysSumAndPeak(sum, peak, 10)
	if len(got) != 10 {
		t.Fatalf("len %d: %v", len(got), got)
	}
	seen := map[string]bool{}
	for _, k := range got {
		seen[k] = true
	}
	if !seen["burst"] {
		t.Fatalf("burst missing: %v", got)
	}
	for i := 0; i < 5; i++ {
		if !seen[fmt.Sprintf("s%02d", i)] {
			t.Fatalf("top by sum s%02d missing: %v", i, got)
		}
	}
	// Order is by sum: the burst (sum 50) comes last.
	if got[len(got)-1] != "burst" {
		t.Fatalf("order: %v", got)
	}
	// Below the limit of 10 the ranking is by sum only.
	if got := topKeysSumAndPeak(sum, peak, 5); strings.Join(got, ",") != "s00,s01,s02,s03,s04" {
		t.Fatalf("limit 5: %v", got)
	}
	// Fewer keys than the limit: everything, by sum.
	small := map[string]uint64{"a": 1, "b": 3}
	if got := topKeysSumAndPeak(small, map[string]uint64{"a": 9, "b": 1}, 10); strings.Join(got, ",") != "b,a" {
		t.Fatalf("small: %v", got)
	}
}

func TestProfileValidation(t *testing.T) {
	s := &Service{levels: levelsForTest(), maxPoints: 2000}
	start := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	rng := Range{Start: start, End: start.Add(time.Hour)}
	if _, err := s.Profile(context.Background(), ProfileRequest{Range: rng}); err == nil {
		t.Fatal("empty dimensions must be rejected")
	}
	if _, err := s.Profile(context.Background(), ProfileRequest{Range: rng, Dimensions: []Dimension{DimQuery, DimQuery}}); err == nil {
		t.Fatal("repeated dimensions must be rejected")
	}
	long := Range{Start: start, End: start.Add(24 * time.Hour)}
	if _, err := s.Profile(context.Background(), ProfileRequest{Range: long, Dimensions: []Dimension{DimPID}}); err == nil {
		t.Fatal("pid on the 1m level must be rejected")
	}
}
