package scraper

import (
	"fmt"
	"net/netip"
	"strconv"
	"time"
)

// parseRows converts the text-format result of activitySQL into rows.
// Query texts are not hashed here; see Loop.collect.
func parseRows(targetID uint32, ts time.Time, raw [][][]byte) ([]ActivityRow, error) {
	out := make([]ActivityRow, 0, len(raw))
	for i, r := range raw {
		if len(r) != 16 {
			return nil, fmt.Errorf("row %d: expected 16 columns, got %d", i, len(r))
		}
		row := ActivityRow{TargetID: targetID, TS: ts}
		row.PID = int32(parseInt(r[0]))
		row.LeaderPID = int32(parseInt(r[1]))
		row.BackendType = str(r[2])
		row.Datname = str(r[3])
		row.Usename = str(r[4])
		row.ApplicationName = str(r[5])
		if r[6] != nil {
			if a, err := netip.ParseAddr(string(r[6])); err == nil {
				row.ClientAddr = a
			}
		}
		row.State = str(r[7])
		row.WaitEventType, row.WaitEvent = ApplyCPURule(row.State, nullable(r[8]), nullable(r[9]))
		row.BackendStart = parseEpoch(r[10])
		row.XactStart = parseEpoch(r[11])
		row.QueryStart = parseEpoch(r[12])
		row.StateChange = parseEpoch(r[13])
		row.QueryText = str(r[15])
		if r[14] != nil {
			// query_id is a signed bigint; the hash column is unsigned
			row.QueryHash = uint64(parseInt(r[14]))
		} else {
			row.QueryHash = HashQuery(row.QueryText)
		}
		out = append(out, row)
	}
	return out, nil
}

func str(b []byte) string {
	if b == nil {
		return ""
	}
	return string(b)
}

func nullable(b []byte) *string {
	if b == nil {
		return nil
	}
	s := string(b)
	return &s
}

func parseInt(b []byte) int64 {
	if b == nil {
		return 0
	}
	v, _ := strconv.ParseInt(string(b), 10, 64)
	return v
}

func parseEpoch(b []byte) time.Time {
	if b == nil {
		return time.Time{}
	}
	v, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil || v <= 0 {
		return time.Time{}
	}
	return time.Unix(v, 0).UTC()
}
