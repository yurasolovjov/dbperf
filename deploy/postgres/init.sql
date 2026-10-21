-- Test bench: monitoring role and a pgbench database.
CREATE ROLE dbperf LOGIN PASSWORD 'dbperf';
GRANT pg_monitor TO dbperf;
CREATE DATABASE pgbench OWNER postgres;
\connect pgbench
GRANT pg_monitor TO dbperf;
