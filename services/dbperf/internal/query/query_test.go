package query

import (
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
