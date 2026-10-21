-- dbperf ClickHouse schema, single node (MVP). See docs/dbperf-service-plan.md, section 8.
CREATE DATABASE IF NOT EXISTS dbperf;

-- 1. Active sessions: one row per active backend per snapshot
CREATE TABLE IF NOT EXISTS dbperf.pg_activity (
    target_id        UInt32                 CODEC(Delta(4), ZSTD(1)),
    ts               DateTime               CODEC(Delta(4), ZSTD(1)),
    pid              Int32                  CODEC(T64, ZSTD(1)),
    leader_pid       Int32                  CODEC(T64, ZSTD(1)),
    backend_type     LowCardinality(String),
    datname          LowCardinality(String),
    usename          LowCardinality(String),
    application_name LowCardinality(String),
    client_addr      IPv6                   CODEC(ZSTD(1)),
    state            LowCardinality(String),
    wait_event_type  LowCardinality(String),
    wait_event       LowCardinality(String),
    backend_start    DateTime               CODEC(Delta(4), ZSTD(1)),
    xact_start       DateTime               CODEC(Delta(4), ZSTD(1)),
    query_start      DateTime               CODEC(Delta(4), ZSTD(1)),
    state_change     DateTime               CODEC(Delta(4), ZSTD(1)),
    query_hash       UInt64                 CODEC(ZSTD(1))
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (target_id, ts, pid)
TTL ts + INTERVAL 7 DAY
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- 2. Samples: one row per tick per target, even with zero active sessions
CREATE TABLE IF NOT EXISTS dbperf.pg_samples (
    target_id   UInt32   CODEC(Delta(4), ZSTD(1)),
    ts          DateTime CODEC(Delta(4), ZSTD(1)),
    n_active    UInt16   CODEC(T64, ZSTD(1)),
    duration_ms UInt16   CODEC(T64, ZSTD(1))
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (target_id, ts)
TTL ts + INTERVAL 7 DAY
SETTINGS ttl_only_drop_parts = 1;

-- 3. Query texts: one row per (target, hash)
CREATE TABLE IF NOT EXISTS dbperf.pg_query_texts (
    target_id  UInt32,
    query_hash UInt64,
    query      String   CODEC(ZSTD(3)),
    last_seen  DateTime
) ENGINE = ReplacingMergeTree(last_seen)
ORDER BY (target_id, query_hash)
TTL last_seen + INTERVAL 30 DAY;

-- 4. One-minute activity rollup: no pid, no exact time
CREATE TABLE IF NOT EXISTS dbperf.pg_activity_1m (
    target_id        UInt32,
    minute           DateTime,
    backend_type     LowCardinality(String),
    datname          LowCardinality(String),
    usename          LowCardinality(String),
    application_name LowCardinality(String),
    client_addr      IPv6,
    wait_event_type  LowCardinality(String),
    wait_event       LowCardinality(String),
    query_hash       UInt64,
    n_elements       UInt32
) ENGINE = SummingMergeTree((n_elements))
PARTITION BY toYYYYMMDD(minute)
ORDER BY (target_id, minute, backend_type, datname, usename, application_name,
          client_addr, wait_event_type, wait_event, query_hash)
TTL minute + INTERVAL 14 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS dbperf.pg_activity_1m_mv TO dbperf.pg_activity_1m AS
SELECT target_id, toStartOfMinute(ts) AS minute,
       backend_type, datname, usename, application_name, client_addr,
       wait_event_type, wait_event, query_hash,
       count() AS n_elements
FROM dbperf.pg_activity
GROUP BY target_id, minute, backend_type, datname, usename, application_name,
         client_addr, wait_event_type, wait_event, query_hash;

-- 5. One-minute sample counter: denominator for the rollup
CREATE TABLE IF NOT EXISTS dbperf.pg_samples_1m (
    target_id UInt32,
    minute    DateTime,
    n_samples UInt32,
    n_active  UInt32
) ENGINE = SummingMergeTree((n_samples, n_active))
PARTITION BY toYYYYMMDD(minute)
ORDER BY (target_id, minute)
TTL minute + INTERVAL 14 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS dbperf.pg_samples_1m_mv TO dbperf.pg_samples_1m AS
SELECT target_id, toStartOfMinute(ts) AS minute, count() AS n_samples, sum(n_active) AS n_active
FROM dbperf.pg_samples
GROUP BY target_id, minute;
