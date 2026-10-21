package scraper

import (
	"testing"
	"time"
)

func ptr(s string) *string { return &s }

func TestApplyCPURule(t *testing.T) {
	cases := []struct {
		state  string
		wt, we *string
		wantT  string
		wantE  string
	}{
		{"active", nil, nil, "CPU", "CPU"},
		{"active", ptr("Lock"), ptr("transactionid"), "Lock", "transactionid"},
		{"fastpath function call", nil, nil, "", ""},
		{"active", nil, ptr("x"), "", "x"},
	}
	for _, c := range cases {
		gt, ge := ApplyCPURule(c.state, c.wt, c.we)
		if gt != c.wantT || ge != c.wantE {
			t.Errorf("%q %v %v: got %q %q, want %q %q", c.state, c.wt, c.we, gt, ge, c.wantT, c.wantE)
		}
	}
}

func TestParseRows(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0).UTC()
	raw := [][][]byte{{
		[]byte("4242"), nil, []byte("client backend"), []byte("shop"), []byte("app"), []byte("api"),
		[]byte("10.1.2.3"), []byte("active"), nil, nil,
		[]byte("1699999000"), []byte("1699999990"), []byte("1699999995"), []byte("1699999995"),
		[]byte("-123"), []byte("SELECT 1"),
	}, {
		[]byte("4243"), []byte("4242"), []byte("client backend"), []byte("shop"), []byte("app"), []byte("api"),
		nil, []byte("active"), []byte("IO"), []byte("DataFileRead"),
		nil, nil, nil, nil,
		nil, []byte("SELECT 2"),
	}}
	rows, err := parseRows(7, ts, raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows: %d", len(rows))
	}
	r := rows[0]
	if r.PID != 4242 || r.WaitEventType != "CPU" || r.WaitEvent != "CPU" || r.ClientAddr.String() != "10.1.2.3" {
		t.Errorf("row0: %+v", r)
	}
	var neg int64 = -123
	if r.QueryHash != uint64(neg) {
		t.Errorf("row0 hash: %d", r.QueryHash)
	}
	if r.XactStart.Unix() != 1699999990 {
		t.Errorf("row0 xact_start: %v", r.XactStart)
	}
	r = rows[1]
	if r.LeaderPID != 4242 || r.ClientAddr.IsValid() || r.WaitEventType != "IO" || !r.XactStart.IsZero() {
		t.Errorf("row1: %+v", r)
	}
	if r.QueryHash != HashQuery("SELECT 2") {
		t.Errorf("row1 hash")
	}
}

func TestHashLRU(t *testing.T) {
	l := newHashLRU(2)
	if !l.Touch(1) || !l.Touch(2) || l.Touch(1) {
		t.Fatal("unexpected novelty")
	}
	if !l.Touch(3) { // evicts 2
		t.Fatal("3 should be new")
	}
	if !l.Touch(2) {
		t.Fatal("2 should have been evicted")
	}
}
