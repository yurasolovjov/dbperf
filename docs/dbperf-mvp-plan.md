# dbperf: анализ архитектуры и план MVP

Инструмент dbperf периодически выполняет запросы к статистике PostgreSQL (на основе книги
А. Лесовского «Мониторинг PostgreSQL»), сохраняет результаты в ClickHouse и строит дашборды
поверх materialized views. Этот документ содержит анализ подхода, план последовательности
выполнения запросов на стороне PostgreSQL, схему хранения в ClickHouse и поэтапный план MVP.

Исходные материалы:
- [postgres-monitoring-queries.md](postgres-monitoring-queries.md) — запросы (далее «запрос N.M»);
- [postgres-statistics-views.md](postgres-statistics-views.md) — описание представлений.

---

## 1. Анализ подхода

### 1.1. Что даёт связка PostgreSQL → ClickHouse

В книге агент мониторинга отдаёт метрики в Prometheus, а графики строятся PromQL-запросами
вида `topk_avg(5, rate(...))`. Замена Prometheus на ClickHouse меняет модель данных:

| Аспект | Prometheus (как в книге) | ClickHouse (dbperf) |
|---|---|---|
| Единица хранения | временной ряд «метрика + набор меток» | строка таблицы с произвольным числом типизированных колонок |
| Высокая кардинальность (`queryid` × `dbid` × `userid`, тысячи таблиц) | проблема, ряды дорого стоят | нормальный сценарий, колонки сжимаются |
| Текст запроса, имена объектов | метка `query_info` с трюком `0 * info` | обычные колонки или словарь |
| Дельты накопительных счётчиков | `rate()` на лету | либо считает коллектор, либо оконные функции в SQL |
| Агрегаты для дашбордов | recording rules | materialized views в SummingMergeTree / AggregatingMergeTree |
| Хранение сырых снимков `pg_stat_activity` | не принято | можно хранить выборочно (долгие сеансы, ожидания) и анализировать постфактум |

Вывод: ClickHouse хорошо подходит именно для статистики запросов и объектов (разделы 2–4 и 7
первого документа), где Prometheus упирается в кардинальность. Для скалярных метрик
экземпляра (bgwriter, WAL, archiver) преимущества нет, но хранить их в ClickHouse тоже удобно,
чтобы не разводить два хранилища.

### 1.2. Два класса источников и две стратегии сбора

Из книги (раздел 0 конспекта по представлениям) следуют два принципиально разных режима:

1. **Снимки** (`pg_stat_activity`, `pg_locks`, `pg_stat_replication`, `pg_replication_slots`,
   `pg_stat_progress_*`): между опросами события теряются, поэтому опрашивать нужно часто
   (5–15 с). Строки снимка сохраняются как есть, одна строка ClickHouse на одну строку
   представления; счётчики по состояниям, ожиданиям и максимальные длительности считают
   materialized views, а не коллектор. Это проще всего реализовать и отлаживать, а объём
   (сотни подключений × тик в 10 с) для ClickHouse незначителен.
2. **Накопительные счётчики** (`pg_stat_database`, `pg_stat_statements`, `pg_stat_*_tables`,
   `pg_stat_bgwriter`, `pg_stat_wal`, …): интересны только дельты. Абсолютные значения
   нужны для сверки и для восстановления после сброса (`stats_reset`, перезапуск сервера,
   `pg_stat_statements_reset()`, вытеснение строк при `dealloc`).

### 1.3. Где считать дельты: коллектор или ClickHouse

| Вариант | Плюсы | Минусы |
|---|---|---|
| **A. Коллектор** держит последний снимок в памяти и пишет в ClickHouse и сырое значение, и дельту | Простые MV (`SummingMergeTree` по дельтам); корректная обработка сбросов (коллектор видит `stats_reset`, исчезновение строки, уменьшение счётчика); дашборды не зависят от порядка строк | Состояние в памяти коллектора; после его перезапуска первая дельта теряется (одна точка) |
| B. ClickHouse считает дельты на лету (`lagInFrame`, `runningDifference`) | Коллектор без состояния | Materialized view видит только вставляемый блок и не может взять «предыдущее» значение, поэтому MV с дельтами не построить; оконные функции на каждом запросе дашборда дорого при большой истории; сбросы счётчиков надо фильтровать в каждом запросе |

**Решение для MVP: вариант A.** Коллектор пишет обе величины (`calls`, `calls_delta`),
дельта NULL/пропуск при обнаружении сброса. Materialized views агрегируют дельты.

### 1.4. Схема хранения: одна универсальная таблица или таблица на источник

- **Универсальная таблица метрик** `(ts, target, name, labels Map, value)` удобна для
  скаляров и мелких групп (bgwriter, wal, archiver, состояния сеансов, ожидания, XID).
- **Таблица на источник** нужна там, где у строки много колонок и высокая кардинальность:
  `pg_stat_statements` (40+ полей), таблицы, индексы, сеансы, репликация. Укладывать это
  в EAV-формат значит умножать число строк на число полей и терять возможность
  считать производные показатели (IO/CPU-доля, rows/call) в одной строке.

**Решение: гибрид.** Одна таблица `metrics` для скаляров и 6–7 типизированных таблиц для
многомерных источников (см. раздел 3).

### 1.5. Нагрузка на PostgreSQL от коллектора

Ограничения, которые нужно заложить с самого начала (из книги, с. 66, 131, 211):

- `pg_blocking_pids()` — не для регулярного опроса (эксклюзивный доступ к менеджеру
  блокировок). В MVP не используется; дерево блокировок остаётся ручным запросом.
- `pg_buffercache` на большом `shared_buffers` — сотни тысяч строк; только по расписанию
  (раз в 5–15 минут) и в агрегированном виде.
- `pgstattuple` читает таблицу целиком — только по требованию, не в расписании.
- Функции `pg_ls_*` на каталогах с тысячами файлов — редко (1–5 минут).
- Запросы размеров объектов должны исключать таблицы под `AccessExclusiveLock` (запрос 3.8),
  иначе коллектор повиснет на `VACUUM FULL`.
- `pg_stat_statements` с `max = 10000` — 10 тысяч строк за опрос; интервал не чаще 30–60 с.
- На каждое соединение коллектора: `application_name = 'dbperf'`, `statement_timeout`
  (например, 5 с для снимков, 30 с для тяжёлых), `idle_in_transaction_session_timeout`,
  роль с правами `pg_monitor` без суперпользователя.

### 1.6. Что не ложится в периодический сбор

Эти сценарии из книги остаются вне потока «коллектор → ClickHouse» и в MVP не входят:
дерево блокировок (1.13), `pgstattuple` (7.7), чтение журнала сообщений (deadlock detected,
temporary file, automatic vacuum of table), `EXPLAIN` конкретных запросов, память чужого
процесса (`pg_log_backend_memory_contexts`). Их место — отдельный режим «диагностика по
требованию» в следующих итерациях.

---

## 2. План выполнения запросов на PostgreSQL

### 2.1. Предварительная разведка цели (при старте и раз в час)

Выполняется один раз при подключении к цели и периодически, результат кеширует коллектор
и определяет, какие запросы и в каком варианте выполнять.

| Шаг | Запрос | Зачем |
|---|---|---|
| 1 | `SHOW server_version_num` | выбор варианта запросов (14+: `waitstart`, `sessions_*`, `pg_stat_wal`; 16+: `pg_stat_io`; 17+: `pg_stat_checkpointer`, `shared_blk_*_time`) |
| 2 | `SELECT pg_is_in_recovery()` | роль узла: на реплике нет смысла собирать `pg_stat_replication`, есть смысл собирать `pg_stat_wal_receiver` и `pg_stat_database_conflicts` |
| 3 | `SELECT extname, extversion FROM pg_extension` в каждой БД | наличие `pg_stat_statements` (и где установлено), `pg_buffercache`, `pgstattuple` |
| 4 | `SELECT name, setting FROM pg_settings WHERE name IN (...)` | `track_io_timing`, `track_wal_io_timing`, `track_functions`, `pg_stat_statements.track`, `max_connections`, `block_size`, `autovacuum_vacuum_threshold`, `autovacuum_vacuum_scale_factor`, `autovacuum_naptime`, `autovacuum_freeze_max_age`, `max_wal_size`, `checkpoint_timeout`, `wal_segment_size` |
| 5 | `SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn` | список баз для обхода (минус исключения из конфигурации) |
| 6 | `SELECT rolname, pg_has_role(current_user, 'pg_monitor', 'member')` | проверка прав; при отсутствии часть запросов отключается с предупреждением |

Параметры из шага 4 сохраняются в ClickHouse (таблица `settings`), чтобы дашборды могли
показывать `max_connections` рядом с числом подключений, как на рис. 2.1 книги.

### 2.2. Уровни частоты (tiers)

Запросы разбиты на уровни по стоимости и по типу источника. Внутри тика уровень выполняется
целиком на одном соединении, последовательно, от дешёвых к дорогим; если тик не уложился
в интервал, следующий пропускается, факт фиксируется в метрике самого коллектора.

#### Tier A — снимки, каждые 10 с (настраивается 5–30 с), соединение с базой `postgres`

| № | Запрос | Что пишем в ClickHouse | Примечание |
|---|---|---|---|
| A1 | полный снимок `pg_stat_activity` (все строки, включая фоновые процессы) с вычисленными возрастами и признаком ожидания блокировки | `pg_stat_activity`: одна строка на процесс | единственный запрос к представлению за тик; запросы 1.5–1.8 книги становятся запросами к ClickHouse |
| A2 | 1.10 ожидающие блокировки из `pg_locks` (`NOT granted`, с `waitstart`, 14+) | `pg_locks_waiting`: одна строка на ожидаемую блокировку | для < 14 без `waitstart`, длительность считается по `state_change` из A1 |
| A3 | 6.1 отставание реплик (только на primary) | `replication`: по строке на walsender | |
| A4 | 6.3 слоты репликации | `replication_slots`: по строке на слот | |
| A5 | `pg_stat_progress_vacuum` как есть | `pg_stat_progress_vacuum`: по строке на процесс | расшифровка через JOIN с `pg_stat_activity` по `(ts, pid)` в ClickHouse |
| A6 | на реплике: 6.2 `pg_last_wal_*`, `pg_last_xact_replay_timestamp` | `metrics`: `recovery.replay_delay`, `recovery.replay_backlog` | вместо A3 |

Запрос A1 — первая и самая простая часть MVP (см. раздел 4.3, этап 1). Коллектор ничего
не агрегирует и не фильтрует, кроме приведения типов:

```sql
SELECT
    clock_timestamp()                               AS collected_at,
    datid, datname, pid, leader_pid, usesysid, usename, application_name,
    client_addr, client_hostname, client_port,
    backend_start, xact_start, query_start, state_change,
    wait_event_type, wait_event, state,
    backend_xid::text::bigint                       AS backend_xid,
    backend_xmin::text::bigint                      AS backend_xmin,
    age(backend_xmin)                               AS backend_xmin_age,
    query_id, query, backend_type,
    extract(epoch FROM clock_timestamp() - backend_start) AS backend_age,
    extract(epoch FROM clock_timestamp() - xact_start)    AS xact_age,
    extract(epoch FROM clock_timestamp() - query_start)   AS query_age,
    extract(epoch FROM clock_timestamp() - state_change)  AS state_age,
    (wait_event_type = 'Lock')                      AS is_waiting_lock
FROM pg_stat_activity;
```

Для PostgreSQL < 14 поле `query_id` подставляется как `NULL`. Текст `query` обрезается до
`track_activity_query_size` самим PostgreSQL, дополнительной обрезки нет.

#### Tier B — накопительные счётчики экземпляра, каждые 60 с, соединение с базой `postgres`

| № | Запрос | Таблица ClickHouse | Дельты |
|---|---|---|---|
| B1 | 1.3 + 1.4 + 3.1 + 3.5 + 4.6 + 4.9 как один `SELECT * FROM pg_stat_database` | `database_stats` | все счётчики: `xact_*`, `tup_*`, `blks_*`, `blk_*_time`, `temp_*`, `deadlocks`, `conflicts`, `sessions_*`, `*_time` |
| B2 | 2.11-подобный полный `SELECT` из `pg_stat_statements` (+ `pg_stat_statements_info`) | `statements`, `statements_dict`, `metrics`: `pgss.dealloc`, `pgss.age` | `calls`, `rows`, `total_exec_time`, `total_plan_time`, `shared_blks_*`, `local_blks_*`, `temp_blks_*`, `blk_*_time`, `temp_blk_*_time`, `wal_*` |
| B3 | 4.12 `pg_stat_bgwriter` (17+: `pg_stat_checkpointer`) | `metrics`: `bgwriter.*`, `checkpointer.*` | все счётчики |
| B4 | 5.1 `pg_stat_wal` (14+) | `metrics`: `wal.*` | все, кроме `stats_reset` |
| B5 | 5.5 `pg_stat_archiver` | `metrics`: `archiver.archived`, `archiver.failed`, `archiver.last_archived_age` | счётчики; возраст — текущее значение |
| B6 | 4.5 `pg_stat_slru` | `metrics`: `slru.*{name}` | все счётчики |
| B7 | 16+: `pg_stat_io` | `io_stats` | `reads`, `writes`, `extends`, `hits`, `evictions`, `fsyncs`, времена |
| B8 | 6.4 `pg_stat_replication_slots`, 6.6 `pg_stat_database_conflicts` (реплика) | `metrics` | счётчики |
| B9 | 7.5 запас XID, 7.6 горизонт видимости | `metrics`: `xid.available`, `xid.max_horizon`, `xid.active_horizon` | текущие значения |

Запрос B2 — самый тяжёлый по объёму результата. Текст запроса (`query`) забирается
только для новых `queryid`: коллектор держит множество известных `(queryid, dbid, userid)`
и для них выбирает всё, кроме `query` (вторым запросом `WHERE queryid = ANY($1)`), либо
проще для MVP — забирает всё и дедуплицирует текст на вставке в `ReplacingMergeTree`.

#### Tier C — статистика объектов, каждые 5 мин, обход каждой базы

Для каждой базы из списка (2.1, шаг 5) открывается соединение (или берётся из пула),
выполняются запросы, соединение закрывается. Базы обрабатываются последовательно,
чтобы не создавать N одновременных подключений.

| № | Запрос | Таблица ClickHouse | Дельты |
|---|---|---|---|
| C1 | 3.2 + 3.3 + 7.2 как один `SELECT * FROM pg_stat_user_tables` + `pg_relation_size`/`pg_total_relation_size` + `relfrozenxid`/`age` из `pg_class` | `table_stats` | `seq_scan`, `seq_tup_read`, `idx_scan`, `idx_tup_fetch`, `n_tup_*`, `vacuum_count`, `autovacuum_count`, `analyze_count`, `autoanalyze_count`; текущие: `n_live_tup`, `n_dead_tup`, `n_mod_since_analyze`, `last_*`, размеры, `age(relfrozenxid)` |
| C2 | 3.4 `pg_stat_user_indexes` + размер | `index_stats` | `idx_scan`, `idx_tup_read`, `idx_tup_fetch`; текущее: размер |
| C3 | 4.7 `pg_statio_user_tables` | можно объединить с C1 по `relid` в одну таблицу | `heap_blks_*`, `idx_blks_*`, `toast_blks_*`, `tidx_blks_*` |
| C4 | 2.12 `pg_stat_user_functions` (если `track_functions != none`) | `function_stats` | `calls`, `total_time`, `self_time` |
| C5 | 7.1 потребность в очистке (`boundary`, `av_need`) | считается в ClickHouse из C1 и `settings`; отдельный запрос не нужен | |
| C6 | 3.7 размер базы, 3.6 табличных пространств (один раз за тик, не по базам) | `metrics`: `db.size{datname}`, `tablespace.size{spcname}` | текущие |

Запрос размеров (C1, C2) обязан содержать защиту от `AccessExclusiveLock` из запроса 3.8.
Для баз с десятками тысяч таблиц интервал увеличивается, а список ограничивается
`pg_total_relation_size > порог` или top-N по активности.

#### Tier D — редкие и дорогие, каждые 15 мин

| № | Запрос | Таблица ClickHouse |
|---|---|---|
| D1 | 4.2 состояния буферов (`pg_buffercache`, агрегат) и 4.1 top-20 объектов в кеше | `metrics`: `buffercache.{free,clean,dirty,...}`; `buffercache_top` |
| D2 | 5.6 очередь архивирования (`pg_ls_archive_statusdir`) | `metrics`: `archiver.ready_segments` |
| D3 | 3.10 объём журналов сообщений и WAL-каталога (`pg_ls_logdir`, `pg_ls_waldir`) | `metrics`: `fs.log_size`, `fs.wal_size` |
| D4 | 4.11 активные временные файлы (`pg_ls_tmpdir`) | `temp_files_active` |
| D5 | 7.4 горизонт заморозки по базам | `metrics`: `xid.db_horizon{datname}` |
| D6 | 4.3 `pg_shmem_allocations` (раз в час) | `metrics`: `shmem.size{name}` |

### 2.3. Последовательность в пределах одного тика

```
tick(tier):
  conn = pool.get(target, dbname='postgres')      # для tier C: по каждой базе
  SET application_name = 'dbperf'; SET statement_timeout = <tier timeout>
  for q in tier.queries (в порядке таблиц выше):
      if not q.applicable(version, role, extensions, settings): skip
      rows = conn.execute(q.sql_for(version))
      if q.cumulative:
          rows = delta_engine.apply(target, q.key, rows)   # добавляет *_delta, помечает сбросы
      buffer.append(q.table, rows)
      self_metrics.record(q.name, duration, rowcount, error)
  clickhouse.insert_batches(buffer)                # одна вставка на таблицу за тик
```

Правила delta-engine:
- ключ строки: `pg_stat_database` → `datname`; `pg_stat_statements` → `(queryid, dbid, userid, toplevel)`;
  таблицы → `(datname, relid)`; индексы → `(datname, indexrelid)`; скаляры → имя метрики + метки;
- дельта = `cur − prev`, если `prev` есть, `stats_reset` не изменился и `cur ≥ prev`;
  иначе дельта NULL (первая точка, сброс, перезапуск, `dealloc`);
- старые ключи, не пришедшие в текущем снимке, удаляются из памяти после N тиков;
- `*_time` в миллисекундах переводятся в секунды (`Float64`) при записи.

### 2.4. Таймауты и защита

| Уровень | `statement_timeout` | Лимит строк | Поведение при ошибке |
|---|---|---|---|
| A | 3 с | `pg_stat_activity` ≤ `max_connections` строк, лимита нет | пропуск запроса, метрика ошибки, повтор на следующем тике |
| B | 15 с | `statements` ≤ `pg_stat_statements.max` | то же |
| C | 30 с на базу | таблиц ≤ 10 000 на базу | база помечается «медленной», интервал удваивается |
| D | 60 с | | то же |

Коллектор никогда не выполняет `pg_terminate_backend`, `VACUUM` и другие изменяющие команды.

---

## 3. Схема хранения в ClickHouse

### 3.1. Общие соглашения

- Все таблицы `MergeTree`, партиционирование `toYYYYMMDD(ts)` (или по месяцам для редких),
  `ORDER BY (target, <ключ>, ts)`, `TTL ts + INTERVAL 30 DAY` для сырых данных,
  агрегаты (MV) хранятся дольше (90–365 дней).
- `target` — `LowCardinality(String)`, идентификатор экземпляра PostgreSQL из конфигурации.
- `ts` — `DateTime` начала тика (одно значение на все строки тика), плюс `collected_at`
  `DateTime64(3)` фактического времени запроса для отладки.
- Дельты хранятся в колонках с суффиксом `_d` типа `Nullable(UInt64)`/`Nullable(Float64)`.

### 3.2. Таблицы

```sql
-- скаляры и мелкие группы (tier A/B/D)
CREATE TABLE metrics (
    ts        DateTime,
    target    LowCardinality(String),
    name      LowCardinality(String),         -- 'activity.sessions', 'wal.wal_bytes', ...
    labels    Map(LowCardinality(String), String),
    value     Float64,                        -- текущее/сырое значение
    delta     Nullable(Float64)               -- для накопительных
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, name, labels, ts)
TTL ts + INTERVAL 30 DAY;

-- pg_stat_statements: числа отдельно от текста
CREATE TABLE statements (
    ts DateTime, target LowCardinality(String),
    queryid Int64, dbid UInt32, userid UInt32, toplevel UInt8,
    calls UInt64, calls_d Nullable(UInt64),
    rows UInt64, rows_d Nullable(UInt64),
    plans UInt64, plans_d Nullable(UInt64),
    total_exec_time Float64, total_exec_time_d Nullable(Float64),
    total_plan_time Float64, total_plan_time_d Nullable(Float64),
    blk_read_time Float64, blk_read_time_d Nullable(Float64),
    blk_write_time Float64, blk_write_time_d Nullable(Float64),
    temp_blk_read_time Float64, temp_blk_read_time_d Nullable(Float64),
    temp_blk_write_time Float64, temp_blk_write_time_d Nullable(Float64),
    shared_blks_hit UInt64, shared_blks_hit_d Nullable(UInt64),
    shared_blks_read UInt64, shared_blks_read_d Nullable(UInt64),
    shared_blks_dirtied UInt64, shared_blks_dirtied_d Nullable(UInt64),
    shared_blks_written UInt64, shared_blks_written_d Nullable(UInt64),
    local_blks_read UInt64, local_blks_read_d Nullable(UInt64),
    local_blks_written UInt64, local_blks_written_d Nullable(UInt64),
    temp_blks_read UInt64, temp_blks_read_d Nullable(UInt64),
    temp_blks_written UInt64, temp_blks_written_d Nullable(UInt64),
    wal_records UInt64, wal_records_d Nullable(UInt64),
    wal_fpi UInt64, wal_fpi_d Nullable(UInt64),
    wal_bytes UInt64, wal_bytes_d Nullable(UInt64),
    mean_exec_time Float64, stddev_exec_time Float64,
    min_exec_time Float64, max_exec_time Float64
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, dbid, userid, queryid, toplevel, ts)
TTL ts + INTERVAL 14 DAY;

CREATE TABLE statements_dict (
    target LowCardinality(String),
    queryid Int64, dbid UInt32, userid UInt32,
    datname LowCardinality(String), usename LowCardinality(String),
    query String,
    first_seen DateTime, last_seen DateTime
) ENGINE = ReplacingMergeTree(last_seen)
ORDER BY (target, dbid, userid, queryid);

-- полный снимок pg_stat_activity (tier A1): колонки повторяют представление PostgreSQL 16,
-- плюс вычисленные на стороне PostgreSQL возрасты в секундах
CREATE TABLE pg_stat_activity (
    ts               DateTime,                      -- начало тика
    collected_at     DateTime64(3),                 -- clock_timestamp() на стороне PostgreSQL
    target           LowCardinality(String),
    datid            Nullable(UInt32),
    datname          LowCardinality(Nullable(String)),
    pid              UInt32,
    leader_pid       Nullable(UInt32),
    usesysid         Nullable(UInt32),
    usename          LowCardinality(Nullable(String)),
    application_name LowCardinality(String),
    client_addr      Nullable(String),
    client_hostname  Nullable(String),
    client_port      Nullable(Int32),
    backend_start    DateTime64(6),
    xact_start       Nullable(DateTime64(6)),
    query_start      Nullable(DateTime64(6)),
    state_change     Nullable(DateTime64(6)),
    wait_event_type  LowCardinality(Nullable(String)),
    wait_event       LowCardinality(Nullable(String)),
    state            LowCardinality(Nullable(String)),
    backend_xid      Nullable(Int64),
    backend_xmin     Nullable(Int64),
    backend_xmin_age Nullable(UInt32),
    query_id         Nullable(Int64),
    query            String,
    backend_type     LowCardinality(String),
    backend_age      Float64,
    xact_age         Nullable(Float64),
    query_age        Nullable(Float64),
    state_age        Nullable(Float64),
    is_waiting_lock  UInt8
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, ts, pid)
TTL ts + INTERVAL 7 DAY;

-- ожидаемые блокировки (tier A2), одна строка на пару «процесс – объект»
CREATE TABLE pg_locks_waiting (
    ts DateTime, target LowCardinality(String),
    pid UInt32, locktype LowCardinality(String), mode LowCardinality(String),
    database Nullable(UInt32), relation Nullable(UInt32),
    page Nullable(Int32), tuple Nullable(Int16),
    virtualxid Nullable(String), transactionid Nullable(Int64),
    virtualtransaction String,
    waitstart Nullable(DateTime64(6)), wait_age Nullable(Float64)
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, ts, pid)
TTL ts + INTERVAL 7 DAY;

-- pg_stat_database (tier B1): все счётчики + дельты, по аналогии со statements
CREATE TABLE database_stats ( ts DateTime, target LowCardinality(String),
    datname LowCardinality(String), numbackends UInt32,
    xact_commit UInt64, xact_commit_d Nullable(UInt64),
    xact_rollback UInt64, xact_rollback_d Nullable(UInt64),
    blks_read UInt64, blks_read_d Nullable(UInt64),
    blks_hit UInt64, blks_hit_d Nullable(UInt64),
    tup_returned UInt64, tup_returned_d Nullable(UInt64),
    tup_fetched UInt64, tup_fetched_d Nullable(UInt64),
    tup_inserted UInt64, tup_inserted_d Nullable(UInt64),
    tup_updated UInt64, tup_updated_d Nullable(UInt64),
    tup_deleted UInt64, tup_deleted_d Nullable(UInt64),
    conflicts UInt64, conflicts_d Nullable(UInt64),
    temp_files UInt64, temp_files_d Nullable(UInt64),
    temp_bytes UInt64, temp_bytes_d Nullable(UInt64),
    deadlocks UInt64, deadlocks_d Nullable(UInt64),
    checksum_failures UInt64, checksum_failures_d Nullable(UInt64),
    blk_read_time Float64, blk_read_time_d Nullable(Float64),
    blk_write_time Float64, blk_write_time_d Nullable(Float64),
    sessions UInt64, sessions_d Nullable(UInt64),
    sessions_abandoned UInt64, sessions_abandoned_d Nullable(UInt64),
    sessions_fatal UInt64, sessions_fatal_d Nullable(UInt64),
    sessions_killed UInt64, sessions_killed_d Nullable(UInt64),
    session_time Float64, session_time_d Nullable(Float64),
    active_time Float64, active_time_d Nullable(Float64),
    idle_in_transaction_time Float64, idle_in_transaction_time_d Nullable(Float64),
    stats_reset DateTime
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, datname, ts) TTL ts + INTERVAL 30 DAY;

-- tier C: таблицы и индексы
CREATE TABLE table_stats ( ts DateTime, target LowCardinality(String),
    datname LowCardinality(String), schemaname LowCardinality(String), relname String, relid UInt32,
    seq_scan UInt64, seq_scan_d Nullable(UInt64),
    seq_tup_read UInt64, seq_tup_read_d Nullable(UInt64),
    idx_scan UInt64, idx_scan_d Nullable(UInt64),
    idx_tup_fetch UInt64, idx_tup_fetch_d Nullable(UInt64),
    n_tup_ins UInt64, n_tup_ins_d Nullable(UInt64),
    n_tup_upd UInt64, n_tup_upd_d Nullable(UInt64),
    n_tup_del UInt64, n_tup_del_d Nullable(UInt64),
    n_tup_hot_upd UInt64, n_tup_hot_upd_d Nullable(UInt64),
    n_live_tup UInt64, n_dead_tup UInt64, n_mod_since_analyze UInt64,
    vacuum_count UInt64, vacuum_count_d Nullable(UInt64),
    autovacuum_count UInt64, autovacuum_count_d Nullable(UInt64),
    analyze_count UInt64, analyze_count_d Nullable(UInt64),
    autoanalyze_count UInt64, autoanalyze_count_d Nullable(UInt64),
    last_vacuum Nullable(DateTime), last_autovacuum Nullable(DateTime),
    last_analyze Nullable(DateTime), last_autoanalyze Nullable(DateTime),
    heap_blks_read UInt64, heap_blks_read_d Nullable(UInt64),
    heap_blks_hit UInt64, heap_blks_hit_d Nullable(UInt64),
    idx_blks_read UInt64, idx_blks_read_d Nullable(UInt64),
    idx_blks_hit UInt64, idx_blks_hit_d Nullable(UInt64),
    relation_size UInt64, total_relation_size UInt64,
    reltuples Float64, relfrozenxid_age UInt32
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, datname, relid, ts) TTL ts + INTERVAL 30 DAY;

CREATE TABLE index_stats ( ts DateTime, target LowCardinality(String),
    datname LowCardinality(String), schemaname LowCardinality(String),
    relname String, indexrelname String, indexrelid UInt32,
    idx_scan UInt64, idx_scan_d Nullable(UInt64),
    idx_tup_read UInt64, idx_tup_read_d Nullable(UInt64),
    idx_tup_fetch UInt64, idx_tup_fetch_d Nullable(UInt64),
    index_size UInt64
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, datname, indexrelid, ts) TTL ts + INTERVAL 30 DAY;

-- репликация (tier A6/A7), снимки
CREATE TABLE replication ( ts DateTime, target LowCardinality(String),
    client_addr String, application_name LowCardinality(String),
    state LowCardinality(String), sync_state LowCardinality(String),
    total_lag_bytes UInt64, pending_bytes UInt64, write_lag_bytes UInt64,
    flush_lag_bytes UInt64, replay_lag_bytes UInt64,
    write_lag Float64, flush_lag Float64, replay_lag Float64
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, client_addr, application_name, ts) TTL ts + INTERVAL 30 DAY;

CREATE TABLE replication_slots ( ts DateTime, target LowCardinality(String),
    slot_name LowCardinality(String), slot_type LowCardinality(String),
    active UInt8, backlog_bytes UInt64, wal_status LowCardinality(String),
    safe_wal_size Nullable(Int64), xmin_age Nullable(UInt32), catalog_xmin_age Nullable(UInt32)
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, slot_name, ts) TTL ts + INTERVAL 30 DAY;

-- параметры и метаданные цели (2.1)
CREATE TABLE settings ( ts DateTime, target LowCardinality(String),
    name LowCardinality(String), setting String, unit LowCardinality(String)
) ENGINE = ReplacingMergeTree(ts) ORDER BY (target, name);

-- самонаблюдение коллектора
CREATE TABLE collector_runs ( ts DateTime, target LowCardinality(String),
    tier LowCardinality(String), query LowCardinality(String), datname LowCardinality(String),
    duration_ms UInt32, rows UInt32, error String
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts)
ORDER BY (target, tier, query, ts) TTL ts + INTERVAL 7 DAY;
```

Таблицы `function_stats`, `io_stats`, `vacuum_progress`, `buffercache_top`,
`temp_files_active` строятся по тому же образцу.

### 3.3. Materialized views для дашбордов

Для снимков MV считают агрегаты прямо по сырым строкам; для накопительных источников —
по дельтам, которые уже вычислил коллектор. В обоих случаях хватает `SummingMergeTree` /
`AggregatingMergeTree`.

```sql
-- состояния и ожидания сеансов (глава 2): замена запросов 1.5, 1.6, 1.7, 1.8 книги.
-- Каждый тик даёт по одной строке на (state, wait_event_type, wait_event);
-- count — число сеансов в снимке, max_* — худший сеанс в этом состоянии.
CREATE TABLE activity_by_state (
    ts DateTime, target LowCardinality(String),
    backend_type LowCardinality(String),
    state LowCardinality(String),                -- с псевдосостоянием 'waiting'
    wait_event_type LowCardinality(String), wait_event LowCardinality(String),
    sessions UInt32,
    max_xact_age SimpleAggregateFunction(max, Float64),
    max_query_age SimpleAggregateFunction(max, Float64),
    max_state_age SimpleAggregateFunction(max, Float64)
) ENGINE = SummingMergeTree((sessions))
PARTITION BY toYYYYMM(ts)
ORDER BY (target, ts, backend_type, state, wait_event_type, wait_event)
TTL ts + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW activity_by_state_mv TO activity_by_state AS
SELECT
    ts, target, backend_type,
    if(is_waiting_lock = 1, 'waiting', ifNull(state, '')) AS state,
    ifNull(wait_event_type, '') AS wait_event_type,
    ifNull(wait_event, '')      AS wait_event,
    count()                     AS sessions,
    max(ifNull(xact_age, 0))    AS max_xact_age,
    max(ifNull(query_age, 0))   AS max_query_age,
    max(ifNull(state_age, 0))   AS max_state_age
FROM pg_stat_activity
GROUP BY ts, target, backend_type, state, wait_event_type, wait_event;

-- подключения по адресу/пользователю/базе (запрос 1.2 книги)
CREATE TABLE activity_by_client (
    ts DateTime, target LowCardinality(String),
    client_addr String, usename LowCardinality(String),
    datname LowCardinality(String), application_name LowCardinality(String),
    sessions UInt32
) ENGINE = SummingMergeTree((sessions))
PARTITION BY toYYYYMM(ts)
ORDER BY (target, ts, client_addr, usename, datname, application_name)
TTL ts + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW activity_by_client_mv TO activity_by_client AS
SELECT ts, target, ifNull(client_addr, '') AS client_addr, ifNull(usename, '') AS usename,
       ifNull(datname, '') AS datname, application_name, count() AS sessions
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY ts, target, client_addr, usename, datname, application_name;

-- сводка ожиданий блокировок (запрос 1.11 книги)
CREATE TABLE locks_summary (
    ts DateTime, target LowCardinality(String),
    waiting_pids UInt32,
    max_wait SimpleAggregateFunction(max, Float64),
    sum_wait SimpleAggregateFunction(sum, Float64)
) ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (target, ts)
TTL ts + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW locks_summary_mv TO locks_summary AS
SELECT ts, target, uniqExact(pid) AS waiting_pids,
       max(ifNull(wait_age, 0)) AS max_wait, sum(ifNull(wait_age, 0)) AS sum_wait
FROM pg_locks_waiting
GROUP BY ts, target;

-- поминутная свёртка pg_stat_statements: основа всех top-K графиков из главы 3
CREATE TABLE statements_1m (
    minute DateTime, target LowCardinality(String),
    queryid Int64, dbid UInt32, userid UInt32,
    calls UInt64, rows UInt64,
    exec_time Float64, plan_time Float64,
    io_time Float64,                    -- blk_read + blk_write + temp_blk_read + temp_blk_write
    cpu_time Float64,                   -- exec_time - io_time
    shared_blks_read UInt64, shared_blks_hit UInt64,
    temp_blks_written UInt64, wal_bytes UInt64
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (target, minute, dbid, userid, queryid)
TTL minute + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW statements_1m_mv TO statements_1m AS
SELECT
    toStartOfMinute(ts) AS minute, target, queryid, dbid, userid,
    sum(calls_d) AS calls, sum(rows_d) AS rows,
    sum(total_exec_time_d) AS exec_time, sum(total_plan_time_d) AS plan_time,
    sum(blk_read_time_d + blk_write_time_d + temp_blk_read_time_d + temp_blk_write_time_d) AS io_time,
    sum(total_exec_time_d - (blk_read_time_d + blk_write_time_d + temp_blk_read_time_d + temp_blk_write_time_d)) AS cpu_time,
    sum(shared_blks_read_d) AS shared_blks_read, sum(shared_blks_hit_d) AS shared_blks_hit,
    sum(temp_blks_written_d) AS temp_blks_written, sum(wal_bytes_d) AS wal_bytes
FROM statements
WHERE calls_d IS NOT NULL AND toplevel = 1
GROUP BY minute, target, queryid, dbid, userid;

-- часовая свёртка по таблицам (глава 4): seq scan, записи, очистки
CREATE TABLE table_stats_1h ( hour DateTime, target LowCardinality(String),
    datname LowCardinality(String), relid UInt32, relname String,
    seq_scan UInt64, seq_tup_read UInt64, idx_scan UInt64,
    n_tup_ins UInt64, n_tup_upd UInt64, n_tup_del UInt64, n_tup_hot_upd UInt64,
    autovacuum_count UInt64, heap_blks_read UInt64, heap_blks_hit UInt64,
    max_size SimpleAggregateFunction(max, UInt64),
    max_dead_tup SimpleAggregateFunction(max, UInt64)
) ENGINE = SummingMergeTree ORDER BY (target, datname, relid, hour)
TTL hour + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW table_stats_1h_mv TO table_stats_1h AS
SELECT toStartOfHour(ts) AS hour, target, datname, relid, any(relname) AS relname,
    sum(seq_scan_d) AS seq_scan, sum(seq_tup_read_d) AS seq_tup_read, sum(idx_scan_d) AS idx_scan,
    sum(n_tup_ins_d) AS n_tup_ins, sum(n_tup_upd_d) AS n_tup_upd, sum(n_tup_del_d) AS n_tup_del,
    sum(n_tup_hot_upd_d) AS n_tup_hot_upd, sum(autovacuum_count_d) AS autovacuum_count,
    sum(heap_blks_read_d) AS heap_blks_read, sum(heap_blks_hit_d) AS heap_blks_hit,
    max(total_relation_size) AS max_size, max(n_dead_tup) AS max_dead_tup
FROM table_stats WHERE seq_scan_d IS NOT NULL
GROUP BY hour, target, datname, relid;

-- поминутные агрегаты скаляров: avg/max/sum дельт
CREATE TABLE metrics_1m ( minute DateTime, target LowCardinality(String),
    name LowCardinality(String), labels Map(LowCardinality(String), String),
    value_avg AggregateFunction(avg, Float64), value_max AggregateFunction(max, Float64),
    delta_sum AggregateFunction(sum, Nullable(Float64))
) ENGINE = AggregatingMergeTree ORDER BY (target, name, labels, minute)
TTL minute + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW metrics_1m_mv TO metrics_1m AS
SELECT toStartOfMinute(ts) AS minute, target, name, labels,
    avgState(value) AS value_avg, maxState(value) AS value_max, sumState(delta) AS delta_sum
FROM metrics GROUP BY minute, target, name, labels;
```

Типовой запрос дашборда «top-5 запросов по времени выполнения + other» (аналог
`topk_avg` из книги) строится по `statements_1m` с `LIMIT 5` по сумме за окно и
отдельной строкой `other` через `UNION ALL`, текст запроса подтягивается `JOIN statements_dict`.

### 3.4. Дашборды MVP (соответствие главам книги)

| Дашборд | Панели | Источник |
|---|---|---|
| Activity | подключения vs `max_connections`, по адресу/пользователю/базе, сеансы по состояниям (с `waiting`), ожидания по типам и событиям, max длительность транзакций/запросов/состояний, ожидания блокировок (число, max, sum), активные очистки | `activity_by_state`, `activity_by_client`, `locks_summary`, `pg_stat_activity`, `settings` |
| Overview | TPS (commit/rollback), hit ratio, ошибки (rollback, deadlocks, conflicts, checksum, sessions_*) | `metrics_1m`, `database_stats` |
| Queries | top-K по calls, rows, exec_time, io_time, cpu_time, wal_bytes, temp; таблица запросов с долями; детали одного `queryid` | `statements_1m`, `statements_dict` |
| Sessions | таблица строк `pg_stat_activity` на выбранный момент или за период с фильтрами по состоянию, пользователю, приложению, возрасту; переход к `queryid` в Queries | `pg_stat_activity`, `pg_locks_waiting` |
| Tables & indexes | top-K seq_tup_read, обновлений/вставок/удалений, HOT %, самые большие и быстрорастущие объекты, неиспользуемые индексы | `table_stats_1h`, `index_stats` |
| Vacuum & XID | таблицы с `n_dead_tup` выше порога, время с последней автоочистки, частота очисток, запас XID, горизонт видимости, активные очистки | `table_stats`, `metrics`, `vacuum_progress` |
| I/O, cache, WAL | hit ratio, blk_read/write_time, checkpoints timed/req, checkpoint write/sync time, buffers by writer, wal_bytes/records/fpi, wal_buffers_full, archiver age/failed/queue, буферный кеш по состояниям | `metrics_1m`, `database_stats` |
| Replication | отставание реплик в байтах и секундах по этапам, слоты (backlog, wal_status, safe_wal_size), конфликты | `replication`, `replication_slots`, `metrics` |

---

## 4. План создания MVP

### 4.1. Состав MVP

**Входит:**
- коллектор для одной или нескольких целей PostgreSQL 14–16 (primary и реплика);
- tiers A, B, C полностью, tier D частично (D1, D2, D5);
- ClickHouse-схема из раздела 3 с миграциями и TTL;
- materialized views `statements_1m`, `table_stats_1h`, `metrics_1m`;
- дашборды из раздела 3.4 в Grafana (ClickHouse datasource) как JSON в репозитории;
- docker-compose окружение: PostgreSQL + pgbench-нагрузка (по образцу playground из
  репозитория книги), реплика, ClickHouse, Grafana, коллектор;
- самонаблюдение коллектора (`collector_runs`, метрика лага и ошибок).

**Не входит (следующие итерации):** дерево блокировок, `pgstattuple`, разбор журнала
сообщений, собственный UI вместо Grafana, алертинг, логическая репликация
(`pg_stat_subscription*`), PostgreSQL 17+ (только версионные заглушки), мультитенантность
и аутентификация.

### 4.2. Архитектура коллектора

```
config.yaml ──► Targets ──► Scheduler (tier timers) ──► QueryRunner (pgx/psycopg)
                                   │                          │
                                   │                          ▼
                                   │                    DeltaEngine (in-memory last snapshot)
                                   │                          │
                                   ▼                          ▼
                             SelfMetrics ◄────────────  Buffer ──► ClickHouseWriter (batch insert)
```

- Запросы хранятся как файлы `queries/<tier>/<name>.sql` с метаданными (минимальная
  версия, нужные расширения, ключ строки, список накопительных колонок, целевая таблица).
  Это позволяет добавлять запросы из книги без правки кода.
- Один долгоживущий пул соединений на цель; для tier C — короткие соединения к каждой базе.
- Вставка в ClickHouse батчами раз в тик, формат `JSONEachRow` или нативный протокол,
  с повтором при недоступности и ограниченным буфером в памяти (при переполнении
  теряются самые старые батчи, факт фиксируется).
- Язык: Go (библиотеки `pgx`, `clickhouse-go`, один бинарник, как у pgSCV автора книги)
  или Python (`psycopg`, `clickhouse-connect`, быстрее прототипировать). Выбор не влияет
  на остальной план.

### 4.3. Этапы

| Этап | Содержание | Результат |
|---|---|---|
| 0. Окружение | docker-compose с PostgreSQL 16 (`pg_stat_statements`, `pg_buffercache`, `track_io_timing`), pgbench-нагрузкой, репликой, ClickHouse, Grafana; скрипт создания роли `dbperf` с `pg_monitor` | `make up` поднимает стенд с нагрузкой |
| 1. `pg_stat_activity` как есть | минимальный коллектор: одна цель, одно соединение, тик 10 с, запрос A1, вставка строк в таблицу `pg_stat_activity`; MV `activity_by_state`, `activity_by_client`; таблицы `settings`, `collector_runs`; дашборд Activity | первый сквозной путь PostgreSQL → ClickHouse → Grafana на самом простом источнике; на нём отлаживаются конфигурация, планировщик, writer и формат файлов запросов |
| 2. Остальные снимки | A2 `pg_locks_waiting` + MV `locks_summary`, A3–A4 репликация и слоты, A5 прогресс очистки, A6 реплика; разведка цели (2.1) | дашборды Sessions и Replication |
| 3. Дельты и счётчики экземпляра | DeltaEngine с обработкой сбросов, таблицы `metrics`, `statements`, `statements_dict`, `database_stats`, MV `statements_1m`, `metrics_1m`, tier B целиком | дашборды Queries и Overview, панели I/O и WAL |
| 4. Объекты баз | обход баз, tier C (`table_stats`, `index_stats`, `function_stats`), MV `table_stats_1h`, tier D1/D2/D5 | дашборды Tables & indexes, Vacuum & XID, I/O-панели буферного кеша и архивирования |
| 5. Стабилизация | нагрузочная проверка коллектора на базе с 10k таблиц и `pg_stat_statements.max = 10000`, измерение нагрузки на PostgreSQL (сам коллектор виден в `pg_stat_statements` по `application_name`), TTL и размер ClickHouse, документация по установке и конфигурации | релиз MVP |

### 4.4. Критерии приёмки MVP

- Этап 1: на стенде с pgbench дашборд Activity показывает графики рис. 2.1–2.10 книги
  (подключения, состояния, ожидания, длительности) с шагом 10 с, а любой момент времени
  можно «развернуть» в полный список строк `pg_stat_activity`.
- На стенде с pgbench все графики из глав 2–8 книги, перечисленные в разделе 3.4,
  воспроизводятся с интервалом данных не хуже 1 минуты (снимки — 10 с).
- Суммарная доля времени запросов коллектора в `pg_stat_statements` цели < 1 %
  общего `total_exec_time` при стандартной нагрузке pgbench.
- Перезапуск коллектора, `pg_stat_statements_reset()` и перезапуск PostgreSQL не порождают
  отрицательных или аномально больших дельт на графиках.
- Выпадение ClickHouse на 5 минут не приводит к падению коллектора; данные после
  восстановления доставляются из буфера.
- Запросы дашбордов по `statements_1m` за 24 часа при 10 000 типов запросов выполняются
  < 2 с.

### 4.5. Риски и открытые вопросы

| Риск | Смягчение |
|---|---|
| Рост `statements` при большом `pg_stat_statements.max` и частом опросе | интервал B ≥ 60 с, TTL 14 дней, фильтр `calls_d > 0` при вставке (неизменившиеся строки не пишем) |
| Кардинальность `labels` в `metrics` (например, `wait_event`) | фиксированный набор меток на метрику, `LowCardinality` |
| Объём `pg_stat_activity` при сотнях подключений и тексты запросов с реальными параметрами | TTL 7 дней на сырую таблицу (агрегаты в MV живут 90 дней); при необходимости маскирование `query` в коллекторе или сокращение `track_activity_query_size`; доступ к сырой таблице ограничивается ролью ClickHouse |
| Разные версии PostgreSQL у целей | варианты SQL по `server_version_num`, набор тестов на 14/15/16 в CI через docker |
| Коллектор создаёт нагрузку на цель | `statement_timeout`, последовательный обход баз, самонаблюдение, порог отключения запроса при превышении времени |
| Рассинхронизация часов цели и коллектора | `ts` берётся с коллектора, значения длительностей считаются на стороне PostgreSQL через `clock_timestamp()` |
| Сброс статистики посреди интервала | DeltaEngine сравнивает `stats_reset` и отбрасывает дельту |
| Доступ к `pg_ls_*` требует `pg_monitor` | tier D отключается с предупреждением при отсутствии прав |

Открытые вопросы для решения до этапа 1: язык реализации; хранить ли текст запроса
целиком или обрезать до N КБ (книга, с. 148: тексты могут достигать мегабайт);
нужна ли поддержка нескольких ClickHouse-кластеров и Replicated-таблиц уже в MVP.
