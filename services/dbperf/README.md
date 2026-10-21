# dbperf

Коллектор `pg_stat_activity` → ClickHouse и gRPC API для дашборда «Активность сессии».
План и обоснования — в [docs/dbperf-service-plan.md](../../docs/dbperf-service-plan.md).

## Слои

| Слой | Пакет | Что делает |
|---|---|---|
| 1 | `internal/registry` | Список целей из YAML или таблицы `dbperf_targets` в PostgreSQL, аренда целей между экземплярами |
| 2 | `internal/scraper` | Одно соединение `pgconn` на цель, снимок активных сессий раз в интервал, правило CPU, хэш запроса |
| 3 | `internal/sink/clickhouse` | Буфер, вставка батчами (5 с / 40 000 строк), ретраи, очередь на 10 батчей |
| чтение | `internal/query`, `internal/api/grpc` | SQL к ClickHouse с выбором уровня (сырой / минутный), gRPC `TargetService` и `ActivityService` |

Схема ClickHouse: [deploy/clickhouse/schema.sql](deploy/clickhouse/schema.sql).
Контракт gRPC: [api/proto/dbperf/v1](api/proto/dbperf/v1).

## Запуск стенда

```bash
make up        # PostgreSQL 16 + pgbench, ClickHouse 25.8, dbperf (collector + api); бинарник собирается на хосте
```

Порты: gRPC `9090`, метрики и `/healthz` `9091`, ClickHouse `9000`/`8123`, PostgreSQL `5432`.

Проверка данных:

```bash
docker compose -f deploy/docker-compose.yaml exec clickhouse clickhouse-client \
  --query "SELECT target_id, count(), max(ts) FROM dbperf.pg_samples GROUP BY target_id"
```

Примеры запросов (нужен `grpcurl`, рефлексия включена):

```bash
NOW=$(date +%s)
grpcurl -plaintext localhost:9090 dbperf.v1.TargetService/ListTargets

grpcurl -plaintext -d "{\"target_id\":2,\"range\":{\"start_unix\":$((NOW-900)),\"end_unix\":$NOW},
  \"step_seconds\":10,\"slicing\":{\"dimension\":\"WAIT_EVENT_TYPE\",\"limit\":10},\"exclude_self\":true}" \
  localhost:9090 dbperf.v1.ActivityService/GetActivityTimeSeries

grpcurl -plaintext -d "{\"target_id\":2,\"range\":{\"start_unix\":$((NOW-900)),\"end_unix\":$NOW},
  \"slicing\":{\"dimension\":\"QUERY\",\"limit\":25},\"sub_slicing\":{\"dimension\":\"WAIT_EVENT_TYPE\",\"limit\":10}}" \
  localhost:9090 dbperf.v1.ActivityService/GetActivityTop
```

## Локальная разработка

```bash
make proto     # buf lint + buf generate (нужны buf, protoc-gen-go, protoc-gen-go-grpc)
make test
make run       # configs/config.example.yaml, цели из configs/targets.yaml
```

Роли: `--role collector` (слои 1–3), `--role api` (только чтение), `--role all`.
Несколько коллекторов делят цели через `registry.type: postgres` и аренду в `dbperf_targets`.

## Нагрузочный тест

```bash
make load      # 50 000 синтетических целей, 10 с, 8 активных сессий, час данных
```

Генератор пишет напрямую в sink, минуя PostgreSQL, и отдаёт метрики на `:9092/metrics`.
