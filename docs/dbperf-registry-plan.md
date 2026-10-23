# dbperf-registry: реестр объектов мониторинга на etcd и аренда целей

Отдельный микросервис, который хранит объекты мониторинга (target instance database) в etcd,
отдаёт их по gRPC и распределяет между экземплярами dbperf через аренду. Заменяет файл
[deploy/dbperf/targets.yaml](../deploy/dbperf/targets.yaml) и таблицу `dbperf_targets` из
раздела 5 [плана сервиса](dbperf-service-plan.md). Документ — на согласование протокола
(разделы 3–5) до начала реализации.

---

## 1. Роли и границы

| Компонент | Что делает | Чего не делает |
|---|---|---|
| **dbperf-registry** (новый) | Единственный клиент etcd. CRUD объектов мониторинга, выдача и продление аренды, учёт живых экземпляров dbperf, справедливое распределение | Не ходит в PostgreSQL и ClickHouse, не собирает метрики |
| **dbperf** (изменяется слой 1) | Регистрируется в реестре, берёт цели, продлевает аренду по каждой, отдаёт лишние, следит за изменениями целей | Не знает об etcd |
| **etcd** | Хранилище с TTL-арендами и транзакциями `compare-and-swap` | — |
| **registryctl** (CLI в составе реестра) | Импорт `targets.yaml`, список, создание, включение/выключение целей | — |

Принцип: аренда принадлежит экземпляру dbperf, а не объекту. Если экземпляр перестал
продлевать — все его цели освобождаются разом, и их разбирают живые экземпляры.

---

## 2. Модель хранения в etcd

Префикс `/dbperf/`, все значения — JSON.

| Ключ | Значение | Аренда etcd |
|---|---|---|
| `targets/{id:010d}` | объект `Target` (раздел 3.2) | нет, постоянный |
| `names/{name}` | `id` | нет; обеспечивает уникальность имени через транзакцию |
| `seq/target_id` | последний выданный `id` | нет; инкремент транзакцией |
| `instances/{instance}` | `{capacity, version, registered_at}` | **да**, аренда экземпляра с TTL |
| `owners/{id:010d}` | `{instance, acquired_at}` | **да, та же аренда экземпляра** |

Аренда etcd одна на экземпляр dbperf (аналог `concurrency.Session`): к ней привязаны ключ
экземпляра и все ключи `owners/*` этого экземпляра. Продление аренды на уровне API идёт
по списку целей (раздел 4.3), а на уровне etcd — одним `KeepAlive` этой аренды: так 5 000
целей экземпляра не порождают 5 000 keepalive-потоков. Если экземпляр умер, etcd по истечении
TTL удаляет все его `owners/*` одной операцией, и цели становятся свободными без участия
реестра.

Захват цели — транзакция: `If(create_revision(owners/{id}) == 0) Then Put(owners/{id},
instance, lease)`. Проигравший конкурент получает отказ и берёт следующую свободную цель.
Так два реестра (реплики) или два dbperf не могут владеть одной целью.

Строка подключения хранится в `Target.dsn` в открытом виде. Это решение на согласование
(раздел 7, п. 4): альтернатива — ссылка на секрет.

---

## 3. Протокол: `dbperf.registry.v1.TargetRegistry`

Файл `services/registry/api/proto/dbperf/registry/v1/registry.proto`. Два сервиса в одном
пакете: `TargetRegistry` для объектов и `LeaseService` для распределения.

### 3.1. Сервис объектов мониторинга

```protobuf
syntax = "proto3";
package dbperf.registry.v1;
option go_package = "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1;registryv1";

import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";

service TargetRegistry {
  rpc CreateTarget(CreateTargetRequest) returns (Target);
  rpc GetTarget(GetTargetRequest) returns (Target);
  rpc ListTargets(ListTargetsRequest) returns (ListTargetsResponse);
  rpc UpdateTarget(UpdateTargetRequest) returns (Target);
  rpc DeleteTarget(DeleteTargetRequest) returns (google.protobuf.Empty);
  // Поток изменений начиная с ревизии; dbperf держит его вместо периодического ListTargets.
  rpc WatchTargets(WatchTargetsRequest) returns (stream TargetEvent);
}
```

### 3.2. Объект мониторинга

```protobuf
message Target {
  uint32 target_id            = 1;  // выдаёт реестр, неизменяем
  string name                 = 2;  // уникально, 1..128 символов, [A-Za-z0-9._-]
  string dsn                  = 3;  // postgres://user:pass@host:5432/db?sslmode=…
  int32  interval_sec         = 4;  // интервал снимка, 1..3600, по умолчанию 10
  int32  statement_timeout_ms = 5;  // по умолчанию 5000
  bool   enabled              = 6;  // выключенная цель не выдаётся в аренду
  map<string, string> labels  = 7;  // произвольные метки: env, cluster, team
  int64  created_at           = 8;  // unix
  int64  updated_at           = 9;  // unix
  int64  revision             = 10; // ревизия etcd последнего изменения; для optimistic update
}

message CreateTargetRequest {
  string name                 = 1;
  string dsn                  = 2;
  int32  interval_sec         = 3;
  int32  statement_timeout_ms = 4;
  optional bool enabled       = 5;  // отсутствует → true
  map<string, string> labels  = 6;
}

message GetTargetRequest { uint32 target_id = 1; string name = 2; } // одно из двух

message ListTargetsRequest {
  string name_filter                 = 1; // подстрока
  map<string, string> label_selector = 2; // все пары должны совпасть
  optional bool enabled              = 3;
  int32  page_size                   = 4; // ≤ 1000
  string page_token                  = 5;
}

message ListTargetsResponse {
  repeated Target targets = 1;
  string next_page_token  = 2;
  int64  revision         = 3; // ревизия etcd на момент выдачи: с неё начинать WatchTargets
}

message UpdateTargetRequest {
  Target target                           = 1; // target_id обязателен
  google.protobuf.FieldMask update_mask   = 2; // name, dsn, interval_sec, statement_timeout_ms, enabled, labels
  int64  expected_revision                = 3; // 0 — без проверки
}

message DeleteTargetRequest { uint32 target_id = 1; }

message WatchTargetsRequest { int64 since_revision = 1; } // 0 — с текущего момента

message TargetEvent {
  enum Type { TYPE_UNSPECIFIED = 0; PUT = 1; DELETE = 2; }
  Type   type      = 1;
  uint32 target_id = 2;
  Target target    = 3; // пусто для DELETE
  int64  revision  = 4;
}
```

Ошибки: `ALREADY_EXISTS` — имя занято; `NOT_FOUND`; `INVALID_ARGUMENT` — поля вне диапазона,
DSN не разбирается; `FAILED_PRECONDITION` — `expected_revision` не совпала; `ABORTED` —
транзакция etcd проиграла гонку, клиент повторяет.

Удаление цели не ждёт конца аренды: ключ `owners/{id}` удаляется вместе с целью, dbperf узнаёт
об этом из `WatchTargets` (событие `DELETE`) и из ответа `RenewLeases` (цель в списке `lost`)
и останавливает цикл.

### 3.3. Сервис аренды

```protobuf
service LeaseService {
  // Регистрация экземпляра dbperf: создаёт сессию с TTL. Повторный вызов с тем же instance
  // заменяет сессию (прежние цели освобождаются).
  rpc RegisterInstance(RegisterInstanceRequest) returns (RegisterInstanceResponse);
  // Взять свободные цели до want штук, но не больше справедливой доли.
  rpc AcquireTargets(AcquireTargetsRequest) returns (AcquireTargetsResponse);
  // Продлить аренду по списку целей. Вызывается каждые renew_interval_sec.
  rpc RenewLeases(RenewLeasesRequest) returns (RenewLeasesResponse);
  // Вернуть цели (все или часть) до истечения аренды — при остановке или по release_requested.
  rpc ReleaseTargets(ReleaseTargetsRequest) returns (ReleaseTargetsResponse);
  // Кто чем владеет: для эксплуатации и для GetTargetStatus в dbperf API.
  rpc ListAssignments(ListAssignmentsRequest) returns (ListAssignmentsResponse);
}

message RegisterInstanceRequest {
  string instance = 1; // уникальное имя экземпляра, например hostname+pid или pod name
  int32  capacity = 2; // сколько целей экземпляр готов вести (max_targets)
  string version  = 3; // версия dbperf, информационно
}

message RegisterInstanceResponse {
  string session_id         = 1; // идентификатор сессии; передаётся во все вызовы аренды
  int32  lease_ttl_sec      = 2; // TTL аренды etcd, например 30
  int32  renew_interval_sec = 3; // рекомендуемый период RenewLeases, например 10
  int32  fair_share         = 4; // текущая справедливая доля для этого экземпляра
}

message AcquireTargetsRequest {
  string instance   = 1;
  string session_id = 2;
  int32  want       = 3; // сколько ещё взять; реестр ограничит fair_share − уже_владеет
}

message Assignment {
  uint32 target_id  = 1;
  Target target     = 2; // полный объект, чтобы dbperf не делал второй запрос
  int64  expires_at = 3; // unix, когда аренда истечёт без продления
}

message AcquireTargetsResponse {
  repeated Assignment acquired = 1; // только что взятые
  int32  owned_total           = 2; // сколько всего целей у экземпляра после вызова
  int32  fair_share            = 3;
  int64  lease_deadline_unix   = 4; // до этого момента нужно успеть RenewLeases
}

message RenewLeasesRequest {
  string instance            = 1;
  string session_id          = 2;
  repeated uint32 target_ids = 3; // всё, что экземпляр ведёт прямо сейчас
}

message RenewLeasesResponse {
  repeated uint32 renewed           = 1; // продлено
  repeated uint32 lost              = 2; // уже не принадлежат экземпляру (удалены, выключены, перехвачены после истечения) — остановить циклы
  repeated uint32 release_requested = 3; // экземпляр выше справедливой доли: эти цели отдать через ReleaseTargets
  repeated uint32 not_owned_sent    = 4; // были в запросе, но реестр о них не знает — ошибка клиента, остановить
  int32  fair_share                 = 5;
  int64  lease_deadline_unix        = 6;
}

message ReleaseTargetsRequest {
  string instance            = 1;
  string session_id          = 2;
  repeated uint32 target_ids = 3;
  bool   all                 = 4; // graceful shutdown
}

message ReleaseTargetsResponse { int32 released = 1; }

message ListAssignmentsRequest { string instance = 1; } // пусто — все

message InstanceAssignments {
  string instance            = 1;
  int32  capacity            = 2;
  string version             = 3;
  int64  registered_at       = 4;
  int64  expires_at          = 5;
  repeated uint32 target_ids = 6;
}

message ListAssignmentsResponse {
  repeated InstanceAssignments instances = 1;
  repeated uint32 unassigned             = 2; // включённые цели без владельца
}
```

Ошибки аренды: `ABORTED` с текстом `session expired` — сессия истекла, dbperf обязан
остановить все циклы и начать с `RegisterInstance`; `PERMISSION_DENIED` — `session_id` не
принадлежит `instance`; `UNAVAILABLE` — etcd недоступен, клиент повторяет с backoff.

---

## 4. Семантика аренды

### 4.1. Жизненный цикл экземпляра

```
RegisterInstance ──► session, ttl=30, renew=10, fair_share
      │
      ▼
AcquireTargets(want = fair_share) ──► цели + полные объекты ──► запуск циклов скрапера
      │
      ▼  каждые 10 с
RenewLeases(все ведомые id) ──► renewed / lost / release_requested / fair_share
      │                               │               │
      │                               │               └─► ReleaseTargets(ids) → остановить циклы
      │                               └─► остановить циклы lost
      ▼  если owned_total < fair_share
AcquireTargets(want = fair_share − owned) ──► новые цели
      │
      ▼  SIGTERM
ReleaseTargets(all = true)
```

### 4.2. Правило потери аренды на стороне dbperf

Аренда действительна до `lease_deadline_unix`. Если `RenewLeases` не удалось выполнить до
этого момента (реестр или etcd недоступны), dbperf **останавливает все циклы** и не пишет
снимки, пока не зарегистрируется заново. Иначе после истечения TTL другой экземпляр возьмёт
те же цели, и в ClickHouse появятся два снимка на один тик. Правило совпадает с семантикой
etcd: нет продления — нет владения.

### 4.3. Справедливая доля

`fair_share = min(capacity, ceil(enabled_targets / live_instances))`, где `live_instances` —
экземпляры с живой сессией. Пересчитывается при каждом вызове аренды. Экземпляр с
`owned > fair_share` получает в `release_requested` разницу: цели с наибольшими `target_id`,
не больше 10 % владения за один вызов, чтобы перераспределение шло плавно и без хлопанья.
Отданные цели в следующие `renew_interval_sec` разбирают экземпляры, у которых
`owned < fair_share`. Гистерезис: `release_requested` не выдаётся, если превышение меньше 5 % владения; для
маленьких наборов (до 20 целей) отдаётся даже одна лишняя цель, иначе три экземпляра на 30 целей
застревали бы на 11/11/8.

Пример: 50 000 целей, 10 экземпляров по 5 000. Один умирает: через 30 с его 5 000 целей
свободны, `fair_share` для оставшихся — 5 556, каждый добирает по 556 за один-два цикла.
Экземпляр вернулся: `fair_share` снова 5 000, каждый отдаёт по 10 % в вызов, новый набирает.
Полное выравнивание — около минуты.

### 4.4. Что видит dbperf API

`GetTargetStatus` в dbperf сейчас знает состояние только своих целей. С реестром он отвечает и
за чужие: `ListAssignments` даёт владельца, а живой статус по-прежнему только у владельца.
В `TargetStatus` поле `owner_instance` заполняется из реестра.

---

## 5. Изменения в dbperf

Слой 1 получает третью реализацию `TargetSource` и `Lease` — `internal/registry/grpc.go`:

| Интерфейс dbperf | Вызов реестра |
|---|---|
| `TargetSource.List` | `ListTargets` постранично при старте, далее `WatchTargets` с ревизии ответа; кэш целей в памяти |
| `Lease.Acquire(instance, want)` | `AcquireTargets`; возвращает id, объекты кладутся в кэш |
| `Lease.Renew(instance, ids)` | `RenewLeases`; `lost` и `release_requested` передаются менеджеру |
| `Lease.Release(instance)` | `ReleaseTargets(all = true)` |

Менеджер (`manager.go`) дополняется: `Renew` возвращает списки `lost` и `release`, по которым
цели снимаются немедленно, а не на следующем `refresh`; при `ABORTED session expired` —
остановка всех циклов и повторная регистрация; при недоступности реестра дольше TTL —
остановка (4.2). Конфигурация:

```yaml
registry:
  type: grpc
  addr: registry:9100
  max_targets: 5000
```

Поля `lease_ttl` и `lease_renew` для типа `grpc` берутся из ответа `RegisterInstance`.
Реализации `yaml` и `postgres` остаются для стенда и совместимости.

Генерированный клиент реестра используется из модуля `services/registry` через `go.work` в
корне репозитория (монорепозиторий, без публикации модуля).

---

## 6. Сервис, стенд, этапы

```
services/registry/
├── cmd/registry/main.go           gRPC :9100, HTTP :9101 (/metrics, /healthz)
├── cmd/registryctl/main.go        import --file targets.yaml | list | create | enable | disable | assignments
├── api/proto/dbperf/registry/v1/registry.proto
├── internal/store/                etcd: ключи раздела 2, транзакции, сессии
├── internal/lease/                справедливая доля, release_requested
├── internal/api/grpc/
└── Dockerfile, Dockerfile.prebuilt
```

Зависимости: `go.etcd.io/etcd/client/v3`, те же `grpc` и `protobuf`, что у dbperf.
Стенд: в `deploy/docker-compose.yaml` добавляются `etcd` (один узел, `quay.io/coreos/etcd:v3.5`),
`registry` и одноразовый `registry-init`, который выполняет `registryctl import` из
`deploy/dbperf/targets.yaml`; `dbperf` переключается на `registry.type: grpc`. Для проверки
распределения в compose поднимаются два экземпляра `dbperf` с `max_targets: 1`: каждый
должен получить по одной цели, остановка одного передаёт его цель другому за TTL.

| Этап | Содержание | Готово, когда |
|---|---|---|
| R0 | Протокол согласован, `go.work`, каркас `services/registry`, `buf generate` | модуль собирается |
| R1 | `internal/store`: CRUD в etcd с транзакциями, уникальность имён, счётчик id, watch | интеграционный тест на etcd в docker: два параллельных `Create` с одним именем — один `ALREADY_EXISTS` |
| R2 | `LeaseService`: сессии, захват транзакцией, продление, справедливая доля | тест: 3 экземпляра × 10 целей делят поровну; остановка одного — его цели у других через TTL; возврат — доли выравниваются без дублей владения |
| R3 | `registryctl`, compose с etcd и реестром, импорт `targets.yaml` | `make up` поднимает стенд, цели в etcd |
| R4 | dbperf: `grpc`-реестр, обработка `lost`/`release_requested`/`session expired`, правило 4.2 | два dbperf на стенде делят цели; `GetTargetStatus` показывает владельца; остановка реестра на 40 с останавливает сбор и возобновляет после регистрации |
| R5 | Метрики реестра (`registry_targets`, `registry_instances`, `registry_lease_renewals_total`), документация | README реестра, раздел в плане сервиса |

---

## 7. На согласование

1. **Состав методов** разделов 3.1 и 3.3: два сервиса, `WatchTargets` потоком, `ListAssignments`.
2. **Модель аренды**: одна etcd-аренда на экземпляр, продление по списку целей через `RenewLeases`,
   TTL 30 с и период 10 с, правило остановки при невозможности продлить (4.2).
3. **Справедливая доля** с плавным возвратом по 10 % за вызов (4.3).
4. **DSN в etcd в открытом виде** на первом этапе; позже — ссылка на секрет в поле `dsn_secret_ref`.
5. **`target_id` выдаёт реестр** (счётчик в etcd), имя уникально; импорт из `targets.yaml`
   сохраняет указанные в файле `id`, если они свободны.
6. **Порты**: реестр gRPC `9100`, HTTP `9101`; etcd `2379` только внутри compose.

---

## 8. Состояние реализации (23.10.2026)

Этапы R0–R5 выполнены: `services/registry` (хранилище, аренда, оба gRPC-сервиса,
`registryctl`, метрики), клиент в dbperf (`internal/registry/grpc.go`), стенд с etcd и двумя
коллекторами. Проверено на стенде:

| Сценарий | Результат |
|---|---|
| Импорт `targets.yaml` | два объекта созданы с id из файла |
| Два экземпляра с ёмкостью 2 на две цели | по одной цели у каждого, `GetTargetStatus` чужой цели показывает владельца |
| Остановка `dbperf-2` | через 34 с обе цели у `dbperf-1` (TTL 30 с плюс тик продления) |
| Возврат `dbperf-2` | через 16 с снова по одной: `dbperf-1` отдал лишнюю по `release_requested` |
| Реестр недоступен 45 с | продления падают с `UNAVAILABLE`, после дедлайна сбор остановлен, после возврата реестра сессии перерегистрированы и цели разобраны заново |

Интеграционные тесты (`make test-etcd`): гонка восьми `Create` с одним именем даёт один успех;
три экземпляра на 30 целей делят их 10/10/10, после падения одного — 15/15, после возврата —
снова 10/10/10 без двойного владения; выключенная цель приходит в `lost`.

Отличия от первой редакции документа: гистерезис возврата — 5 % без нижнего порога в две
цели (раздел 4.3); `WatchTargets` реализован на сервере, dbperf пока обновляет список целей
периодическим `ListTargets` раз в `refresh`.
