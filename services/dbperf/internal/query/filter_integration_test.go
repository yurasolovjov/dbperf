package query

import (
	"context"
	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"os"
	"testing"
	"time"
)

// Uses an explicitly supplied disposable ClickHouse, never the configured shared DB.
func TestSQLTableFiltersIntegration(t *testing.T) {
	addr := os.Getenv("DBPERF_TEST_CLICKHOUSE")
	if addr == "" {
		t.Skip("set DBPERF_TEST_CLICKHOUSE to a disposable ClickHouse native address")
	}
	ctx := context.Background()
	conn, err := clickhouse.Open(&clickhouse.Options{Addr: []string{addr}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	db := "focus_test_" + time.Now().Format("20060102150405")
	if err := conn.Exec(ctx, "CREATE DATABASE "+db); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP DATABASE "+db)
	for _, sql := range []string{
		"CREATE TABLE " + db + ".pg_samples (target_id UInt32, ts DateTime) ENGINE=Memory",
		"CREATE TABLE " + db + ".pg_activity (target_id UInt32, ts DateTime, pid Int32, backend_type String, datname String, usename String, application_name String, client_addr IPv6, wait_event_type String, wait_event String, query_hash UInt64) ENGINE=Memory",
		"CREATE TABLE " + db + ".pg_query_texts (target_id UInt32, query_hash UInt64, query String, last_seen DateTime) ENGINE=Memory",
		"CREATE TABLE " + db + ".pg_samples_1m (target_id UInt32, minute DateTime, n_samples UInt32) ENGINE=Memory",
		"CREATE TABLE " + db + ".pg_activity_1m (target_id UInt32, minute DateTime, backend_type String, datname String, usename String, application_name String, client_addr IPv6, wait_event_type String, wait_event String, query_hash UInt64, n_elements UInt32) ENGINE=Memory",
	} {
		if err := conn.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 6; i++ {
		ts := start.Add(time.Duration(i) * 10 * time.Second)
		if err := conn.Exec(ctx, "INSERT INTO "+db+".pg_samples VALUES (?,?)", uint32(1), ts); err != nil {
			t.Fatal(err)
		}
		for j := 1; j <= 12; j++ {
			wait := "CPU"
			if j%2 == 0 {
				wait = "IO"
			}
			name := "shop"
			if j > 10 {
				name = "archive"
			}
			if err := conn.Exec(ctx, "INSERT INTO "+db+".pg_activity VALUES (?,?,?,?,?,?,?,?,?,?,?)", uint32(1), ts, int32(j), "client backend", name, "alice", "web", "::", wait, "", uint64(j)); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Repeated text versions must not multiply counts; text of another target must never leak.
	for _, r := range []struct {
		target uint32
		hash   uint64
		text   string
	}{{1, 11, "SELECT needle FROM archive"}, {1, 11, "SELECT needle FROM archive"}, {2, 10, "SELECT needle FROM private"}, {1, 10, "SELECT ordinary"}} {
		if err := conn.Exec(ctx, "INSERT INTO "+db+".pg_query_texts VALUES (?,?,?,?)", r.target, r.hash, r.text, start); err != nil {
			t.Fatal(err)
		}
	}
	for _, sql := range []string{
		"INSERT INTO " + db + ".pg_samples_1m SELECT target_id,toStartOfMinute(ts),toUInt32(count()) FROM " + db + ".pg_samples GROUP BY target_id,toStartOfMinute(ts)",
		"INSERT INTO " + db + ".pg_activity_1m SELECT target_id,toStartOfMinute(ts),backend_type,datname,usename,application_name,client_addr,wait_event_type,wait_event,query_hash,toUInt32(count()) FROM " + db + ".pg_activity GROUP BY target_id,toStartOfMinute(ts),backend_type,datname,usename,application_name,client_addr,wait_event_type,wait_event,query_hash",
	} {
		if err := conn.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	s := New(conn, config.ClickHouse{Database: db, RawStep: 10 * time.Second, RawRangeLimit: 2 * time.Hour}, 2000, 4096)
	req := TopRequest{TargetID: 1, Range: Range{Start: start, End: start.Add(time.Minute)}, Slicing: TopSlicing{Dim: DimQuery, Limit: 8}, PageSize: 8}
	all, err := s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if all.MatchedRows != 12 || len(all.Entries) != 8 || all.TotalAAS != 12 {
		t.Fatalf("all: %+v", all)
	}
	req.Offset = 8
	page, err := s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 4 || page.Entries[0].Slice.Value == all.Entries[0].Slice.Value {
		t.Fatalf("page: %+v", page)
	}
	req.Offset = 0
	req.TableFilters = []Filter{{Dim: DimQuery, Match: 1, Values: []string{"NEEDLE"}}}
	found, err := s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if found.MatchedRows != 1 || len(found.Entries) != 1 || found.Entries[0].Slice.Value != "11" || found.TotalAAS != 1 {
		t.Fatalf("SQL text: %+v", found)
	}
	req.Slicing.Dim = DimDatname
	found, err = s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if found.MatchedRows != 1 || found.Entries[0].Slice.Value != "archive" {
		t.Fatalf("cross tab: %+v", found)
	}
	req.TableFilters = nil
	v := 10.
	req.Percent = &MetricRange{Min: &v}
	found, err = s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if found.MatchedRows != 2 || len(found.Entries) != 2 || found.Entries[0].Percent != 83.333 || found.TotalAAS != 12 {
		t.Fatalf("metric: %+v", found)
	}
	v = 20
	found, err = s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if found.MatchedRows != 1 || found.Entries[0].Percent != 83.333 {
		t.Fatalf("denominator changed: %+v", found)
	}
	req.Percent = nil
	req.TableFilters = []Filter{{Dim: DimDatname, Match: 1, Values: []string{"SHOP"}, Exclude: true}}
	found, err = s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if found.TotalAAS != 2 || found.MatchedRows != 1 {
		t.Fatalf("exclude: %+v", found)
	}
	// Same filters must run over the minute rollup, not just raw samples.
	req.Range.End = start.Add(24 * time.Hour)
	req.TableFilters = []Filter{{Dim: DimQuery, Match: 1, Values: []string{"needle"}}}
	found, err = s.Top(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if found.Level != "1m" || found.MatchedRows != 1 || found.TotalAAS != 1 {
		t.Fatalf("rollup: %+v", found)
	}
}
