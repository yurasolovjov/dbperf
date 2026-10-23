# dbperf-registry

Реестр объектов мониторинга на etcd и распределение целей между экземплярами dbperf.
Протокол и обоснования — в [docs/dbperf-registry-plan.md](../../docs/dbperf-registry-plan.md).

| Что | Где |
|---|---|
| Контракт gRPC | [api/proto/dbperf/registry/v1/registry.proto](api/proto/dbperf/registry/v1/registry.proto): `TargetRegistry` и `LeaseService` |
| Хранилище | `internal/store`: ключи `/dbperf/targets`, `names`, `seq`, `instances`, `owners`; транзакции etcd для уникальности имён и захвата целей |
| Распределение | `internal/lease`: справедливая доля `min(capacity, ceil(targets / instances))`, возврат лишних целей по 10 % за вызов |
| Серверы | `internal/api/grpc`, метрики `registry_target_changes_total`, `registry_lease_calls_total`, `registry_instances` |
| CLI | `cmd/registryctl`: `import`, `list`, `create`, `enable`, `disable`, `delete`, `assignments` |

## Запуск

```bash
registry -etcd localhost:2379 -prefix /dbperf/ -grpc :9100 -http :9101 -lease-ttl 30s -renew-interval 10s
registryctl -addr localhost:9100 import -file deploy/dbperf/targets.yaml
registryctl -addr localhost:9100 assignments
```

Переменные `ETCD_ENDPOINTS`, `ETCD_PREFIX`, `GRPC_ADDR`, `HTTP_ADDR`, `REGISTRY_ADDR`
заменяют флаги. На стенде (`make up` в корне) реестр поднимается вместе с etcd, а
`registry-init` импортирует `deploy/dbperf/targets.yaml`.

## Аренда в двух словах

Экземпляр dbperf регистрируется (`RegisterInstance`) и получает сессию с TTL 30 с, берёт
цели (`AcquireTargets`) не больше справедливой доли, раз в 10 с продлевает аренду по списку
целей (`RenewLeases`) и отдаёт то, что реестр попросил вернуть (`release_requested`). На
уровне etcd у экземпляра одна аренда, к ней привязаны ключи всех его целей: пропал экземпляр —
через TTL etcd освобождает их разом. Экземпляр, который не смог продлить аренду до дедлайна,
останавливает сбор сам, чтобы не писать снимки параллельно с новым владельцем.

## Тесты

```bash
make test        # юнит-тесты правил распределения
make test-etcd   # интеграционные тесты на одноразовом etcd в Docker: гонка имён, аренда, failover, выравнивание
```
