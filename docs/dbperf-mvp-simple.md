# dbperf MVP: простой план. Полные снимки четырёх представлений

Цель этого этапа — самый короткий путь «PostgreSQL → ClickHouse», на котором можно
отладить коллектор и начать смотреть данные. Никаких дельт, агрегатов и materialized views:
коллектор периодически читает четыре представления целиком и вставляет строки в ClickHouse
как есть. Всё, что можно отложить, отложено (см. раздел 9). Разбор четырёх представлений по
книге и список основных метрик с типами — в разделе 8.

Источники: `pg_stat_activity`, `pg_locks`, `pg_stat_statements`, `pg_stat_database`.
Описание полей — в [postgres-statistics-views.md](postgres-statistics-views.md), разделы
1.1, 1.2, 2.1, 1.3. Полный план с остальными источниками — в
[dbperf-mvp-plan.md](dbperf-mvp-plan.md); этот документ его не отменяет, а описывает
первый шаг.

---

## 1. Принципы этапа

1. **Снимок как есть.** Одна строка представления → одна строка ClickHouse. Все колонки
   представления переносятся под своими именами. Добавляются только две служебные колонки:
   `ts` (время тика) и `target` (имя цели из конфигурации).
2. **Никаких вычислений в коллекторе.** Коллектор не считает дельты, не фильтрует строки,
   не агрегирует. Приведение типов делается в SQL на стороне PostgreSQL только там, где
   без него не обойтись (`xid`, `inet`, `numeric`).
3. **Никаких materialized views.** Данные смотрим обычными `SELECT` к сырым таблицам.
   Накопительные счётчики (`pg_stat_statements`, `pg_stat_database`) хранятся как есть,
   прирост считается в запросе оконными функциями, когда понадобится.
4. **Один тик — одна транзакция чтения — одна вставка на таблицу.** Все четыре запроса
   выполняются последовательно на одном соединении, строки накапливаются в памяти и
   отправляются в ClickHouse четырьмя батчами.
5. **Одна цель, одно соединение.** Несколько целей — это несколько экземпляров цикла,
   без общего состояния.

---

## 2. Источники и расписание

| Источник | Интервал | Строк за тик (ориентир) | Зачем именно он первым |
|---|---|---|---|
| `pg_stat_activity` | 10 с | = число процессов, обычно 20–500 | Главный источник при расследовании проблем (глава 2 книги); снимок, иначе данные теряются |
| `pg_locks` | 10 с | десятки–тысячи (у каждого процесса несколько блокировок) | Пара к `pg_stat_activity`: с ним строятся ожидания и дерево блокировок по `pid` |
| `pg_stat_statements` | 60 с | = `pg_stat_statements.max`, до 5–10 тысяч | Статистика запросов (глава 3); самый ценный накопительный источник |
| `pg_stat_database` | 60 с | = число баз + 1 | TPS, hit ratio, ошибки, временные файлы (главы 2, 4, 5) |

Два интервала (10 с и 60 с) реализуются как два независимых цикла или как один цикл в 10 с,
где тяжёлые источники читаются на каждом шестом тике. Для простоты — второе.

Все запросы выполняются к базе `postgres` (или к базе, где установлено расширение
`pg_stat_statements`): все четыре представления глобальны для кластера.

---

## 3. Запросы коллектора

Каждый запрос возвращает все колонки представления в порядке, совпадающем с таблицей
ClickHouse. `ts` подставляет коллектор (одно значение на тик).

### 3.1. `pg_stat_activity`

```sql
SELECT
    datid, datname, pid, leader_pid, usesysid, usename, application_name,
    host(client_addr) AS client_addr, client_hostname, client_port,
    backend_start, xact_start, query_start, state_change,
    wait_event_type, wait_event, state,
    backend_xid::text::bigint  AS backend_xid,
    backend_xmin::text::bigint AS backend_xmin,
    query_id, query, backend_type
FROM pg_stat_activity;
```

### 3.2. `pg_locks`

```sql
SELECT
    locktype, database, relation, page, tuple, virtualxid,
    transactionid::text::bigint AS transactionid,
    classid, objid, objsubid, virtualtransaction, pid, mode, granted, fastpath, waitstart
FROM pg_locks;
```

### 3.3. `pg_stat_statements`

```sql
SELECT
    userid, dbid, toplevel, queryid, query,
    plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time,
    calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time,
    rows,
    shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written,
    local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written,
    temp_blks_read, temp_blks_written,
    blk_read_time, blk_write_time, temp_blk_read_time, temp_blk_write_time,
    wal_records, wal_fpi, wal_bytes::bigint AS wal_bytes,
    jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time,
    jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time
FROM pg_stat_statements;
```

Колонки соответствуют `pg_stat_statements` 1.10 (PostgreSQL 15–16). Для 14 отсутствуют
`temp_blk_*_time` и `jit_*`, для 17 `blk_read_time`/`blk_write_time` переименованы в
`shared_blk_*_time`. На этом этапе поддерживается одна версия, 16; остальные — позже.

### 3.4. `pg_stat_database`

```sql
SELECT
    datid, datname, numbackends,
    xact_commit, xact_rollback, blks_read, blks_hit,
    tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
    conflicts, temp_files, temp_bytes, deadlocks,
    checksum_failures, checksum_last_failure,
    blk_read_time, blk_write_time,
    session_time, active_time, idle_in_transaction_time,
    sessions, sessions_abandoned, sessions_fatal, sessions_killed,
    stats_reset
FROM pg_stat_database;
```

---

## 4. Таблицы ClickHouse

Соглашения: `MergeTree`, партиции по дням, сортировка по `(target, ts, ключ строки)`,
TTL 7 дней для снимков и 30 дней для счётчиков. Типы: `oid` → `UInt32`, `xid` → `UInt32`
(через `::text::bigint`), `integer` → `Int32`, `smallint` → `Int16`, `bigint` → `Int64`,
`double precision` → `Float64`, `boolean` → `Bool`, `timestamptz` → `DateTime64(6)`,
`text`/`name` → `String`, `inet` → `String` (через `host()`). Колонки, которые в PostgreSQL
могут быть NULL, объявлены `Nullable`.

```sql
CREATE TABLE pg_stat_activity (
    ts               DateTime,
    target           LowCardinality(String),
    datid            Nullable(UInt32),
    datname          Nullable(String),
    pid              Int32,
    leader_pid       Nullable(Int32),
    usesysid         Nullable(UInt32),
    usename          Nullable(String),
    application_name Nullable(String),
    client_addr      Nullable(String),
    client_hostname  Nullable(String),
    client_port      Nullable(Int32),
    backend_start    Nullable(DateTime64(6)),
    xact_start       Nullable(DateTime64(6)),
    query_start      Nullable(DateTime64(6)),
    state_change     Nullable(DateTime64(6)),
    wait_event_type  Nullable(String),
    wait_event       Nullable(String),
    state            Nullable(String),
    backend_xid      Nullable(UInt32),
    backend_xmin     Nullable(UInt32),
    query_id         Nullable(Int64),
    query            Nullable(String),
    backend_type     Nullable(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, ts, pid)
TTL ts + INTERVAL 7 DAY;

CREATE TABLE pg_locks (
    ts                 DateTime,
    target             LowCardinality(String),
    locktype           String,
    database           Nullable(UInt32),
    relation           Nullable(UInt32),
    page               Nullable(Int32),
    tuple              Nullable(Int16),
    virtualxid         Nullable(String),
    transactionid      Nullable(UInt32),
    classid            Nullable(UInt32),
    objid              Nullable(UInt32),
    objsubid           Nullable(Int16),
    virtualtransaction Nullable(String),
    pid                Nullable(Int32),
    mode               String,
    granted            Bool,
    fastpath           Bool,
    waitstart          Nullable(DateTime64(6))
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, ts, locktype)      -- pid здесь NULL у подготовленных транзакций,
TTL ts + INTERVAL 7 DAY;             -- поэтому в ключ сортировки не входит

CREATE TABLE pg_stat_statements (
    ts                     DateTime,
    target                 LowCardinality(String),
    userid                 UInt32,
    dbid                   UInt32,
    toplevel               Bool,
    queryid                Int64,
    query                  String,
    plans                  Int64,
    total_plan_time        Float64,
    min_plan_time          Float64,
    max_plan_time          Float64,
    mean_plan_time         Float64,
    stddev_plan_time       Float64,
    calls                  Int64,
    total_exec_time        Float64,
    min_exec_time          Float64,
    max_exec_time          Float64,
    mean_exec_time         Float64,
    stddev_exec_time       Float64,
    rows                   Int64,
    shared_blks_hit        Int64,
    shared_blks_read       Int64,
    shared_blks_dirtied    Int64,
    shared_blks_written    Int64,
    local_blks_hit         Int64,
    local_blks_read        Int64,
    local_blks_dirtied     Int64,
    local_blks_written     Int64,
    temp_blks_read         Int64,
    temp_blks_written      Int64,
    blk_read_time          Float64,
    blk_write_time         Float64,
    temp_blk_read_time     Float64,
    temp_blk_write_time    Float64,
    wal_records            Int64,
    wal_fpi                Int64,
    wal_bytes              Int64,
    jit_functions          Int64,
    jit_generation_time    Float64,
    jit_inlining_count     Int64,
    jit_inlining_time      Float64,
    jit_optimization_count Int64,
    jit_optimization_time  Float64,
    jit_emission_count     Int64,
    jit_emission_time      Float64
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, dbid, userid, queryid, toplevel, ts)
TTL ts + INTERVAL 30 DAY;

CREATE TABLE pg_stat_database (
    ts                       DateTime,
    target                   LowCardinality(String),
    datid                    UInt32,
    datname                  Nullable(String),
    numbackends              Int32,
    xact_commit              Int64,
    xact_rollback            Int64,
    blks_read                Int64,
    blks_hit                 Int64,
    tup_returned             Int64,
    tup_fetched              Int64,
    tup_inserted             Int64,
    tup_updated              Int64,
    tup_deleted              Int64,
    conflicts                Int64,
    temp_files               Int64,
    temp_bytes               Int64,
    deadlocks                Int64,
    checksum_failures        Nullable(Int64),
    checksum_last_failure    Nullable(DateTime64(6)),
    blk_read_time            Float64,
    blk_write_time           Float64,
    session_time             Float64,
    active_time              Float64,
    idle_in_transaction_time Float64,
    sessions                 Int64,
    sessions_abandoned       Int64,
    sessions_fatal           Int64,
    sessions_killed          Int64,
    stats_reset              Nullable(DateTime64(6))
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, datid, ts)
TTL ts + INTERVAL 30 DAY;
```

Таблица `pg_stat_statements` хранит текст запроса в каждой строке. Для 5 000 запросов
раз в минуту это около 7 млн строк в сутки с повторяющимся текстом; ClickHouse сжимает
повторы хорошо, а вынесение текста в словарь — следующий этап.

---

## 5. Цикл коллектора

```
загрузить config.yaml
открыть соединение с PostgreSQL (application_name = 'dbperf', statement_timeout = 10s)
открыть клиент ClickHouse
n = 0
каждые 10 с:
    ts = now() (округлено до секунды)
    строки_activity  = выполнить 3.1
    строки_locks     = выполнить 3.2
    если n % 6 == 0:
        строки_statements = выполнить 3.3
        строки_database   = выполнить 3.4
    вставить каждый набор строк в свою таблицу ClickHouse (одна INSERT на таблицу,
        добавив ts и target к каждой строке)
    записать в лог: ts, число строк по таблицам, длительность, ошибки
    n += 1
при ошибке PostgreSQL: переподключиться на следующем тике, тик пропустить
при ошибке ClickHouse: повторить вставку на следующем тике (буфер не более 10 тиков),
    затем отбросить самые старые
```

Конфигурация (минимальная):

```yaml
target: pg1
postgres:
  dsn: "postgres://dbperf@pg-host:5432/postgres"
clickhouse:
  dsn: "clickhouse://ch-host:9000/dbperf"
interval: 10s
slow_every: 6          # pg_stat_statements и pg_stat_database на каждом 6-м тике
```

Роль `dbperf` в PostgreSQL: `CREATE ROLE dbperf LOGIN; GRANT pg_monitor TO dbperf;`.
`pg_monitor` достаточно для всех четырёх представлений, включая тексты чужих запросов.

---

## 6. Как смотреть данные без materialized views

Примеры запросов к ClickHouse, повторяющие запросы книги по сырым таблицам.

```sql
-- сеансы по состояниям в момент времени (запрос 1.7 книги)
SELECT
    if(wait_event_type = 'Lock', 'waiting', state) AS state, count() AS sessions
FROM pg_stat_activity
WHERE target = 'pg1' AND ts = toDateTime('2026-10-19 12:00:00') AND backend_type = 'client backend'
GROUP BY state ORDER BY sessions DESC;

-- динамика состояний: по одной точке на тик
SELECT ts, if(wait_event_type = 'Lock', 'waiting', state) AS state, count() AS sessions
FROM pg_stat_activity
WHERE target = 'pg1' AND ts >= now() - INTERVAL 1 HOUR AND backend_type = 'client backend'
GROUP BY ts, state ORDER BY ts, state;

-- кто ждал блокировки и сколько (запрос 1.10 книги)
SELECT l.ts, l.pid, a.state, a.usename, a.datname, l.locktype, l.mode,
       dateDiff('millisecond', l.waitstart, toDateTime64(l.ts, 6)) / 1000 AS wait_age_s,
       substring(a.query, 1, 64) AS query
FROM pg_locks l
JOIN pg_stat_activity a ON a.target = l.target AND a.ts = l.ts AND a.pid = l.pid
WHERE l.target = 'pg1' AND l.ts >= now() - INTERVAL 1 HOUR AND NOT l.granted
ORDER BY wait_age_s DESC LIMIT 20;

-- TPS по базам: прирост счётчиков между соседними снимками (запрос 1.3 книги).
-- lagInFrame возвращает 0, а не NULL, для первой строки, поэтому она отфильтрована.
SELECT ts, datname, (xacts - prev_xacts) / dateDiff('second', prev_ts, ts) AS tps
FROM (
    SELECT ts, datname,
           xact_commit + xact_rollback AS xacts,
           lagInFrame(xact_commit + xact_rollback) OVER w AS prev_xacts,
           lagInFrame(ts) OVER w AS prev_ts
    FROM pg_stat_database
    WHERE target = 'pg1' AND ts >= now() - INTERVAL 1 HOUR AND datname IS NOT NULL
    WINDOW w AS (PARTITION BY datname ORDER BY ts)
)
WHERE prev_ts > toDateTime(0) AND xacts >= prev_xacts
ORDER BY datname, ts;

-- топ запросов по приросту времени выполнения за час (запрос 2.6 книги)
SELECT queryid, dbid, userid, any(query) AS query,
       max(total_exec_time) - min(total_exec_time) AS exec_ms,
       max(calls) - min(calls) AS calls
FROM pg_stat_statements
WHERE target = 'pg1' AND ts >= now() - INTERVAL 1 HOUR AND toplevel
GROUP BY queryid, dbid, userid
HAVING calls > 0
ORDER BY exec_ms DESC LIMIT 10;
```

Запрос с `max − min` верен, пока в окне не было сброса статистики; это ограничение
принимается на данном этапе.

---

## 7. Шаги

| Шаг | Что сделать | Готово, когда |
|---|---|---|
| 1 | Стенд: docker-compose с PostgreSQL 16 (`shared_preload_libraries = pg_stat_statements`, `track_io_timing = on`), pgbench-нагрузкой и ClickHouse; роль `dbperf`; DDL из раздела 4 | `docker compose up` поднимает всё, в ClickHouse есть четыре пустые таблицы |
| 2 | Коллектор: конфигурация, соединения, четыре запроса, вставка, лог | За минуту работы в каждой таблице есть строки с правильным `ts` и `target` |
| 3 | Проверка данных: запросы из раздела 6 дают осмысленные числа на pgbench-нагрузке; число строк `pg_stat_activity` за тик совпадает с `count(*)` в PostgreSQL | Расхождений нет |
| 4 | Устойчивость: перезапуск PostgreSQL, перезапуск ClickHouse, перезапуск коллектора | Коллектор восстанавливается сам, пропуски в данных не длиннее одного тика после восстановления |
| 5 | Нагрузка: `pg_stat_statements.max = 10000`, 500 подключений; измерить время тика и долю коллектора в `pg_stat_statements` по `application_name = 'dbperf'` | Тик укладывается в интервал, доля коллектора < 1 % общего времени |

---

## 8. Анализ представлений и основные метрики

Разбор четырёх источников по книге «Мониторинг PostgreSQL»: глава 2 — `pg_stat_activity`,
`pg_locks`, `pg_stat_database`; глава 3 — `pg_stat_statements`; главы 4–6 — поля ввода-вывода,
временных файлов и WAL. Для каждого источника: что он собой представляет, на что обращает
внимание автор, и список метрик, которые dbperf должен уметь получать из сырых таблиц
раздела 4. Имена метрик даны в стиле книги (`postgres_*`), где у автора есть готовая метрика —
она указана в последней колонке.

### 8.0. Типы метрик и как они ложатся на снимки

| Тип | Что это | Откуда берётся в dbperf |
|---|---|---|
| counter | Монотонно растущее значение; сбрасывается только при `stats_reset` или перезапуске. Смысл имеет прирост за интервал (`rate`/`increase` в книге) | Накопительные поля `pg_stat_statements` и `pg_stat_database`. В ClickHouse хранится как есть, прирост считается `lagInFrame` по соседним снимкам (раздел 6); падение значения означает сброс, такой интервал отбрасывается |
| gauge | Текущее значение, может расти и падать | Всё, что считается по строкам `pg_stat_activity` и `pg_locks`; `numbackends`; min/max/mean/stddev в `pg_stat_statements`; производные отношения (hit ratio, доля IO) |
| histogram | Распределение величины по группе объектов в момент снимка: сколько сеансов ждали блокировку меньше 1 с, от 1 до 10 с, дольше | Строится запросом к ClickHouse по строкам одного `ts` (`countIf` по корзинам или `quantiles`). `pg_stat_statements` даёт только моменты распределения (min/max/mean/stddev), а не корзины |

Особенность снимков (с. 37): `pg_stat_activity` и `pg_locks` показывают только момент опроса,
между тиками короткие ожидания теряются. Все gauge и histogram из этих двух представлений
верны «с точностью до интервала» (10 с в разделе 2). Длительности книга считает через
`clock_timestamp()` (с. 58); в dbperf их роль играет `ts` тика, снятый перед запросом.

### 8.1. `pg_stat_activity` (глава 2, с. 31–35, 39–60)

**Что это.** Одна строка на серверный процесс: клиентские процессы и фоновые службы
(`backend_type`). По книге — главный источник первичной информации при любых подозрениях
на проблемы. Снимок, ничего не накапливает.

**На что смотрит автор.**
- Кто подключён: `client_addr`, `usename`, `datname`, `application_name`; клиентов отбирать
  условием `backend_type = 'client backend'` (с. 39–44).
- Состояние `state` плюс псевдосостояние `waiting`: `wait_event_type = 'Lock'` означает
  ожидание тяжёлой блокировки, и такие процессы надо исключать из `active` (с. 49–54).
- Маркер ожидания `wait_event_type || '.' || wait_event` показывает, где именно процесс стоит:
  `Client.ClientRead` безобиден, `LWLock.WALWrite`, `Lock.transactionid`, `IO.WALSync` —
  узкие места (с. 51–53).
- Длительности по `xact_start`, `query_start`, `state_change`; у транзакций в состоянии
  `idle in transaction (aborted)` поле `xact_start` пусто, брать `query_start` (с. 58–60).
  Долгие `idle in transaction` — источник блокировок, раздувания и исчерпания
  соединений (с. 56–58).
- `pid` — ключ к `pg_locks`; `query_id` — ключ к `pg_stat_statements.queryid`
  (с 14, при `compute_query_id`) (с. 34, 91).

**Метрики.** Метки у всех: `target`; у клиентских — `datname`, `usename`, `application_name`;
у состояний — `state`, в которое добавлено значение `waiting`.

| Метрика | Тип | Как считается | Метки | Зачем (книга) |
|---|---|---|---|---|
| `postgres_activity_connections` | gauge | `count()` строк с `backend_type = 'client backend'` | `client_addr`, `usename`, `datname`, `application_name` | Сколько и каких клиентов; адреса и пользователи с аномальным числом сеансов; запас до `max_connections` (с. 39–44; `postgres_connected_clients_total`) |
| `postgres_activity_backends` | gauge | `count()` по `backend_type` | `backend_type` | Фоновые службы: сколько `autovacuum worker`, `walsender`, параллельных рабочих (с. 33–34) |
| `postgres_activity_connections_in_flight` | gauge | `count()` по `if(wait_event_type = 'Lock', 'waiting', state)` среди клиентов | `state` | Распределение сеансов по состояниям; рост `waiting` и `idle in transaction` — сигнал проблем (с. 50–54; `postgres_activity_connections_in_flight`) |
| `postgres_activity_wait_events` | gauge | `count()` по `wait_event_type`, `wait_event` среди клиентов с непустым ожиданием | `wait_event_type`, `wait_event` | Куда уходит время: ожидания WAL, блокировок, ввода-вывода, клиента (с. 51–53) |
| `postgres_activity_max_seconds` | gauge | `max(ts − coalesce(xact_start, query_start))` по группе | `state`, `usename`, `datname`, `type` (client / autovacuum) | Самая долгая транзакция или запрос в момент снимка; при `state = 'idle in transaction'` — самая долгая бездействующая транзакция (с. 58–60; `postgres_activity_max_seconds`) |
| `postgres_activity_xact_age_seconds` | histogram | корзины (0.1, 1, 10, 60, 600 с) по `ts − coalesce(xact_start, query_start)` среди клиентов с открытой транзакцией, включая `idle in transaction (aborted)` | `state`, `datname` | Сколько транзакций укладываются в норму, а сколько живут секунды и минуты; дополняет максимум, который показывает один процесс (с. 58–60) |
| `postgres_activity_query_age_seconds` | histogram | корзины по `ts − query_start` при `state = 'active'` | `datname`, `usename` | Распределение длительности выполняющихся запросов; длинный хвост — смена плана или ожидания (с. 58–60) |
| `postgres_activity_state_age_seconds` | gauge | `max(ts − state_change)` по `state` | `state` | Как долго сеанс в текущем состоянии; запасной способ оценить ожидание до PostgreSQL 14 (с. 63–65) |

### 8.2. `pg_locks` (глава 2, с. 35–37, 61–68)

**Что это.** Удерживаемые и ожидаемые тяжёлые блокировки: одна строка на пару
«объект — процесс», объект повторяется, если его ждут несколько процессов. Лёгких блокировок
(LWLock) здесь нет, они видны только как `wait_event_type = 'LWLock'` в `pg_stat_activity`.
Снимок. Почти всегда используется в соединении с `pg_stat_activity` по `pid`.

**На что смотрит автор.**
- `granted = false` — процесс ждёт; `waitstart` (с 14) — единственный достоверный источник
  длительности ожидания, сразу после перехода в ожидание может недолго быть NULL (с. 36, 61).
- Два способа агрегировать ожидания: сумма по всем процессам (сколько СУБД ждёт в целом)
  и максимум (самый долгий процесс, для оперативного мониторинга); агент книги по умолчанию
  собирает максимум (с. 62–63).
- Дерево блокировок: кто кого блокирует, корневой процесс, число заблокированных им (`blkd`).
  `pg_blocking_pids()` берёт исключительный доступ к менеджеру блокировок и для регулярного
  опроса не годится — строить дерево самосоединением `pg_locks` (с. 65–68; запрос 1.13).
- `locktype`, `mode`, `relation` — что именно заблокировано и насколько конфликтный режим.

**Метрики.** Метки: `target`; через соединение с `pg_stat_activity` по `(target, ts, pid)` —
`datname`, `usename`, `state`.

| Метрика | Тип | Как считается | Метки | Зачем (книга) |
|---|---|---|---|---|
| `postgres_locks_count` | gauge | `count()` по `locktype`, `mode`, `granted` | `locktype`, `mode`, `granted` | Профиль блокировок; рост `AccessExclusiveLock` или ожиданий `relation` — DDL, `TRUNCATE`, `VACUUM FULL` в нагрузке (с. 36–37, 68) |
| `postgres_locks_waiting` | gauge | `uniqExact(pid)` среди `granted = false` | `locktype`, `datname` | Сколько процессов стоят в очереди за блокировкой (с. 62) |
| `postgres_locks_wait_max_seconds` | gauge | `max(ts − waitstart)` среди `granted = false` | `datname`, `usename`, `locktype` | Самое долгое ожидание в момент снимка (с. 62–63; `postgres_activity_max_seconds{state="waiting"}`) |
| `postgres_locks_wait_sum_seconds` | gauge | `sum(ts − waitstart)` среди `granted = false` | `datname` | Суммарное ожидание всех процессов: сколько СУБД ждёт вместо полезной работы (с. 62) |
| `postgres_locks_wait_age_seconds` | histogram | корзины (0.1, 1, 10, 60 с) по `ts − waitstart` среди `granted = false` | `locktype` | Сколько ожиданий короткие, а сколько тянутся секунды; дополняет максимум и сумму (с. 62–63) |
| `postgres_locks_blocking` | gauge | число `pid`, которые удерживают объект, ожидаемый другим процессом, и сами ничего не ждут (самосоединение `pg_locks` по полям объекта, запрос 1.13) | `datname`, `usename` | Корневые источники блокировок — процессы, завершение которых разблокирует остальных (с. 65–68) |
| `postgres_locks_blocked_max` | gauge | максимум числа ожидающих на один удерживаемый объект | `locktype` | Ширина дерева: один `TRUNCATE` может держать двадцать процессов (с. 68) |

### 8.3. `pg_stat_statements` (глава 3, с. 73–95; главы 5–6, с. 143–147, 165–166)

**Что это.** Накопительная статистика по типам запросов: текст нормализован (константы
заменены на `$1, $2 …`), одна строка на `(userid, dbid, queryid, toplevel)`. Учитываются только
успешно завершённые запросы; завершившиеся ошибкой или прерванные — нет (с. 73). Глобально
для кластера. `queryid` одинаков для одинакового текста у разных пользователей и баз (с. 75).

**На что смотрит автор.**
- Шесть групп полей: метаданные, планирование (с 13), исполнение, ресурсы (блоки),
  WAL (с 13), JIT (с 15) (с. 75).
- Абсолютные значения имеют смысл только вместе с периодом накопления:
  `now() − pg_stat_statements_info.stats_reset` (с. 85).
- Время исполнения включает ожидание блокировок; большой `stddev_exec_time` при стабильной
  нагрузке — ожидания или смена планов (с. 79, 85–86).
- Главный график книги — top-K запросов по приросту `total_exec_time`; далее по `calls`,
  `rows`, времени IO, «CPU» = `total_exec_time − IO`, `wal_bytes`, временным файлам
  (с. 80–90, 165–166).
- При `pg_stat_statements.track = all` считать только `toplevel = true`, иначе вложенные
  вызовы учитываются дважды (с. 76, 94).
- `dealloc > 0` в `pg_stat_statements_info` — статистику вытесняло, отчёты неточны (с. 94–95).

**Метрики.** Метки у всех строк: `target`, `datname` (по `dbid`), `usename` (по `userid`),
`queryid`, `toplevel`. Все counter — поля как есть; прирост по соседним снимкам (60 с).
Время в представлении в миллисекундах, в метриках — в секундах.

| Метрика | Тип | Как считается | Метки | Зачем (книга) |
|---|---|---|---|---|
| `postgres_statements_query_info` | gauge | константа 1, несёт текст `query` | `query` | Подпись к графикам top-K; текст не тянется в каждую метрику (с. 77; `postgres_statements_query_info`) |
| `postgres_statements_calls_total` | counter | `calls` | — | Производительность в запросах/с и доля каждого типа; самые частые запросы (с. 79–82; `postgres_statements_calls_total`) |
| `postgres_statements_rows_total` | counter | `rows` | — | Запросы, возвращающие тысячи строк: забытый `LIMIT`, обработка на клиенте (с. 82–84; `postgres_statements_rows_total`) |
| `postgres_statements_time_seconds_total` | counter | `total_exec_time` (`mode="executing"`), `total_plan_time` (`planning`), `blk_read_time` (`ioread`), `blk_write_time` (`iowrite`), `temp_blk_read_time` (`tempread`), `temp_blk_write_time` (`tempwrite`), всё / 1000 | `mode` | Главный график: на какие запросы уходит время; планирование требует `track_planning`, ввод-вывод — `track_io_timing` (с. 76–79, 84–88; `postgres_statements_time_seconds_total`) |
| `postgres_statements_cpu_seconds_total` | counter | `total_exec_time − (blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time)`, / 1000 | — | Условное процессорное время, включает ожидания; точнее даёт `pg_stat_kcache` (с. 88–90) |
| `postgres_statements_io_ratio` | gauge | прирост IO-времени / прирост `total_exec_time` за интервал | — | Доля ввода-вывода в общем времени по экземпляру и по запросу; треть времени в IO — кандидат на увеличение кеша или индекс (с. 89–90) |
| `postgres_statements_plans_total` | counter | `plans` | — | Число планирований; подозрительно, когда время планирования растёт при том же числе планирований; `calls` и `plans` независимы из-за prepared statements (с. 76–79) |
| `postgres_statements_exec_time_seconds` | gauge | `min_exec_time`, `max_exec_time`, `mean_exec_time`, `stddev_exec_time`, / 1000 | `stat` (min / max / mean / stddev) | Моменты распределения времени одного вызова; `stddev` далеко от нуля при ровной нагрузке — ожидания блокировок или смена планов. Корзин histogram представление не даёт (с. 79, 85–86) |
| `postgres_statements_plan_time_seconds` | gauge | `min_plan_time`, `max_plan_time`, `mean_plan_time`, `stddev_plan_time`, / 1000 | `stat` | Разброс времени планирования (с. 77–78) |
| `postgres_statements_blocks_total` | counter | `shared_blks_hit / read / dirtied / written`, `local_blks_hit / read / dirtied / written` | `cache` (shared / local), `access` (hit / read / dirtied / written) | Объём ввода-вывода по запросам; локальные кеши — временные таблицы; оценка эффекта оптимизаций и приоритет для них (с. 143–144) |
| `postgres_statements_temp_blocks_total` | counter | `temp_blks_read`, `temp_blks_written` | `op` (read / written) | Запросы, которым не хватает `work_mem`; фиксируется только по завершении запроса (с. 145–147) |
| `postgres_statements_wal_bytes_total` | counter | `wal_bytes` | — | Какие запросы пишут в журнал больше всех (с. 165–166; `postgres_statements_wal_bytes_all_total`) |
| `postgres_statements_wal_records_total`, `postgres_statements_wal_fpi_total` | counter | `wal_records`, `wal_fpi` | — | Состав журнала: записи и полные образы страниц (с. 165) |
| `postgres_statements_jit_total` | counter | `jit_functions`, `jit_inlining_count`, `jit_optimization_count`, `jit_emission_count` и соответствующие `*_time` / 1000 | `stage` | JIT-компиляция (с 15); в книге не разбирается, хранится ради полноты |
| `postgres_statements_tracked` | gauge | `count()` строк снимка | — | Сколько типов запросов отслеживается относительно `pg_stat_statements.max`; приближение к лимиту ведёт к вытеснению (с. 73–74) |

Вне четырёх представлений, но нужно для корректных дельт: `pg_stat_statements_info.dealloc`
(counter) и `stats_reset` (gauge — возраст статистики), с. 85, 94–95. Одна строка, один
дополнительный запрос; добавляется на шаге 2 раздела 7 или откладывается (раздел 9).

### 8.4. `pg_stat_database` (глава 2, с. 37–39, 44–48; глава 4, с. 107–108, 114–116; глава 5, с. 139, 145–146)

**Что это.** Накопительная статистика по каждой базе плюс строка с пустым `datname` для
разделяемых объектов системного каталога. Основано на функциях `pg_stat_get_db_*`.
Единственное текущее поле — `numbackends`, остальные растут с момента `stats_reset`
(с. 37–39). В отличие от снимков, между опросами ничего не теряется.

**На что смотрит автор.**
- `xact_commit + xact_rollback` — транзакционная активность (TPS), сводный график для
  дежурных инженеров (с. 44–45).
- Группа «ошибки и нежелательные события»: `xact_rollback`, `conflicts`, `deadlocks`,
  `checksum_failures`, `sessions_abandoned / fatal / killed` — в идеале график пустой;
  взаимоблокировки и ошибки контрольных сумм серьёзны всегда (с. 114–116).
- Статусы сеансов (с 14): `abandoned` — клиент бросил соединение (утечка в приложении,
  сеть); `fatal` — FATAL-ошибки, включая `idle_in_transaction_session_timeout`; `killed` —
  `pg_terminate_backend` или остановка сервера. Шторм переподключений (crash loop) исчерпывает
  `max_connections` (с. 38, 46–48).
- Время сеансов в миллисекундах: `session_time`, `active_time`, `idle_in_transaction_time`;
  время `idle` считается вычитанием; значения обновляются при смене состояния, поэтому
  возможны скачки (с. 38–39).
- `tup_returned` и `tup_fetched` — прочитанные строки, не отданные клиенту, их нельзя
  суммировать; `tup_inserted / updated / deleted` — без нюансов (с. 107–108).
- Кеш: hit ratio = `blks_hit / (blks_hit + blks_read)`; `blks_read` включает страничный
  кеш ОС (с. 139).
- Временные файлы `temp_files`, `temp_bytes` учитываются при завершении запроса (с. 145–146).

**Метрики.** Метки: `target`, `datname` (пустой `datname` → `shared`).

| Метрика | Тип | Как считается | Метки | Зачем (книга) |
|---|---|---|---|---|
| `postgres_database_numbackends` | gauge | `numbackends` | — | Подключённые клиенты по базам, грубая картина без детализации (с. 37, 39–40) |
| `postgres_database_xacts_total` | counter | `xact_commit` (`result="commit"`), `xact_rollback` (`result="rollback"`) | `result` | TPS = прирост суммы; `rollback` отдельно как счётчик ошибок приложения (с. 44–45, 114–115; `postgres_database_xact_commits_total`, `postgres_database_xact_rollbacks_total`) |
| `postgres_database_sessions_total` | counter | `sessions` (`reason="all"`), `sessions_abandoned`, `sessions_fatal`, `sessions_killed` | `reason` | Частота установления сеансов; `abandoned / fatal / killed` в норме не растут (с. 38, 46–48; `postgres_database_sessions_total`) |
| `postgres_database_session_time_seconds_total` | counter | `session_time`, `active_time`, `idle_in_transaction_time`, / 1000; `idle` = `session_time − active_time − idle_in_transaction_time` | `state` (all / active / idle_in_transaction / idle) | Сколько времени сеансы работают, а сколько держат открытые транзакции; скачки при смене состояния долгих сеансов (с. 38–39) |
| `postgres_database_tuples_total` | counter | `tup_returned`, `tup_fetched`, `tup_inserted`, `tup_updated`, `tup_deleted` | `op` | Колебания рабочей нагрузки по строкам; `returned` и `fetched` не суммировать (с. 107–108; `postgres_database_tuples_*_total`) |
| `postgres_database_blocks_total` | counter | `blks_hit` (`access="hit"`), `blks_read` (`access="read"`) | `access` | Объём ввода-вывода по базам (с. 139) |
| `postgres_database_cache_hit_ratio` | gauge | прирост `blks_hit` / прирост `(blks_hit + blks_read)` за интервал | — | Эффективность буферного кеша; ближе к 1 — хорошо (с. 139) |
| `postgres_database_blk_time_seconds_total` | counter | `blk_read_time`, `blk_write_time`, / 1000 (требует `track_io_timing`) | `op` (read / write) | Время ввода-вывода по базам (с. 139) |
| `postgres_database_temp_files_total` | counter | `temp_files` | — | Частота создания временных файлов (с. 145–146) |
| `postgres_database_temp_bytes_total` | counter | `temp_bytes` | — | Объём временных файлов, кандидат на увеличение `work_mem` (с. 145–146; `postgres_database_temp_bytes_total`) |
| `postgres_database_deadlocks_total` | counter | `deadlocks` | — | Взаимоблокировки; всегда серьёзно, снижают конкурентность (с. 55–56, 115; `postgres_database_deadlocks_total`) |
| `postgres_database_conflicts_total` | counter | `conflicts` | — | Запросы, отменённые конфликтом с воспроизведением WAL; растёт только на репликах (с. 115; `postgres_database_conflicts_total`) |
| `postgres_database_checksum_failures_total` | counter | `checksum_failures` | — | Ошибки контрольных сумм — риск повреждения данных, должен быть 0 (с. 115; `postgres_database_checksum_failures_total`) |
| `postgres_database_checksum_last_failure_timestamp` | gauge | `checksum_last_failure` как unix time | — | Когда была последняя ошибка контрольной суммы (с. 115) |
| `postgres_database_stats_age_seconds` | gauge | `ts − stats_reset` | — | За какой период накоплены счётчики; нужен для нормировки и для обнаружения сброса (с. 39) |

### 8.5. Сводка: вопрос → метрика

| Вопрос дежурного | Метрики |
|---|---|
| Сколько клиентов и кто они, есть ли запас до лимита | `postgres_activity_connections`, `postgres_database_numbackends` (+ `max_connections` из `pg_settings`, вне MVP) |
| Какая нагрузка сейчас | `postgres_database_xacts_total` (TPS), `postgres_statements_calls_total`, `postgres_database_tuples_total` |
| Что делают сеансы, есть ли ожидания | `postgres_activity_connections_in_flight`, `postgres_activity_wait_events`, `postgres_locks_waiting` |
| Есть ли долгие транзакции и бездействующие транзакции | `postgres_activity_max_seconds`, `postgres_activity_xact_age_seconds` |
| Сколько и как долго ждут блокировки, кто корень | `postgres_locks_wait_max_seconds`, `postgres_locks_wait_sum_seconds`, `postgres_locks_wait_age_seconds`, `postgres_locks_blocking` |
| Какие запросы съедают время, IO, CPU, WAL | `postgres_statements_time_seconds_total` по `mode`, `postgres_statements_cpu_seconds_total`, `postgres_statements_wal_bytes_total`, `postgres_statements_temp_blocks_total` |
| Есть ли ошибки | `postgres_database_xacts_total{result="rollback"}`, `postgres_database_deadlocks_total`, `postgres_database_conflicts_total`, `postgres_database_checksum_failures_total`, `postgres_database_sessions_total{reason!="all"}` |
| Хватает ли кеша и памяти | `postgres_database_cache_hit_ratio`, `postgres_statements_io_ratio`, `postgres_database_temp_bytes_total` |

---

## 9. Что отложено

- Materialized views и любые агрегаты в ClickHouse.
- Вычисление дельт и обработка `stats_reset` в коллекторе.
- Вынос текста запроса `pg_stat_statements.query` в отдельную таблицу-словарь.
- Остальные источники книги: `pg_stat_user_tables`, `pg_stat_bgwriter`, `pg_stat_wal`,
  `pg_stat_replication`, `pg_replication_slots`, `pg_stat_progress_*`, `pg_buffercache`.
- Источники, нужные для части метрик раздела 8: `pg_settings` (`max_connections`),
  `pg_stat_statements_info` (`dealloc`, `stats_reset`).
- Поддержка версий PostgreSQL, отличных от 16.
- Несколько целей в одном процессе, обход баз.
- Дашборды (Grafana подключается к сырым таблицам, когда появится потребность).
