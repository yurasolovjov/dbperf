# dbperf: план реализации сервиса на Go и модель данных ClickHouse

Сервис собирает `pg_stat_activity` с наблюдаемых баз PostgreSQL, пишет снимки в ClickHouse
пакетами и отдаёт данные для дашборда «Активность сессии» по gRPC. Документ опирается на
материалы каталога `docs`: план MVP ([dbperf-mvp-simple.md](dbperf-mvp-simple.md)),
описание дашборда ([dbperf-dashboard-session-activity.md](dbperf-dashboard-session-activity.md)),
логику Kintsugi ([basic.yaml](basic.yaml), [data_activity.yaml](data_activity.yaml),
[Activity_only.txt](Activity_only.txt)) и API-описание ([dbperf_api_tech_doc.txt](dbperf_api_tech_doc.txt)).
Рекомендации по ClickHouse сверены с документацией через MCP ClickHouse (раздел 8.6).

Целевая нагрузка: **50 000 наблюдаемых баз PostgreSQL**.

Что требует согласования до начала кода — в разделе 12. gRPC-интерфейс — в разделе 9.

---

## 1. Границы

**Входит.**
- Слой 1: реестр наблюдаемых баз (список целей, распределение по экземплярам сервиса).
- Слой 2: по одному постоянному соединению на базу через `pgconn`, без пула; периодический
  запрос к `pg_stat_activity`.
- Слой 3: пакетная запись в ClickHouse.
- Схема ClickHouse: сырые снимки активных сессий, счётчик снимков, тексты запросов,
  минутные агрегаты.
- gRPC-интерфейс чтения для дашборда: временные ряды по срезам, топы, итоги, строки снимка.
- Оценка нагрузки и размер кластера ClickHouse.

**Не входит в первую версию** (заложено в модель, реализуется следующим этапом): `pg_locks`
и дерево блокировок, `pg_stat_statements`, `pg_stat_database`, оповещения, UI.

---

## 2. Решения, взятые из материалов

| Решение | Источник | Выбор |
|---|---|---|
| Что хранить из `pg_stat_activity` | Kintsugi хранит только активные строки, MVP — все строки | **Только активные строки** плюс одна строка-маркер на снимок. Все строки для 50 000 баз — это сотни тысяч строк в секунду без пользы для дашборда |
| Активность | Kintsugi: `state IN ('active','fastpath function call')`, без `backend_type` | То же, но с колонкой `backend_type` в данных, чтобы фильтровать `autovacuum worker` и `walsender` на стороне чтения |
| Правило CPU | Kintsugi: оба поля NULL и `state = 'active'` → `CPU` | То же, вычисляется в коллекторе |
| Ключ разреза SQL | Kintsugi: точный текст; описание дашборда: `query_id` | **`query_id` при PostgreSQL ≥ 14, иначе `cityHash64(query)`** в колонке `query_hash`; текст — в отдельной таблице по хэшу |
| Собственные сеансы | Kintsugi исключает только свой pid | Исключается свой pid в запросе и `application_name = 'dbperf'` при чтении |
| Интервал снимка | Kintsugi 1–3 с, MVP 10 с | **10 с по умолчанию**, настраивается на цель (5 с для важных) |
| Два уровня хранения | Kintsugi: секундный (не более 2 ч) и минутный | Сырые снимки 7 дней, минутный агрегат 30 дней; выбор уровня по диапазону запроса |
| Дельты счётчиков | План MVP, раздел 1.3 | Не нужны: активность — снимок, не счётчик |

---

## 3. Архитектура

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │ dbperf (экземпляр k из N)                                     │
                    │                                                              │
 реестр целей ─────▶│ Слой 1  registry     список целей, закреплённых за k         │
 (PostgreSQL meta   │           │ TargetSource.List(ctx) → []Target                  │
  или YAML)         │           ▼                                                  │
                    │ Слой 2  scraper      goroutine на цель, pgconn.PgConn         │
 PostgreSQL × 5000 ◀┼──────────┤  тик 10 с: SELECT … FROM pg_stat_activity          │
 (одно соединение   │           │  → []ActivityRow + SampleMarker                   │
  на базу)          │           ▼  chan Batch                                       │
                    │ Слой 3  sink         буфер, flush по 3 с / 20 000 строк       │
 ClickHouse ◀───────┼──────────┤  clickhouse-go native batch INSERT                 │
 (Distributed →     │           │                                                  │
  ReplicatedMT)     │ Чтение  query + api  gRPC ActivityService, TargetService      │
 UI / Grafana ◀─────┼──────────┘                                                   │
                    └──────────────────────────────────────────────────────────────┘
```

Слои связаны только интерфейсами Go и каналом. Слой 2 не знает о ClickHouse, слой 3 не
знает о PostgreSQL. Сторона чтения — отдельный процесс или тот же бинарник с флагом
`--role=api`, у него нет слоёв 1–3, только клиент ClickHouse и реестр.

### 3.1. Горизонтальное масштабирование

50 000 соединений один процесс держать может, но один процесс — одна точка отказа и один
хост. Цели распределяются по N экземплярам коллектора. Распределение делает слой 1:
каждая цель имеет `owner`, экземпляр берёт цели по аренде (`lease_until`) и продлевает её;
при падении экземпляра аренда истекает, цели разбирают живые. Для 50 000 целей — **10
экземпляров по 5 000 целей** плюс 2 резервных.

---

## 4. Структура каталога `services/dbperf`

```
services/dbperf/
├── go.mod                          module github.com/yurasolovjov/dbperf/services/dbperf
├── cmd/dbperf/main.go              флаги --role=collector|api|all, --config
├── api/proto/dbperf/v1/
│   ├── targets.proto
│   └── activity.proto
├── gen/dbperf/v1/                  сгенерированный код (buf generate)
├── internal/
│   ├── config/                     config.yaml → структуры, валидация
│   ├── registry/                   слой 1: TargetSource, Lease, распределение
│   │   ├── source_yaml.go
│   │   └── source_postgres.go
│   ├── scraper/                    слой 2: pgconn, цикл на цель, парсинг строк
│   │   ├── target_loop.go
│   │   ├── query.go                SQL для pg_stat_activity, версии PostgreSQL
│   │   └── rows.go                 ActivityRow, SampleMarker, правило CPU
│   ├── sink/clickhouse/            слой 3: буфер, батчи, ретраи, тексты запросов
│   ├── query/                      чтение: SQL к ClickHouse → модели срезов
│   ├── api/grpc/                   реализация сервисов, маппинг proto ↔ модели
│   └── telemetry/                  Prometheus-метрики, логирование, health
├── deploy/
│   ├── clickhouse/schema.sql       DDL раздела 8
│   ├── docker-compose.yaml         PostgreSQL 16 + pgbench + ClickHouse + dbperf
│   └── k8s/                        манифесты, 10 реплик коллектора
├── configs/config.example.yaml
└── test/load/                      генератор 50 000 целей (раздел 10.5)
```

Зависимости: `github.com/jackc/pgx/v5/pgconn` (без `pgxpool` и без `pgx.Conn`),
`github.com/ClickHouse/clickhouse-go/v2`, `google.golang.org/grpc`, `buf` для proto,
`log/slog`, `github.com/prometheus/client_golang`.

---

## 5. Слой 1: реестр целей

Интерфейс:

```go
type Target struct {
    ID              uint32        // target_id в ClickHouse
    Name            string        // человекочитаемое имя
    DSN             string        // postgres://… (пароль из секрета)
    Interval        time.Duration // 10s по умолчанию
    StatementTimeout time.Duration
    Enabled         bool
}

type TargetSource interface {
    List(ctx context.Context) ([]Target, error)     // все цели
    Watch(ctx context.Context) (<-chan []Target, error) // изменения, опрос раз в 30 с
}

type Lease interface {
    Acquire(ctx context.Context, instance string, want int) ([]uint32, error)
    Renew(ctx context.Context, instance string, ids []uint32) error
    Release(ctx context.Context, instance string) error
}
```

Две реализации `TargetSource`: YAML-файл для стенда и таблица в PostgreSQL метабазы для
продуктива:

```sql
CREATE TABLE dbperf_targets (
    target_id     int PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    dsn           text NOT NULL,
    interval_sec  int NOT NULL DEFAULT 10,
    enabled       bool NOT NULL DEFAULT true,
    owner         text,
    lease_until   timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
```

`Acquire` — один `UPDATE … WHERE lease_until IS NULL OR lease_until < now() … LIMIT want
FOR UPDATE SKIP LOCKED`, аренда 60 с, продление каждые 20 с. Экземпляр держит не больше
`max_targets` (5 000). Статус подключения к каждой цели (аналог `GET /scrapper` в Kintsugi)
хранится в памяти экземпляра и отдаётся по gRPC `GetTargetStatus`.

---

## 6. Слой 2: сбор через pgconn

### 6.1. Соединение

Одно соединение на цель, без пула, `pgconn.Connect` по конфигурации из
`pgconn.ParseConfig(dsn)` с параметрами:

```go
cfg.RuntimeParams["application_name"] = "dbperf"
cfg.RuntimeParams["statement_timeout"] = "5000"       // мс
cfg.RuntimeParams["idle_in_transaction_session_timeout"] = "0"
cfg.ConnectTimeout = 5 * time.Second
cfg.TLSConfig = … // по политике
```

Почему именно `pgconn`: это нижний уровень pgx без кеша prepared statements, без пула и без
маппинга типов — ровно то, что нужно для одного долгоживущего соединения с одним и тем же
запросом. Запрос выполняется через `conn.ExecParams(ctx, sql, args, nil, nil,
[]int16{0})` — текстовый формат результата, строки `[][]byte` разбираются вручную
(`strconv`, `time.Parse`). Один раз после подключения выполняется `SELECT
pg_backend_pid(), current_setting('server_version_num')` — pid для исключения себя, версия
для выбора SQL.

### 6.2. Цикл цели

```
for each target (goroutine):
    conn = connect with backoff (1 s → 60 s, jitter)
    ticker = interval, фаза = hash(target_id) % interval   -- размазать нагрузку
    loop:
        <-ticker
        ts = now().Truncate(1s)
        rows, err = exec(query)            -- таймаут = statement_timeout + 1 s
        if err: status = error; close conn; reconnect on next tick; continue
        emit SampleMarker{target_id, ts, n_active = len(rows), duration_ms}
        emit rows (ActivityRow × len(rows))
        status = connected
    on shutdown: conn.Close(ctx)
```

Фаза тика по `target_id` разводит 5 000 целей экземпляра равномерно по 10-секундному окну:
500 запросов в секунду на экземпляр вместо 5 000 в одну секунду.

### 6.3. Запрос

На основе `Activity_only.txt`, с добавлением колонок для фильтрации и `query_id`:

```sql
SELECT pid, leader_pid, backend_type, datname, usename, application_name,
       host(client_addr), state, wait_event_type, wait_event,
       extract(epoch FROM backend_start)::bigint,
       extract(epoch FROM xact_start)::bigint,
       extract(epoch FROM query_start)::bigint,
       extract(epoch FROM state_change)::bigint,
       query_id,                              -- NULL до 14-й версии
       left(query, 4096)
FROM pg_stat_activity
WHERE state IN ('active', 'fastpath function call')
  AND pid <> pg_backend_pid();
```

Для PostgreSQL 13 и ниже `query_id` заменяется на `NULL::bigint`. Стоимость для наблюдаемой
базы: один запрос в 10 с к представлению в памяти, 0,1 запроса в секунду на базу.

### 6.4. Строка данных

```go
type ActivityRow struct {
    TargetID uint32; TS int64; PID int32; LeaderPID int32
    BackendType, Datname, Usename, AppName string
    ClientAddr netip.Addr            // 0 для unix-сокета
    State, WaitEventType, WaitEvent string   // CPU-правило применено
    BackendStart, XactStart, QueryStart, StateChange int64
    QueryHash uint64                 // query_id или cityHash64(query)
    QueryText string                 // только для новых хэшей (LRU на цель)
}
```

Правило CPU из Kintsugi: если `wait_event_type` и `wait_event` оба NULL и `state = 'active'`,
оба поля получают `CPU`; иначе NULL → пустая строка.

---

## 7. Слой 3: запись в ClickHouse

Один `Sink` на экземпляр, три буфера: `pg_activity`, `pg_samples`, `pg_query_texts`.

- **Порог сброса**: 3 с или 20 000 строк, что раньше. При 5 000 целей и 8 активных сессиях
  на базу экземпляр даёт 4 000 строк/с, батч — 12 000 строк. Это внутри рекомендации
  документации ClickHouse (10–100 тысяч строк на вставку, около одной вставки в секунду на
  таблицу на кластер; при 10 экземплярах — 3–4 вставки в секунду, что допустимо; при росте
  числа экземпляров включается `async_insert = 1, wait_for_async_insert = 1`).
- **Протокол**: `clickhouse-go/v2`, native, `PrepareBatch` + `Append` по колонкам,
  `Send`. Вставка в `Distributed`-таблицу или напрямую в шард по `target_id % shards`
  (второе дешевле, выбирается на этапе нагрузочного теста).
- **Ошибки**: ретрай с экспоненциальной задержкой до 30 с, буфер не более 10 батчей
  (около 30 с данных), затем отбрасываются самые старые с метрикой `dbperf_sink_dropped_rows`.
- **Тексты запросов**: LRU на цель (10 000 хэшей); новый хэш → строка в `pg_query_texts`.
  При рестарте LRU пуст, повторная вставка текста безвредна (ReplacingMergeTree).

---

## 8. Модель данных ClickHouse

### 8.1. Принципы

- Все запросы дашборда фильтруют по одной цели и диапазону времени, поэтому ключ сортировки
  начинается с `target_id`: чтение одной цели за час — тысячи строк из миллиардов.
- Сырые строки хранятся 7 дней, минутный агрегат 30 дней; за пределами 2 часов запросы идут
  в агрегат (как у Kintsugi).
- Кластер: `ReplicatedMergeTree` на каждом шарде, `Distributed` поверх, шардирование по
  `target_id`, чтобы все данные цели лежали на одном шарде и запросы цели не собирали
  результат с нескольких узлов.
- Партиции по дню, `TTL` с `ttl_only_drop_parts = 1`: удаление по дням целыми кусками.
- Словарные строки — `LowCardinality(String)`: состояний, типов и событий ожидания — десятки,
  имён баз, ролей и приложений — тысячи. Адрес клиента — тип `IPv6` (16 байт, IPv4 как
  mapped), а не строка: до 200 тысяч различных адресов превышают порог эффективности
  `LowCardinality`.
- Текст запроса в сырой таблице не хранится: `query_hash UInt64`, текст — в отдельной таблице.

### 8.2. DDL

```sql
CREATE DATABASE IF NOT EXISTS dbperf ON CLUSTER '{cluster}';

-- 1. Активные сессии: одна строка на активный процесс в снимке
CREATE TABLE dbperf.pg_activity_local ON CLUSTER '{cluster}' (
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
    xact_start       DateTime               CODEC(Delta(4), ZSTD(1)),   -- 0, если NULL
    query_start      DateTime               CODEC(Delta(4), ZSTD(1)),
    state_change     DateTime               CODEC(Delta(4), ZSTD(1)),
    query_hash       UInt64                 CODEC(ZSTD(1))
) ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/pg_activity', '{replica}')
PARTITION BY toDate(ts)
ORDER BY (target_id, ts, pid)
TTL ts + INTERVAL 7 DAY
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

CREATE TABLE dbperf.pg_activity ON CLUSTER '{cluster}' AS dbperf.pg_activity_local
ENGINE = Distributed('{cluster}', dbperf, pg_activity_local, target_id);

-- 2. Снимки: одна строка на тик цели, даже если активных сессий нет (знаменатель СКАС)
CREATE TABLE dbperf.pg_samples_local ON CLUSTER '{cluster}' (
    target_id   UInt32   CODEC(Delta(4), ZSTD(1)),
    ts          DateTime CODEC(Delta(4), ZSTD(1)),
    n_active    UInt16   CODEC(T64, ZSTD(1)),
    duration_ms UInt16   CODEC(T64, ZSTD(1))
) ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/pg_samples', '{replica}')
PARTITION BY toDate(ts)
ORDER BY (target_id, ts)
TTL ts + INTERVAL 7 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE dbperf.pg_samples ON CLUSTER '{cluster}' AS dbperf.pg_samples_local
ENGINE = Distributed('{cluster}', dbperf, pg_samples_local, target_id);

-- 3. Тексты запросов: одна строка на (цель, хэш)
CREATE TABLE dbperf.pg_query_texts_local ON CLUSTER '{cluster}' (
    target_id  UInt32,
    query_hash UInt64,
    query      String   CODEC(ZSTD(3)),
    last_seen  DateTime
) ENGINE = ReplicatedReplacingMergeTree('/clickhouse/{cluster}/tables/{shard}/pg_query_texts', '{replica}', last_seen)
ORDER BY (target_id, query_hash)
TTL last_seen + INTERVAL 30 DAY;

CREATE TABLE dbperf.pg_query_texts ON CLUSTER '{cluster}' AS dbperf.pg_query_texts_local
ENGINE = Distributed('{cluster}', dbperf, pg_query_texts_local, target_id);

-- 4. Минутный агрегат активности: без pid и точного времени
CREATE TABLE dbperf.pg_activity_1m_local ON CLUSTER '{cluster}' (
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
) ENGINE = ReplicatedSummingMergeTree('/clickhouse/{cluster}/tables/{shard}/pg_activity_1m', '{replica}', (n_elements))
PARTITION BY toYYYYMMDD(minute)
ORDER BY (target_id, minute, backend_type, datname, usename, application_name,
          client_addr, wait_event_type, wait_event, query_hash)
TTL minute + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW dbperf.pg_activity_1m_mv ON CLUSTER '{cluster}'
TO dbperf.pg_activity_1m_local AS
SELECT target_id, toStartOfMinute(ts) AS minute,
       backend_type, datname, usename, application_name, client_addr,
       wait_event_type, wait_event, query_hash,
       count() AS n_elements
FROM dbperf.pg_activity_local
GROUP BY target_id, minute, backend_type, datname, usename, application_name,
         client_addr, wait_event_type, wait_event, query_hash;

CREATE TABLE dbperf.pg_activity_1m ON CLUSTER '{cluster}' AS dbperf.pg_activity_1m_local
ENGINE = Distributed('{cluster}', dbperf, pg_activity_1m_local, target_id);

-- 5. Минутный счётчик снимков: знаменатель для агрегата
CREATE TABLE dbperf.pg_samples_1m_local ON CLUSTER '{cluster}' (
    target_id UInt32,
    minute    DateTime,
    n_samples UInt32,
    n_active  UInt32
) ENGINE = ReplicatedSummingMergeTree('/clickhouse/{cluster}/tables/{shard}/pg_samples_1m', '{replica}', (n_samples, n_active))
PARTITION BY toYYYYMMDD(minute)
ORDER BY (target_id, minute)
TTL minute + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW dbperf.pg_samples_1m_mv ON CLUSTER '{cluster}'
TO dbperf.pg_samples_1m_local AS
SELECT target_id, toStartOfMinute(ts) AS minute, count() AS n_samples, sum(n_active) AS n_active
FROM dbperf.pg_samples_local
GROUP BY target_id, minute;

CREATE TABLE dbperf.pg_samples_1m ON CLUSTER '{cluster}' AS dbperf.pg_samples_1m_local
ENGINE = Distributed('{cluster}', dbperf, pg_samples_1m_local, target_id);
```

Запросы к SummingMergeTree всегда с `GROUP BY` и `sum(n_elements)`: слияние строк
с одинаковым ключом происходит в фоне, до него в таблице могут быть дубли ключа.

### 8.3. Зачем именно так

| Элемент | Причина |
|---|---|
| `ORDER BY (target_id, ts, pid)` | Все запросы начинаются с `target_id = ?`; первичный индекс отсекает 49 999 целей из 50 000, затем диапазон по `ts`. Порядок `(ts, target_id)` из общих примеров документации подходит, когда фильтр по времени главный, а здесь главный — цель |
| Партиция по дню | 7 партиций в сырой таблице, удаление TTL целыми кусками, слияния в пределах дня |
| `Delta` для `ts`, `target_id`, временных меток | Внутри цели `ts` монотонен, дельты — нули и десятки; `xact_start` и `query_start` повторяются от снимка к снимку |
| `T64` для `pid` | Значения в узком диапазоне, повторяются между снимками |
| `IPv6` для адреса | 16 байт фиксированной длины, при сортировке по цели почти всегда одинаков в соседних строках, сжимается до байтов |
| Текст отдельно | Текст до 4 КБ на строку сделал бы сырую таблицу в десятки раз тяжелее; хэш — 8 байт, а после ZSTD меньше |
| `SummingMergeTree` для 1m | Нужны только суммы счётчиков; `AggregatingMergeTree` понадобится, когда появятся квантили |
| `Distributed` по `target_id` | Данные одной цели на одном шарде: запрос цели выполняется на одном узле, вставка не разбрасывает батч |

### 8.4. Запросы чтения

Временной ряд по типам ожиданий, корзина 10 с, последний час (слой `query`):

```sql
WITH samples AS (
    SELECT toStartOfInterval(ts, INTERVAL {step:UInt32} SECOND) AS bucket, count() AS n
    FROM dbperf.pg_samples
    WHERE target_id = {t:UInt32} AND ts >= {from:DateTime} AND ts < {to:DateTime}
    GROUP BY bucket
)
SELECT a.bucket, a.wait_event_type AS slice, count() / any(s.n) AS aas
FROM (
    SELECT toStartOfInterval(ts, INTERVAL {step:UInt32} SECOND) AS bucket, wait_event_type
    FROM dbperf.pg_activity
    WHERE target_id = {t:UInt32} AND ts >= {from:DateTime} AND ts < {to:DateTime}
      AND application_name != 'dbperf'
) a
JOIN samples s USING (bucket)
GROUP BY a.bucket, slice
ORDER BY a.bucket, slice;
```

Для диапазона больше 2 часов тот же запрос идёт в `pg_activity_1m` и `pg_samples_1m`
с `sum(n_elements)` и `sum(n_samples)`. Выбор уровня — в слое `query` по правилу Kintsugi:
секундный уровень, если диапазон ≤ 2 ч и число точек ≤ лимита, иначе минутный.

Топ запросов за окно с вложенным срезом по типам ожиданий — запрос из раздела 3.3
описания дашборда, `query_hash` вместо `query_id`, текст через `LEFT JOIN pg_query_texts`.

### 8.5. Расширение на `pg_locks` (следующий этап)

Таблица `pg_locks_local` с тем же ключом `(target_id, ts, pid)`, колонками объекта
блокировки, `mode`, `granted`, `waitstart` и минутный счётчик `n_blocking`/`n_blocked`,
считаемый в коллекторе самосоединением снимка (логика `data_locks.yaml`). Дерево на
временную точку строится в слое `query`.

### 8.6. Что подтверждено документацией ClickHouse (через MCP)

- Пакетная вставка: минимум 1 000 строк, лучше 10 000–100 000; около одной синхронной
  вставки в секунду на таблицу; больше 10 в секунду ведёт к «too many parts»; альтернатива —
  `async_insert = 1, wait_for_async_insert = 1`.
- `SummingMergeTree` для сумм и счётчиков из materialized view, ключ сортировки равен
  `GROUP BY` представления; несколько MV на одну исходную таблицу допустимы, атомарности
  между целевыми таблицами нет.
- `LowCardinality(String)` для категориальных колонок; `Delta + ZSTD` для временных меток;
  партиции по дню и `TTL … SETTINGS ttl_only_drop_parts = 1` для удержания в днях.
- Численных ориентиров «байт на строку» и «шардов на N строк/с» документация не даёт;
  оценки раздела 10 — расчётные и проверяются нагрузочным тестом (этап 6).

---

## 9. gRPC-интерфейс (на согласование)

Пакет `dbperf.v1`, два сервиса. Семантика повторяет `POST /performance` Kintsugi
(`dbperf_api_tech_doc.txt`): временной ряд со срезами, скалярный топ с вложенным срезом,
остаток `remainder`, две единицы измерения.

```protobuf
syntax = "proto3";
package dbperf.v1;
option go_package = "github.com/yurasolovjov/dbperf/services/dbperf/gen/dbperf/v1;dbperfv1";

// ---------- targets.proto ----------

service TargetService {
  rpc ListTargets(ListTargetsRequest) returns (ListTargetsResponse);
  rpc GetTargetStatus(GetTargetStatusRequest) returns (TargetStatus);
}

message ListTargetsRequest {
  string name_filter = 1;        // подстрока имени, пусто — все
  int32  page_size   = 2;        // ≤ 1000
  string page_token  = 3;
}

message Target {
  uint32 target_id    = 1;
  string name         = 2;
  int32  interval_sec = 3;
  bool   enabled      = 4;
}

message ListTargetsResponse {
  repeated Target targets        = 1;
  string          next_page_token = 2;
}

message GetTargetStatusRequest { uint32 target_id = 1; }

message TargetStatus {
  uint32 target_id               = 1;
  string owner_instance          = 2;
  enum State { STATE_UNSPECIFIED = 0; CONNECTED = 1; DISCONNECTED = 2; DISABLED = 3; }
  State  state                   = 3;
  int64  disconnected_since      = 4;  // unix, 0 если подключён
  int64  last_sample_at          = 5;  // unix
  string last_error              = 6;
  int32  server_version_num      = 7;  // 160003
  int32  last_sample_duration_ms = 8;
}

// ---------- activity.proto ----------

service ActivityService {
  // Временной ряд активности по корзинам со срезом top-N (обзорный и детальный графики)
  rpc GetActivityTimeSeries(ActivityTimeSeriesRequest) returns (ActivityTimeSeriesResponse);
  // Скалярный топ за окно с вложенным срезом (таблица «Топ активностей БД»)
  rpc GetActivityTop(ActivityTopRequest) returns (ActivityTopResponse);
  // Итоги без среза («Общая активность»)
  rpc GetActivityTotals(ActivityTotalsRequest) returns (ActivityTotalsResponse);
  // Строки снимка на момент времени (детализация, будущая панель блокировок)
  rpc ListSessions(ListSessionsRequest) returns (ListSessionsResponse);
  // Полный текст запроса по хэшу
  rpc GetQueryText(GetQueryTextRequest) returns (GetQueryTextResponse);
}

enum Dimension {
  DIMENSION_UNSPECIFIED = 0;
  WAIT_EVENT_TYPE  = 1;   // Типы ожиданий
  WAIT_EVENT       = 2;   // Ожидания
  QUERY            = 3;   // SQL (query_hash)
  CLIENT_ADDR      = 4;   // Хосты
  USENAME          = 5;   // Пользователи
  DATNAME          = 6;   // Базы данных
  PID              = 7;   // Процессы (только секундный уровень)
  APPLICATION_NAME = 8;   // Приложения (нет в Kintsugi)
  BACKEND_TYPE     = 9;
}

enum Unit {
  UNIT_UNSPECIFIED = 0;
  AAS     = 1;   // СКАС: среднее число активных сессий
  PERCENT = 2;   // доля от общей активности, в сумме 100
}

message TimeRange {
  int64 start_unix = 1;  // включительно
  int64 end_unix   = 2;  // исключительно
}

message Filter {
  Dimension       dimension = 1;
  repeated string values    = 2;   // OR внутри фильтра, AND между фильтрами
  bool            exclude   = 3;   // NOT IN
}

message TopSlicing {
  Dimension dimension = 1;
  int32     limit     = 2;         // ≤ 100, остаток — remainder
}

message SliceValue {
  string value        = 1;   // значение разреза: 'Lock', '10.252.49.126', хэш как строка
  string short_text   = 2;   // для QUERY: первые 64 символа текста
  bool   is_remainder = 3;   // true для строки «other»
  uint32 id           = 4;   // стабильный id значения в ответе (для цвета в UI)
}

message ActivityTimeSeriesRequest {
  uint32          target_id        = 1;
  TimeRange       range            = 2;
  int32           step_seconds     = 3;   // запрошенный шаг; сервер выравнивает
  TopSlicing      slicing          = 4;   // обязателен
  repeated Filter filters          = 5;
  bool            exclude_self     = 6;   // application_name = 'dbperf' не считать (по умолчанию true)
  int32           max_points       = 7;   // ≤ 2000, по умолчанию 720
}

message Series {
  SliceValue      slice   = 1;
  repeated double values  = 2;   // по timestamps, единица AAS
  double          average = 3;
}

message ActivityTimeSeriesResponse {
  TimeRange       range          = 1;   // фактический после выравнивания
  int32           step_seconds   = 2;   // согласованный шаг (time_alignment)
  string          level          = 3;   // "raw" | "1m"
  repeated int64  timestamps     = 4;
  repeated double totals         = 5;   // общая активность по корзинам
  repeated Series series         = 6;   // top-N + remainder
}

message ActivityTopRequest {
  uint32          target_id    = 1;
  TimeRange       range        = 2;
  TopSlicing      slicing      = 3;   // внешний срез, например QUERY limit 25
  TopSlicing      sub_slicing  = 4;   // вложенный, например WAIT_EVENT_TYPE limit 10; опционален
  repeated Filter filters      = 5;
  bool            exclude_self = 6;
}

message TopEntry {
  SliceValue        slice      = 1;
  double            aas        = 2;
  double            percent    = 3;
  repeated TopEntry sub        = 4;   // вложенный срез, пусто без sub_slicing
}

message ActivityTopResponse {
  double            total_aas  = 1;
  int64             n_samples  = 2;
  repeated TopEntry entries    = 3;   // top-N + remainder
}

message ActivityTotalsRequest {
  uint32          target_id    = 1;
  TimeRange       range        = 2;
  int32           step_seconds = 3;
  repeated Filter filters      = 4;
  bool            exclude_self = 5;
}

message ActivityTotalsResponse {
  int32           step_seconds = 1;
  repeated int64  timestamps   = 2;
  repeated double values       = 3;
  double          average      = 4;
}

message ListSessionsRequest {
  uint32          target_id = 1;
  int64           at_unix   = 2;   // ближайший снимок не позже at_unix
  repeated Filter filters   = 3;
  int32           limit     = 4;   // ≤ 1000
}

message Session {
  int64  ts               = 1;
  int32  pid              = 2;
  int32  leader_pid       = 3;
  string backend_type     = 4;
  string datname          = 5;
  string usename          = 6;
  string application_name = 7;
  string client_addr      = 8;
  string state            = 9;
  string wait_event_type  = 10;
  string wait_event       = 11;
  int64  backend_start    = 12;
  int64  xact_start       = 13;
  int64  query_start      = 14;
  int64  state_change     = 15;
  uint64 query_hash       = 16;
  string query_short      = 17;  // 64 символа
}

message ListSessionsResponse {
  int64            sample_ts = 1;
  repeated Session sessions  = 2;
}

message GetQueryTextRequest  { uint32 target_id = 1; uint64 query_hash = 2; }
message GetQueryTextResponse { string query = 1; int64 last_seen = 2; bool truncated = 3; }
```

Соответствие запросу Kintsugi из `dbperf_api_tech_doc.txt`: `metrics[0]` с `slicing:
[{time, interval 2}, {top, wait_event_type, 10}]` — это `GetActivityTimeSeries{step_seconds:
2, slicing: {WAIT_EVENT_TYPE, 10}}`; `metrics[1]` с `units: ptta` и двумя `top` — это
`GetActivityTop{slicing: {QUERY, 25}, sub_slicing: {WAIT_EVENT_TYPE, 10}}`, где в ответе
есть и `aas`, и `percent`.

Ошибки: `NOT_FOUND` для неизвестной цели, `INVALID_ARGUMENT` для диапазона длиннее 30 дней
или `PID` на минутном уровне, `RESOURCE_EXHAUSTED` при превышении лимита одновременных
запросов к ClickHouse (семафор на экземпляр API, 32).

---

## 10. Оценка нагрузки: 50 000 баз

### 10.1. Допущения

| Параметр | Низкий | Средний (расчётный) | Высокий |
|---|---|---|---|
| Целей | 50 000 | 50 000 | 50 000 |
| Интервал снимка | 10 с | 10 с | 5 с |
| Активных сессий на снимок, в среднем | 3 | 8 | 20 |
| Снимков в секунду | 5 000 | 5 000 | 10 000 |
| Строк `pg_activity` в секунду | 15 000 | 40 000 | 200 000 |
| Строк `pg_activity` в сутки | 1,3 млрд | 3,5 млрд | 17 млрд |
| Строк `pg_samples` в сутки | 0,43 млрд | 0,43 млрд | 0,86 млрд |

Среднее 8 активных сессий на базу — оценка по книге и снимкам Kintsugi: у типичной OLTP-базы
десятки подключений, из них активны единицы; базы с сотнями активных сессий редки и
компенсируются простаивающими.

### 10.2. Хранение

Оценка сжатого размера строки `pg_activity` при ключе `(target_id, ts, pid)`: `target_id`
и `ts` после Delta — около 1 байта, `pid` — 2, восемь `LowCardinality` колонок — по 1,
`client_addr` — 2, четыре временные метки — по 2, `query_hash` — 4; итого **около 25–30
байт**, для расчёта взято **40 байт**. Строка `pg_samples` — около 5 байт, агрегат 1m — около
30 байт при примерно трети от числа сырых строк.

| | Низкий | Средний | Высокий |
|---|---|---|---|
| `pg_activity`, в сутки | 52 ГБ | 140 ГБ | 690 ГБ |
| `pg_activity`, 7 дней | 0,36 ТБ | 1,0 ТБ | 4,8 ТБ |
| `pg_activity_1m`, 30 дней | 0,45 ТБ | 1,2 ТБ | 4,5 ТБ |
| Итого с репликацией ×2 | 1,7 ТБ | 4,6 ТБ | 19 ТБ |

### 10.3. Вставка

При 10 экземплярах коллектора и сбросе раз в 3 с — 3–4 вставки в секунду на таблицу на
кластер, по 12 000 строк в среднем сценарии. Это в пределах документированной нормы
(≈1 вставка/с рекомендуется, до 10/с терпимо). Три materialized view на вставку добавляют
работу, сопоставимую с самой вставкой. По опыту, один узел на 16 ядрах принимает
пакетными вставками сотни тысяч узких строк в секунду, так что 40 000 строк/с — доли
мощности одного узла; размер кластера задаётся объёмом диска и чтением, а не вставкой.
В высоком сценарии 200 000 строк/с и 17 млрд строк в сутки — уже существенная нагрузка на
слияния, и его следует закладывать как 4 шарда.

### 10.4. Чтение

Запрос дашборда одной цели: час на секундном уровне — 360 снимков × 8 строк ≈ 3 000 строк,
7 дней — 480 000 строк; при ключе с `target_id` первым это десятки миллисекунд. Топ за час —
то же множество строк с группировкой по `query_hash`. Запросы «по всем целям» (топ-100
самых нагруженных баз) идут только в `pg_samples_1m`: 50 000 × 60 = 3 млн строк в час, около
секунды. Если таких запросов будет много, добавляется агрегат `pg_targets_1h`.

Одновременные пользователи: 50 000 баз подразумевают сотни операторов, но дашборд открыт
одновременно у единиц–десятков; при автообновлении раз в 10 с это десятки запросов
в секунду, каждый на один шард. Лимит — семафор в API.

### 10.5. Вердикт и размер кластера

| Сценарий | Кластер ClickHouse | Коллектор |
|---|---|---|
| Низкий | 1 шард × 2 реплики, 8 ядер, 32 ГБ, 2 ТБ NVMe | 4 экземпляра × 12 500 целей |
| Средний | **2 шарда × 2 реплики, 16 ядер, 64 ГБ, 4 ТБ NVMe каждый** | 10 экземпляров × 5 000 целей, 2 vCPU, 2 ГБ |
| Высокий | 4 шарда × 2 реплики, 32 ядра, 128 ГБ, 8 ТБ NVMe | 20 экземпляров, интервал 5 с |

ClickHouse справляется: ни одна величина не приближается к пределам одного узла по вставке,
а объём хранения в среднем сценарии — единицы терабайт. Риски не в ClickHouse, а в
коллекторе (50 000 постоянных соединений, 5 000 запросов в секунду к наблюдаемым базам) и
в числе частей при слишком частых вставках; оба закрываются архитектурой разделов 3.1 и 7.

Экземпляр коллектора: 5 000 goroutine и 5 000 сокетов, около 100 КБ буферов `pgconn` на
соединение — 0,5 ГБ, 500 запросов в секунду и 4 000 строк в секунду на разбор — доли ядра.
Сетевой трафик на экземпляр: 4 000 строк × ~300 байт = 1,2 МБ/с от PostgreSQL, в ClickHouse
меньше за счёт native-протокола и LZ4.

Все цифры проверяются этапом 6: генератор `test/load` поднимает 50 000 синтетических целей
(один PostgreSQL с pgbouncer-эмуляцией не годится, так как нужны 50 000 соединений; цели
эмулируются заглушкой `TargetSource` и фейковым скрапером, который выдаёт строки с реальным
распределением) и пишет в ClickHouse сутки данных за час.

---

## 11. Этапы реализации

| Этап | Содержание | Готово, когда |
|---|---|---|
| 0 | Каркас `services/dbperf`: go.mod, cmd, config, proto, `buf generate`, Makefile, линтер | `go build ./...` и `buf lint` проходят, бинарник стартует с `--role=all` |
| 1 | Слой 1: `TargetSource` YAML и PostgreSQL, аренда целей | Два экземпляра делят 20 целей из YAML, при остановке одного второй забирает его цели в течение 60 с |
| 2 | Слой 2: `pgconn`, цикл цели, запрос, разбор строк, CPU-правило, статусы | На стенде с pgbench строки совпадают с `SELECT … FROM pg_stat_activity` в тот же момент; обрыв PostgreSQL → переподключение с backoff |
| 3 | Схема ClickHouse из раздела 8 на docker-compose (один узел, без `ON CLUSTER`), слой 3 с батчами и ретраями | За минуту в `pg_activity` и `pg_samples` строки с правильными `ts` и `target_id`; остановка ClickHouse на 20 с не теряет данных |
| 4 | Слой `query`: запросы раздела 8.4, выбор уровня, top-N с остатком, вложенный срез | Юнит-тесты на SQL-генерацию; интеграционный тест: СКАС по ручному расчёту совпадает |
| 5 | gRPC `TargetService` и `ActivityService`, лимиты, ошибки, метрики Prometheus | `grpcurl` воспроизводит два примера из `dbperf_api_tech_doc.txt`; дашборд рисуется из ответов |
| 6 | Нагрузочный тест: 50 000 синтетических целей, 10 экземпляров, кластер 2×2 | Вставка без «too many parts» 2 часа, запрос часа цели < 200 мс при p95, размер данных в пределах оценки 10.2 ±50 % |
| 7 | Эксплуатация: k8s-манифесты, graceful shutdown с освобождением аренды, health, алерты на `dbperf_sink_dropped_rows` и число отключённых целей | Перекат коллектора без потери больше одного тика на цель |

Этапы 0–2 и 3 независимы и могут идти параллельно; 4 зависит от 3; 5 от 4; 6 от 2, 3, 5.

---

## 12. На согласование

1. **gRPC-интерфейс раздела 9**: состав методов, `Dimension` с дополнительными
   `APPLICATION_NAME` и `BACKEND_TYPE`, обе единицы в `ActivityTop`, выравнивание шага сервером.
2. **Только активные строки** в `pg_activity`; полные снимки, как в плане MVP, при 50 000 баз
   не хранятся.
3. **Интервал 10 с** по умолчанию, 5 с на цель по конфигурации.
4. **Ключ SQL — `query_id`**, для PostgreSQL ≤ 13 хэш текста; текст в отдельной таблице.
5. **Удержание**: сырые 7 дней, минутный агрегат 30 дней.
6. **Кластер**: 2 шарда × 2 реплики для среднего сценария, шардирование по `target_id`.
7. **Реестр целей в PostgreSQL метабазы** с арендой; YAML только для стенда.
8. `pg_locks` — следующим этапом, модель заложена в 8.5.
