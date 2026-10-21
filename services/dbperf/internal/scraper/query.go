package scraper

import "fmt"

// activitySQL returns the snapshot query for a server version. Only active
// backends are returned, the scraper's own backend is excluded by pid.
// Columns (text format):
//
//	0 pid, 1 leader_pid, 2 backend_type, 3 datname, 4 usename, 5 application_name,
//	6 client_addr, 7 state, 8 wait_event_type, 9 wait_event,
//	10 backend_start, 11 xact_start, 12 query_start, 13 state_change (epoch seconds),
//	14 query_id, 15 query
func activitySQL(serverVersionNum int, queryMaxLen int, ownPID uint32) string {
	queryID := "query_id"
	if serverVersionNum < 140000 {
		queryID = "NULL::bigint"
	}
	return fmt.Sprintf(`SELECT pid, leader_pid, backend_type, datname, usename, application_name,
       host(client_addr), state, wait_event_type, wait_event,
       extract(epoch FROM backend_start)::bigint,
       extract(epoch FROM xact_start)::bigint,
       extract(epoch FROM query_start)::bigint,
       extract(epoch FROM state_change)::bigint,
       %s,
       left(query, %d)
FROM pg_stat_activity
WHERE state IN ('active', 'fastpath function call')
  AND pid <> %d`, queryID, queryMaxLen, ownPID)
}

const versionSQL = `SELECT current_setting('server_version_num')::int`
