# dbperf

Мониторинг активности PostgreSQL по модели выборок: коллектор на Go снимает
`pg_stat_activity` с наблюдаемых баз и пишет снимки в ClickHouse, реестр на etcd раздаёт
базы коллекторам в аренду, фронтенд на React и Plotly показывает дашборд «Активность сессии»
и управляет объектами мониторинга.

| Компонент | Каталог | Порты |
|---|---|---|
| Коллектор и API чтения (gRPC + JSON) | [services/dbperf](services/dbperf/README.md) | 9090 gRPC, 9091 HTTP (JSON-шлюз, `/metrics`, `/healthz`) |
| Реестр объектов и аренда на etcd | [services/registry](services/registry/README.md) | 9100 gRPC, 9101 HTTP |
| Фронтенд за Nginx | [services/dbperf-ui](services/dbperf-ui/README.md) | 8081 |
| Стенд docker-compose | [deploy](deploy/docker-compose.yaml) | PostgreSQL 5432, ClickHouse 9000 и 8123 |

## Quick Start

Нужны Go 1.27, Node 22 с npm и Docker с Compose. Бинарники и бандл собираются на хосте,
образам сеть не нужна.

1. Соберите и поднимите стенд: PostgreSQL 16 с нагрузкой pgbench, ClickHouse, etcd,
   реестр, два коллектора и фронтенд.

   ```bash
   make up
   ```

   Первый запуск тянет образы `postgres:16`, `clickhouse/clickhouse-server:25.8`,
   `quay.io/coreos/etcd:v3.5.21` и `nginx:1.27-alpine`.

2. Откройте дашборд: <http://localhost:8081>. В боковой панели — два объекта из
   [deploy/dbperf/targets.yaml](deploy/dbperf/targets.yaml), импортированные в реестр при
   старте. Через минуту на графиках появится активность pgbench: выделите окно на обзорном
   графике, переключайте разрезы, смотрите профиль окна и таблицу топа.

3. Добавьте свою базу: страница «Объекты мониторинга» (`#/targets`), кнопка «Создать» или
   «Импорт YAML». Коллектор подхватит новый объект в течение 15 секунд, дашборд появится в
   боковой панели. База должна быть доступна из контейнера `dbperf` по адресу из DSN, роли
   достаточно `GRANT pg_monitor`.

4. Проверьте, кто что ведёт:

   ```bash
   docker compose -f deploy/docker-compose.yaml exec registry /registryctl -addr localhost:9100 assignments
   ```

5. Остановите стенд с удалением данных:

   ```bash
   make down
   ```

### Полезные команды

```bash
make logs                                   # логи коллекторов, реестра и фронтенда
make test                                   # тесты Go и проверка типов фронтенда
make -C services/registry test-etcd         # интеграционные тесты аренды на одноразовом etcd

# те же данные, что на дашборде, через JSON-шлюз
NOW=$(date +%s); curl -s -X POST localhost:8081/api/v1/activity/top -H 'Content-Type: application/json' \
  -d "{\"targetId\":2,\"range\":{\"startUnix\":$((NOW-900)),\"endUnix\":$NOW},\"slicing\":{\"dimension\":\"QUERY\",\"limit\":5}}"

# или по gRPC (нужен grpcurl, рефлексия включена)
grpcurl -plaintext localhost:9090 dbperf.v1.TargetService/ListTargets

# сырые снимки в ClickHouse
docker compose -f deploy/docker-compose.yaml exec clickhouse clickhouse-client \
  --query "SELECT wait_event_type, count() FROM dbperf.pg_activity WHERE target_id = 2 GROUP BY 1 ORDER BY 2 DESC"
```

### Если что-то не поднялось

- Порт занят: стенд публикует 5432, 8081, 8123, 9000, 9090, 9091, 9100, 9101; освободите
  порт или поменяйте его в `deploy/docker-compose.yaml`.
- Фронтенд открылся, но графики пустые: подождите один-два интервала снимка, затем
  посмотрите `make logs` и `/healthz` на `localhost:9091`.
- Коллектор не берёт объект: в `registryctl assignments` объект в `unassigned` означает,
  что у живых коллекторов исчерпана ёмкость (`max_targets` в `deploy/dbperf/config*.yaml`).

## Документация

- [docs/dbperf-service-plan.md](docs/dbperf-service-plan.md) — архитектура коллектора, модель данных ClickHouse, gRPC-интерфейс, оценка на 50 000 баз, результаты стенда.
- [docs/dbperf-registry-plan.md](docs/dbperf-registry-plan.md) — протокол реестра, модель etcd, аренда и справедливая доля.
- [docs/dbperf-dashboard-session-activity.md](docs/dbperf-dashboard-session-activity.md) — как устроен дашборд и какие данные ему нужны.
- [docs/dbperf-mvp-simple.md](docs/dbperf-mvp-simple.md) — первый план MVP и каталог метрик с типами.
- [docs/postgres-statistics-views.md](docs/postgres-statistics-views.md), [docs/postgres-monitoring-queries.md](docs/postgres-monitoring-queries.md) — справочники по книге «Мониторинг PostgreSQL».
