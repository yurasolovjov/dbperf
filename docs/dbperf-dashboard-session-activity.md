# dbperf: дашборд «Активность сессии» и панель «Блокировки»

Описание дашборда активных сессий по образцу Kintsugi (DBCM) «Активность сессии»
(снимки `photo_5384309816068611423_y.jpg`, `…424_y.jpg`, `…425_y.jpg` в этом каталоге)
и парной к нему панели «Блокировки». Документ отвечает на три вопроса: как дашборд должен
выглядеть, какие данные для него нужны из `pg_stat_activity` и `pg_locks`, и как эти данные
получаются из сырых таблиц ClickHouse, описанных в [dbperf-mvp-simple.md](dbperf-mvp-simple.md)
(раздел 4). Метрики и их типы — в разделе 8 того же документа.

Определения метрик сверены с SQL-логикой сервиса dbperf в Kintsugi (хранилище SQLite):
[basic.yaml](basic.yaml) — схема, словари, выбор уровня агрегации и запросы срезов для API;
[data_activity.yaml](data_activity.yaml) — слияние снимков активности;
[data_locks.yaml](data_locks.yaml) — слияние снимков с блокировками, метрики `n_blocking`
и `n_blocked`, дерево блокировок; [Activity_only.txt](Activity_only.txt) и
[Activity_with_locks.txt](Activity_with_locks.txt) — запросы сбора к PostgreSQL. Там, где dbperf
сознательно отличается от Kintsugi (`query_id` вместо текста запроса, `waitstart`, фильтр
собственных сессий по `application_name`), это отмечено словами «отличие dbperf».

---

## 1. Назначение

Дашборд показывает, **на что уходит время сервера базы данных прямо сейчас и за последний
час**: сколько сеансов выполняют запросы, чего они ждут, какие запросы, с каких хостов,
под какими пользователями и в каких базах. Единица измерения — среднее количество активных
сессий (СКАС, в API `aas`). Это модель активных сессий (Oracle ASH, AWS Performance
Insights): снимок `pg_stat_activity` каждые несколько секунд, из снимка берутся только
активные процессы, их число усредняется по корзине времени и раскладывается по разрезам.

Панель «Блокировки» отвечает на вопрос, **кто кого ждёт и как долго**: ожидающие процессы,
удерживающие процессы, возраст транзакции и запроса, текст запросов, готовая команда завершения.

---

## 2. Как выглядит дашборд «Активность сессии»

### 2.1. Схема экрана

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ <объект> / Активность сессии                                                         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Период: [1 мин][5 мин][15 мин][30 мин][1 час][Указать]   Разрез: [Типы ожиданий ▾]   │
│                                                        Автообновление: [10 секунд ▾] ⟳│
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ОБЗОРНЫЙ ГРАФИК (stacked area, корзина 60 с, весь период)              │ Легенда      │
│ Сессии                                                                 │ ■ Client     │
│ 100 ┤        ▄▄                                                        │ ■ LWLock     │
│  50 ┤   ▄▄▄▄████▄▄▄   ▄▄   ▄     ▄▄▄    ▄▄▄  ▄▄▄  ▄▄ ░░░░              │ ■ Lock       │
│   0 ┼───────────────────────────────────────────────░░░░──────         │ ■ IO         │
│     11:39   11:41   11:43   11:45   11:47   11:49   11:51   11:53      │ ■ CPU        │
│                                           скользящее окно ──┘          │ ■ other      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ⓘ Фильтры: не выбраны                                 ☐ Общая активность   [⤢]       │
│ ДЕТАЛЬНЫЙ ГРАФИК (stacked area, корзина = тик, только скользящее окно)  │ Легенда      │
│ Сессии                                                                 │              │
│  20 ┤  ▄▄  ▄▄▄  ▄▄    ▄▄  ▄▄▄  ▄▄   ▄▄  ▄▄▄                            │              │
│  10 ┤ ████████████████████████████████████████                          │              │
│   0 ┼──────────────────────────────────────────                        │              │
│     51:45  51:55  52:05  52:15  52:25  52:35  52:45                     │              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [Типы ожиданий][Ожидания][SQL][Хосты][Пользователи][Базы данных][Процессы]  [Фильтры] │
│ ТОП АКТИВНОСТЕЙ БД (за скользящее окно)                                              │
│  Активность (СКАС | %) ⇅   │ Значение разреза (зависит от вкладки)                   │
│  ▸ ████████░░  93.405      │ WITH locks AS (SELECT pid, locktype, mode, …            │
│  ▸ █░░░░░░░░░   1.070      │ WITH queries AS MATERIALIZED (SELECT datname, …         │
│  ▸ █░░░░░░░░░   0.891      │ SELECT client_addr, pg_current_wal_lsn() - replay_lsn … │
│  ▸ …                                                                                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2. Элементы и их поведение

| Элемент | Поведение |
|---|---|
| **Период** | Готовые значения 1, 5, 15, 30 минут, 1 час и произвольный диапазон «Указать» с точностью до минуты. Ограничивает обзорный график. По умолчанию 5 минут |
| **Разрез** | Один из семи: Типы ожиданий (по умолчанию), Ожидания, SQL, Хосты, Пользователи, Базы данных, Процессы. Меняет группировку обоих графиков и активную вкладку таблицы |
| **Автообновление** | Интервал перезапроса данных, по умолчанию 10 секунд (равен тику коллектора). Кнопка ручной перезагрузки рядом |
| **Обзорный график** | Stacked area за весь период, корзина 60 секунд, ось Y «Сессии» (СКАС). Поверх графика рисуется **скользящее окно** — выделенный интервал, который можно перетаскивать и растягивать мышью. Легенда справа по значениям разреза, при наведении на элемент легенды соответствующая область подсвечивается |
| **Детальный график** | Тот же stacked area только внутри скользящего окна. Шаг корзины не задаётся жёстко: API подбирает его по запрошенному шагу и допустимому числу точек (раздел 3.4), минимальный шаг равен тику коллектора (10 секунд в MVP, 5 секунд на снимках Kintsugi). При наведении на точку — окно с временем и значениями по срезам. Клик по элементу легенды добавляет фильтр |
| **Общая активность** | Чекбокс: вместо разбивки по значениям разреза детальный график и легенда показывают одну суммарную линию |
| **Фильтры** | Условия по значениям любых разрезов, действуют на детальный график и таблицу, сохраняются при смене разреза. Строка «Фильтры не выбраны» над детальным графиком показывает текущее состояние |
| **Таблица «Топ активностей БД»** | Вкладки по разрезам. Столбец «Активность»: горизонтальная полоса с цветами подсрезов (типы ожиданий) и число. Переключатель в заголовке: **СКАС** или **%** от общей активности. Второй столбец — значение разреза: текст запроса, обрезанный до 64 символов с признаком обрезки (раздел 2.3), адрес, пользователь, база, PID, тип ожидания. Сортировка по активности; число строк top-N — параметр запроса API (на снимках 25), остаток — отдельный срез с id 0, строка `other`. Стрелка слева раскрывает вложенный срез по типам ожиданий: это второй уровень того же запроса со своим top-N и своим остатком |
| **Развернуть** | Детальный график и таблица разворачиваются на всю рабочую область |

### 2.3. Разрезы

Разрез — колонка `pg_stat_activity`, по которой активные сессии делятся на непересекающиеся
доли. Сумма долей одинакова во всех разрезах. В Kintsugi каждое значение разреза хранится
в словаре (`sa_client_hosts`, `sa_usenames`, `sa_datnames`, `sa_states`, `sa_queries`,
`sa_wait_event_types`, `sa_wait_events`), а в строках данных лежат только идентификаторы;
значения длиннее `property_value_max_len` (256 символов) обрезаются с флагом `*_overflow`.

| Разрез | Выражение над строкой снимка (Kintsugi) | Что показывает | Особенности и отличия dbperf |
|---|---|---|---|
| Типы ожиданий | `wait_event_type`; `'CPU'`, если `wait_event_type` и `wait_event` оба NULL и `state = 'active'`; иначе NULL → `'<null>'` | На что тратится время: CPU, Lock, LWLock, IO, Client, IPC, Timeout, BufferPin, Activity, Extension | У строки `fastpath function call` без ожидания получится `'<null>'`, а не CPU. Порядок в легенде по приоритету: Timeout, IPC, Client, Extension, Activity, BufferPin, LWLock, Lock, IO, CPU, other |
| Ожидания | `wait_event` с тем же правилом CPU; в UI показывается как `wait_event_type.wait_event` | Конкретное событие: `Lock.transactionid`, `LWLock.WALWrite`, `IO.WALSync`, `Client.ClientWrite` | Маркер ожидания из книги «Мониторинг PostgreSQL», с. 52 |
| SQL | Точный текст `query`, обрезанный до `query_text_property_max_len` (4096 байт), без нормализации; ключ словаря `sa_queries.query_text` | Какие запросы выполняются | **Отличие dbperf**: ключ разреза — `query_id` (PostgreSQL 14+, `compute_query_id`), нормализованный текст — из `pg_stat_statements` по `queryid`. В Kintsugi один и тот же запрос с разными литералами — разные срезы, а тексты длиннее 4096 байт склеиваются по префиксу. «Токенизированный текст» в UI — это обрезка до `property_short_value_max_len` (64 символа) с флагом `short_text_overflow`, а не нормализация |
| Хосты | `coalesce(client_addr, '<unix_socket/internal>')`, где `client_addr` = `host(client_addr)` | Откуда пришла нагрузка: серверы приложений | `NULL` для UNIX-сокета и внутренних процессов |
| Пользователи | `coalesce(usename, '<null>')` | Кто выполняет: роль, обычно одна на приложение | Выделяет мониторинг и админские сеансы |
| Базы данных | `coalesce(datname, '<null>')`, словарь хранит ещё `datid` | Куда: какая база на экземпляре под нагрузкой | |
| Процессы | `pid`; `0` и `NULL` заменяются служебными идентификаторами (`zero_pid_id`, `null_pid_id`, `malformed_pid_id`) | Конкретный серверный процесс | Kintsugi не различает переиспользованные PID. Отличие dbperf: для окон длиннее часа возможен ключ `(pid, backend_start)` |

Дополнительный разрез, которого нет в Kintsugi, но который даёт `pg_stat_activity`:
**Приложения** по `application_name`. Он точнее различает приложения, работающие под одной
ролью с одного адреса, и позволяет исключить собственные сеансы dbperf (Kintsugi исключает
только собственный `pid` сборщика прямо в запросе сбора).

---

## 3. Данные из pg_stat_activity

### 3.1. Снимок

Коллектор раз в тик (10 секунд) читает все строки `pg_stat_activity` запросом 3.1 из плана MVP
и вставляет их в таблицу ClickHouse `pg_stat_activity` с добавлением `ts` и `target`.
Kintsugi, напротив, уже при сборе оставляет только активные строки
(`state IN ('active', 'fastpath function call') AND pid <> <свой pid>`, запрос
[Activity_only.txt](Activity_only.txt)) и не читает `backend_type`, `application_name`,
`query_id`, `backend_start`. dbperf хранит полный снимок и применяет те же условия на чтении.
Дашборд использует следующие колонки.

| Колонка | Роль на дашборде | Обязательна |
|---|---|---|
| `ts` | Ось времени, корзины обзорного и детального графиков, число снимков в корзине | да |
| `target` | Выбор объекта мониторинга | да |
| `state` | Определение активности: `IN ('active', 'fastpath function call')`. Состояния `idle`, `idle in transaction`, `idle in transaction (aborted)`, `disabled` не считаются | да |
| `wait_event_type` | Разрез «Типы ожиданий», цвета полосы в таблице | да |
| `wait_event` | Разрез «Ожидания»; участвует в правиле CPU вместе с `wait_event_type` | да |
| `query_id` | Разрез «SQL» (отличие dbperf), ключ для `pg_stat_statements.queryid` | да (PostgreSQL 14+) |
| `query` | Подпись строки в разрезе SQL (первые 64 символа), окно просмотра запроса; в Kintsugi — сам ключ разреза | да |
| `client_addr` | Разрез «Хосты» | да |
| `usename` | Разрез «Пользователи» | да |
| `datname` | Разрез «Базы данных» | да |
| `pid` | Разрез «Процессы», ключ к `pg_locks`, исключение собственного процесса сборщика | да |
| `xact_start`, `state_change`, `query_start` | Панель «Блокировки»: возраст транзакции, состояния и запроса на момент снимка (Kintsugi собирает их только в режиме с блокировками); подсказка при наведении на строку таблицы | да для панели «Блокировки» |
| `application_name` | Разрез «Приложения», фильтр `!= 'dbperf'` (отличие dbperf) | желательно |
| `backend_type` | Kintsugi по нему не фильтрует: фоновые процессы отсекаются условием на `state` (у checkpointer, walwriter и подобных `state` NULL), а autovacuum и параллельные рабочие процессы в активность входят. В dbperf — только как дополнительный фильтр | нет |
| `backend_start` | Устойчивый ключ процесса вместе с `pid` (отличие dbperf) | нет |
| `leader_pid` | Склейка рабочих процессов параллельного запроса с ведущим в разрезах SQL и Процессы | нет |
| `client_hostname`, `client_port`, `datid`, `usesysid`, `backend_xid`, `backend_xmin` | На дашборде не используются, хранятся для других панелей | нет |

### 3.2. Определения

- **Активная строка снимка**: `state IN ('active', 'fastpath function call')` и `pid` не равен
  `pid` собственного сеанса сборщика. Фильтра по `backend_type` нет. Отличие dbperf:
  вместо собственного `pid` исключаются строки с `application_name = 'dbperf'`.
- **Правило CPU**: `wait_event_type = 'CPU'` и `wait_event = 'CPU'` только когда **оба** поля
  NULL и `state = 'active'`. В остальных случаях NULL в любом из полей заменяется на `'<null>'`.
  NULL в `client_addr` → `'<unix_socket/internal>'`; NULL в `usename`, `datname`, `state`,
  `query` → `'<null>'`.
- **Число снимков в корзине** `n_samples(bucket)`: считается по строкам-маркерам — в каждый
  снимок Kintsugi добавляет одну служебную строку `time_marker_row` с временем снимка и нулевым
  весом, поэтому корзина существует и тогда, когда активных сессий не было, и `n_samples` равно
  числу слитых снимков, а не числу различных `ts` среди активных строк. В dbperf роль маркера
  играет любой ряд полного снимка: `uniqExact(ts)` по всем строкам корзины **без** фильтра
  на `state` и `application_name` (собственный сеанс коллектора гарантирует, что снимок не пуст).
- **Вес среза** `n_elements(bucket, slice)`: число активных строк корзины с этим значением
  разреза (в Kintsugi — `COUNT(*)` при слиянии, суммируется при повторном слиянии той же корзины).
- **СКАС по срезу** `aas(bucket, slice) = n_elements(bucket, slice) / n_samples(bucket)`.
- **Общая активность** `aas(bucket) = Σ n_elements(bucket) / n_samples(bucket)`
  (запрос `select_slice_time_totals`).
- **СКАС в таблице** `aas(slice) = Σ n_elements(slice) / Σ n_samples` по корзинам окна
  (запрос `select_slice_top_top`, округление до 3 знаков).
- **Доля среза в таблице** `pct(slice) = Σ n_elements(slice) / Σ n_elements × 100` за окно, где
  знаменатель — вся активность окна из таблицы групп снимков, независимо от фильтров; поэтому
  при включённых фильтрах сумма долей меньше 100.
- **Top-N и остаток**: срезы ранжируются по сумме `n_elements` за **весь** запрошенный диапазон
  (не по каждой корзине отдельно), берутся первые N (при равенстве — по возрастанию ключа),
  всё остальное складывается в срез с id 0 — строка `other` в таблице и область `other`
  на графике. Вложенный срез (подсрезы по типам ожиданий) считается так же со своим N.

Точность: 10-секундный тик показывает 10 % времени каждого процесса. Запросы короче тика
видны статистически, по доле попавших в снимок; ожидание короче тика не видно вовсе
(книга, с. 37). Для шага 5 секунд, как на снимках Kintsugi, интервал в разделе 2 плана MVP
нужно снизить до 5 секунд с удвоением объёма таблицы.

### 3.3. Запросы к ClickHouse

Выражение разреза «Типы ожиданий» по правилу CPU из 3.2 (для «Ожиданий» — то же с `wait_event`):

```sql
if(wait_event_type IS NULL AND wait_event IS NULL AND state = 'active',
   'CPU', coalesce(wait_event_type, '<null>')) AS slice
```

Обзорный график: СКАС по типам ожиданий, корзина 60 секунд, последний час, top-N срезов
по сумме за диапазон и остаток `other`.

```sql
WITH samples AS (
    -- строки-маркеры: все строки снимка, без фильтров на state и application_name
    SELECT toStartOfInterval(ts, INTERVAL 60 SECOND) AS bucket, uniqExact(ts) AS n_samples
    FROM pg_stat_activity
    WHERE target = {target:String} AND ts >= now() - INTERVAL 1 HOUR
    GROUP BY bucket
),
active AS (
    SELECT
        toStartOfInterval(ts, INTERVAL 60 SECOND) AS bucket,
        if(wait_event_type IS NULL AND wait_event IS NULL AND state = 'active',
           'CPU', coalesce(wait_event_type, '<null>')) AS slice
    FROM pg_stat_activity
    WHERE target = {target:String} AND ts >= now() - INTERVAL 1 HOUR
      AND state IN ('active', 'fastpath function call')
      AND application_name != 'dbperf'      -- отличие dbperf: Kintsugi исключает только свой pid
),
top AS (
    SELECT slice FROM active GROUP BY slice ORDER BY count() DESC, slice LIMIT {n:UInt32}
)
SELECT
    a.bucket,
    if(a.slice IN (SELECT slice FROM top), a.slice, 'other') AS slice,
    count() / any(s.n_samples)           AS aas
FROM active a
JOIN samples s ON s.bucket = a.bucket
GROUP BY a.bucket, slice
ORDER BY a.bucket, slice;
```

Детальный график: тот же запрос с шагом, выбранным по разделу 3.4 (в MVP `INTERVAL 10 SECOND`),
и `ts BETWEEN {from} AND {to}` (границы скользящего окна). Для другого разреза меняется только
выражение `slice` из таблицы 2.3. Фильтры добавляются в `WHERE` подзапроса `active`;
знаменатель `samples` от фильтров не зависит. «Общая активность» — тот же запрос без `slice`
в `SELECT` и `GROUP BY`.

Таблица «Топ активностей БД», разрез SQL, оба режима (СКАС и %):

```sql
WITH
    (
        SELECT uniqExact(ts) FROM pg_stat_activity
        WHERE target = {target:String} AND ts BETWEEN {from:DateTime} AND {to:DateTime}
    ) AS n_samples,                                           -- Σ n_samples по окну
    (
        SELECT count() FROM pg_stat_activity
        WHERE target = {target:String} AND ts BETWEEN {from:DateTime} AND {to:DateTime}
          AND state IN ('active', 'fastpath function call')
          AND application_name != 'dbperf'
    ) AS n_active                                             -- Σ n_elements по окну, без фильтров
SELECT
    query_id,                                                 -- отличие dbperf: в Kintsugi ключ — текст
    any(substring(query, 1, 64))   AS query_short,            -- property_short_value_max_len
    any(length(query) > 64)        AS query_short_overflow,
    count()                        AS n_elements,
    round(n_elements / n_samples, 3)        AS aas,
    round(100 * n_elements / n_active, 3)   AS pct,
    countIf(wait_event_type IS NULL AND wait_event IS NULL AND state = 'active') AS cpu,  -- цвета полосы
    countIf(wait_event_type = 'Lock')      AS lock,
    countIf(wait_event_type = 'LWLock')    AS lwlock,
    countIf(wait_event_type = 'IO')        AS io,
    countIf(wait_event_type = 'Client')    AS client,
    n_elements - cpu - lock - lwlock - io - client AS other
FROM pg_stat_activity
WHERE target = {target:String} AND ts BETWEEN {from:DateTime} AND {to:DateTime}
  AND state IN ('active', 'fastpath function call')
  AND application_name != 'dbperf'
GROUP BY query_id
ORDER BY n_elements DESC, query_id
LIMIT {n:UInt32};
```

Строка `other` в таблице (срез с id 0): `n_active` с учётом фильтров минус `Σ n_elements`
по первым N строкам; её СКАС и доля считаются по тем же формулам. Раскрытие строки —
тот же запрос с `WHERE query_id = {id}` и `GROUP BY slice` по правилу CPU, со своим top-N
и остатком. Нормализованный текст вместо `substring(query)`: `LEFT JOIN` к последнему снимку
`pg_stat_statements` по `(target, queryid = query_id)`.

### 3.4. Два уровня хранения и выбор шага

Kintsugi хранит активность в двух парах таблиц «группы снимков + данные»
(`alignment_config` в [basic.yaml](basic.yaml)):

| Уровень | Таблицы | Шаг корзины | Ключ строки данных | Ограничение диапазона запроса |
|---|---|---|---|---|
| Секундный | `sa_active_1s_sample_groups`, `sa_active_1s_data` | `activity_resolution_sec` (параметр службы; на снимках 5 с) | `unix_time, process_id, client_host_id, usename_id, datname_id, state_id, ki_query_id, wait_event_type_id, wait_event_id` | `query_range_limit_seconds = 7200`: не более 2 часов |
| Минутный | `sa_active_1m_sample_groups`, `sa_active_1m_data` | 60 с | то же без `state_id` | нет |

Таблица групп снимков хранит на корзину `n_samples` (число слитых снимков, по строкам-маркерам)
и `n_elements` (все активные строки корзины); таблица данных — `n_elements` по каждому
сочетанию значений разрезов. Обе пары заполняются при каждом слиянии одним и тем же набором
строк, минутная — только с другим выравниванием времени. Особенность слияния: в минутную
таблицу данных строки попадают без фильтра по состоянию, поэтому в режиме с блокировками
(раздел 4.2) туда могут попасть держатели блокировок в `idle in transaction`; в секундной
таблице фильтр есть.

Уровень для запроса выбирает `select_time_alignment_config` по четырём входам: границы
диапазона, запрошенный шаг (шаги элементов экрана, из них берётся наибольший), максимальное
число точек и шаблон имени таблицы. Для каждого уровня согласованный шаг
`agreed_alignment = max(round(запрошенный / шаг уровня), 1) × шаг уровня`, границы
округляются до него (начало вниз, конец вверх и не позже последнего слитого снимка),
отбрасываются уровни, где диапазон больше `query_range_limit_seconds` или число точек больше
максимума; из оставшихся берётся уровень с наибольшим числом точек, при равенстве — с более
грубым собственным шагом. Так окно до 2 часов читается из секундной таблицы, обзорный график
за сутки — из минутной.

Для dbperf на этапе MVP оба графика читаются из сырой таблицы `pg_stat_activity` запросами
раздела 3.3: при 10-секундном тике и часовом периоде это сотни тысяч строк, что ClickHouse
агрегирует быстро. Минутный агрегат (materialized view с `n_samples`, `n_elements` по
сочетанию разрезов) стоит завести позже, когда появятся периоды длиннее часа и потребность
в удержании дольше TTL сырых таблиц; это отложено в разделе 9 плана MVP.

### 3.5. Хранение и удержание

Как устроено в Kintsugi (пригодится при проектировании агрегатов и словарей в dbperf):

- **Словари значений** (`sa_client_hosts`, `sa_usenames`, `sa_datnames`, `sa_states`,
  `sa_queries`, `sa_wait_event_types`, `sa_wait_events`, для блокировок — `locks_locktypes`,
  `locks_objects`) — автоинкрементный id, уникальное значение, флаг обрезки и `last_used`.
  При каждом слиянии новые значения добавляются, у встретившихся обновляется `last_used`
  временем последнего снимка. Словарь режимов блокировок `locks_modes` статичен (раздел 4.3).
- **Проверка пределов** (`update_service_events`) выполняется раз в заданное число слитых
  снимков. Граница по глубине: вторая по старшинству минутная корзина среди тех, что отстоят
  от последней на `history_depth_seconds` и больше. Граница по размеру: если занятые страницы
  SQLite превышают `storage_size_limit_bytes`, — вторая по старшинству минутная корзина
  вообще. Запрос на усечение — максимум из двух границ, удаляется всё, что старше её, то есть
  за один проход уходит одна минута; по размеру проверка повторяется сразу, пока размер
  не уложится в предел.
- **Очистка** (`clean`) удаляет строки данных и групп снимков обоих уровней, `locks_1s_*`
  и `locks_1s_metrics` старше границы по `unix_time`, а записи словарей — старше границы
  по `last_used` (сборка мусора словарей), после чего помечает событие выполненным.

В dbperf то же достигается средствами ClickHouse: TTL сырых таблиц (7 дней в разделе 4
плана MVP), отдельный TTL у минутного агрегата, когда он появится; словари значений
не нужны, пока текст запроса берётся из `pg_stat_statements` по `query_id`
(вынос текста в отдельную таблицу отложен, раздел 9 плана MVP).

---

## 4. Панель «Блокировки»

### 4.1. Схема экрана

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ <объект> / Блокировки                                                                │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Период: [1 мин][5 мин][15 мин][30 мин][1 час][Указать]   Автообновление: [10 с ▾] ⟳   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ОБЗОРНЫЙ ГРАФИК: среднее число блокирующих и заблокированных процессов,│ ■ n_blocked  │
│ корзина 60 с                                                           │ ■ n_blocking │
│  10 ┤            ▄▄▄                        ▄▄                 ░░░░    │              │
│   0 ┼────────────███──────────────────────────██────────────────░░░░── │              │
│     скользящее окно ────────────────────────────────────────────┘      │              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ДЕТАЛЬНЫЙ ГРАФИК: те же метрики по снимкам внутри окна; клик по точке  │ Легенда      │
│ задаёт «Временную точку» для таблицы                                   │              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Временная точка: 11:52:40                                        [Фильтры] [⤢]       │
│ ТАБЛИЦА БЛОКИРОВОК (снимок на временную точку, дерево: корень → ждущие)              │
│ [⎘] pid   │ parent  │ state   │ wait             │ tx_age │ st_age│ q_age│ user │ db │ blkd │ query  [👁] │
│ [⎘] 2072424│         │ active  │ LWLock.WALWrite  │ 0:01   │ 0:01  │ 0:00 │ maru │ pgb│ 4    │ END;        │
│ [⎘] 2072408│ 2072424 │ active  │ Lock.transactionid│ 0:01  │ 0:01  │ 0:01 │ serral│pgb│ 3    │ . UPDATE …  │
│ [⎘] 2072392│ 2072408 │ active  │ Lock.tuple       │ 0:00   │ 0:00  │ 0:00 │ classic│pgb│2    │ .. UPDATE … │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Таблица повторяет дерево блокировок из книги (с. 65–68): корневой процесс, который никого
не ждёт, и под ним ожидающие с отступом по глубине (путь `корень.потомок.потомок`).
Колонки возрастов — `tx_age`, `st_age`, `q_age` — это `xact_start`, `state_change`,
`query_start` относительно времени снимка; длительности самого ожидания в Kintsugi нет
(раздел 5). Кнопка `⎘` в начале строки копирует запрос терминации
`SELECT pg_terminate_backend(<pid>);`, кнопка в конце строки открывает полный текст запроса.
Для строки, входящей в цикл, показывается признак `is_deadlock` и `deadlock_pid`.

### 4.2. Данные из pg_locks

Kintsugi собирает активность и блокировки **одним** запросом
([Activity_with_locks.txt](Activity_with_locks.txt)):

- из `pg_locks` берутся только строки тех `locktype`, по которым в момент снимка есть хотя бы
  одна невыданная блокировка (`locktype IN (SELECT locktype FROM pg_locks WHERE NOT granted)`);
  в спокойном состоянии строк блокировок в снимке нет вовсе;
- из `pg_stat_activity` (через `JOIN pg_database` по `datid`, то есть только процессы с базой)
  берутся активные сессии **и любые сессии, держащие такие блокировки**, в том числе
  `idle in transaction` — иначе корень дерева был бы невидим; собственный `pid` исключён;
- к строке добавляются `xact_start`, `state_change`, `query_start` (целые секунды epoch)
  и поля блокировки `locktype, mode, relation, page, tuple, virtualxid, transactionid::text,
  classid, objid, objsubid, granted`.

Снимки блокировок хранятся не каждый тик: при слиянии (`data_locks.yaml`) в `locks_1s_data`
и `locks_1s_metrics` попадают только снимки, отстоящие от первого на кратное
`locks_interval_sec` (`alignment_config` для `locks_1s_data`). Группа `locks_1s_sample_groups`
заводится на каждый снимок, но график соединяет группы с метриками по `unix_time`, так что
в знаменателе остаются только сохранённые снимки; дальнейшего выравнивания времени нет.

dbperf на этапе MVP читает `pg_locks` целиком отдельным запросом 3.2 плана MVP в той же
транзакции, что и `pg_stat_activity`, каждый тик; оба снимка относятся к одному `ts` и
соединяются по `(target, ts, pid)`. Условия Kintsugi (только `locktype` с ожиданием,
только снимки с шагом `locks_interval_sec`) при необходимости применяются на чтении.

| Колонка `pg_locks` | Роль на панели | Обязательна |
|---|---|---|
| `pid` | Ключ соединения с `pg_stat_activity`, узел дерева | да |
| `granted` | `false` — процесс ждёт, `true` — удерживает. Пары «ждущий — держащий» — основа метрик и дерева | да |
| `locktype` | Часть ключа объекта: сравниваются только блокировки одного типа; фильтр при сборе в Kintsugi | да |
| `mode` | Режим `AccessShareLock` … `AccessExclusiveLock`; при построении дерева у держателя берётся самый сильный режим на объекте (словарь `locks_modes`, порядок 1..8); совместимость режимов **не** проверяется | да |
| `database`, `relation`, `page`, `tuple`, `classid`, `objid`, `objsubid` | Ключ объекта блокировки; в Kintsugi словарь `locks_objects` по `(datname_id, relation, page, tuple, classid, objid, objsubid)`, NULL хранится как 0 | да |
| `virtualxid`, `transactionid` | Остальные части ключа объекта (хранятся в строке данных, не в словаре); `transactionid` как текст | да |
| `waitstart` | Начало ожидания (PostgreSQL 14+); `wait_age = ts − waitstart`. Kintsugi не использует. **Преимущество dbperf**: единственный достоверный источник длительности ожидания, сразу после перехода в ожидание может быть NULL (книга, с. 36, 61–63) | нет для паритета с Kintsugi |
| `virtualtransaction`, `fastpath` | Не используются | нет |

Из `pg_stat_activity` к строке блокировки присоединяются `state`, `wait_event_type`,
`wait_event`, `usename`, `datname`, `client_addr`, `xact_start`, `state_change`,
`query_start`, `query`; отличие dbperf — ещё `application_name` для фильтра собственных сеансов.

### 4.3. Определения

- **Пара «заблокированный → блокирующий»** на снимке: строка `pg_locks` с `granted = false`
  (ждущий) и строка другого `pid` с `granted = true` того же `locktype` и того же объекта,
  где все поля объекта `database, relation, page, tuple, virtualxid, transactionid, classid,
  objid, objsubid` сравниваются через `IS NOT DISTINCT FROM` (NULL равен NULL). Совместимость
  режимов не проверяется: держатель `AccessShareLock` на отношении, которое кто-то ждёт
  в `AccessExclusiveLock`, тоже считается блокирующим. Это самосоединение `pg_locks`
  (запрос 1.13 книги); `pg_blocking_pids()` точнее, но берёт исключительный доступ
  к менеджеру блокировок и для регулярного опроса не рекомендуется (с. 66).
- **Метрики графиков** (`locks_1s_metrics`, запрос `select_slice_time_totals_locks`):
  `n_blocking` — число уникальных `pid`, которые держат объект, ожидаемый кем-то другим;
  `n_blocked` — число уникальных `pid`, которые ждут объект, удерживаемый кем-то другим.
  Считаются на каждый сохранённый снимок; снимок без пар получает `0/0`. На графике по корзине
  показывается `Σ n_blocked / Σ n_samples` и `Σ n_blocking / Σ n_samples`, где `n_samples` —
  число снимков блокировок в корзине; тип линии (`blocking` или `blocked`) — параметр API.
  Разбивки по `locktype` в Kintsugi нет; метрики раздела 8.2 плана MVP с `waitstart`
  остаются дополнением dbperf.
- **Дерево на временную точку** (`select_locks_tree_per_ts`, рекурсивный запрос):
  1. `pairs`: пары ждущий → держащий по правилу выше, причём для держателя берётся строка
     с самым сильным его режимом на этом объекте (`locks_modes`: AccessShareLock 1,
     RowShareLock 2, RowExclusiveLock 3, ShareUpdateExclusiveLock 4, ShareLock 5,
     ShareRowExclusiveLock 6, ExclusiveLock 7, AccessExclusiveLock 8), поэтому пара
     на один объект одна.
  2. `leads`: от каждого держателя рекурсивно вверх по цепочке «кто ждёт его» с накоплением
     пути; повторение `pid` в пути — цикл.
  3. **Корни**: держатели, которые сами никого не ждут (нет пары, где они ждущие); для цикла
     корнем назначается один его участник, и все строки цикла, включая корень, получают
     `is_deadlock = true` и один и тот же `deadlock_pid` — второй процесс в накопленном пути
     цикла.
  4. **Поддерево**: от корня вниз по `pairs` (ждущие данного процесса), с `level`, строковым
     путём `path = корень.pid.pid…`, `parent`; процесс в дерево входит один раз.
  5. Для каждой строки: `wait_on_object` — объект ожидания как JSON
     (`locktype, database, relation, page, tuple, virtualxid, transactionid, classid, objid,
     objsubid`), для строк цикла — объект собственной блокировки процесса; `blocked` — число
     потомков по `path` (прямо или транзитивно заблокированных),
     возрасты `unix_time − xact_start`, `unix_time − state_change`, `unix_time − query_start`,
     `state`, `wait_event_type`, `wait_event`, `datname`, `usename`, `client_addr`, `query`
     (до 4096 байт).
  6. **Сортировка**: по возрасту транзакции **корня** по убыванию (самые старые деревья
     сверху), затем по `path`, что даёт обход в глубину.
- **Корень дерева** на экране — строка с `level = 0` и пустым `parent`; `blkd` — `blocked`.

### 4.4. Запросы к ClickHouse

Общий подзапрос — строки блокировок с ключом объекта в виде кортежа (NULL заменены
константами, что эквивалентно `IS NOT DISTINCT FROM`) и рангом режима по `locks_modes`:

```sql
WITH locks AS (
    SELECT
        ts, pid, locktype, granted, mode,
        transform(mode,
            ['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
             'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'],
            [1, 2, 3, 4, 5, 6, 7, 8], 0)                       AS mode_rank,
        (coalesce(database, 0), coalesce(relation, 0), coalesce(page, -1), coalesce(tuple, -1),
         coalesce(virtualxid, ''), coalesce(transactionid, 0), coalesce(classid, 0),
         coalesce(objid, 0), coalesce(objsubid, -1))           AS obj
    FROM pg_locks
    WHERE target = {target:String} AND ts >= now() - INTERVAL 1 HOUR
      AND pid IS NOT NULL
)
```

Обзорный и детальный графики: среднее число заблокированных и блокирующих процессов
на корзину.

```sql
WITH
locks AS ( … ),                                            -- подзапрос из начала раздела
samples AS (
    SELECT toStartOfInterval(ts, INTERVAL 60 SECOND) AS bucket, uniqExact(ts) AS n_samples
    FROM pg_stat_activity                                  -- строки-маркеры снимков
    WHERE target = {target:String} AND ts >= now() - INTERVAL 1 HOUR
    GROUP BY bucket
),
pairs AS (
    SELECT w.ts, w.pid AS blocked_pid, h.pid AS blocking_pid
    FROM locks w
    JOIN locks h ON h.ts = w.ts AND h.locktype = w.locktype AND h.obj = w.obj
    WHERE NOT w.granted AND h.granted AND h.pid != w.pid
),
per_ts AS (
    SELECT ts, uniqExact(blocked_pid) AS n_blocked, uniqExact(blocking_pid) AS n_blocking
    FROM pairs
    GROUP BY ts
)
SELECT
    s.bucket,
    sum(p.n_blocked)  / any(s.n_samples) AS blocked_avg,   -- 10 SECOND для детального
    sum(p.n_blocking) / any(s.n_samples) AS blocking_avg
FROM samples s
LEFT JOIN per_ts p ON toStartOfInterval(p.ts, INTERVAL 60 SECOND) = s.bucket
GROUP BY s.bucket
ORDER BY s.bucket;
```

Таблица на временную точку: пары ждущий → держащий с самым сильным режимом держателя
и возрастами из `pg_stat_activity`.

```sql
WITH
locks AS ( … ),                                   -- подзапрос из начала раздела, ts = {point:DateTime}
strongest AS (
    SELECT pid, locktype, obj, argMax(mode, mode_rank) AS mode
    FROM locks
    WHERE granted
    GROUP BY pid, locktype, obj
),
pairs AS (
    SELECT w.pid AS waiter, h.pid AS locker, w.locktype, w.obj, h.mode AS locker_mode
    FROM locks w
    JOIN strongest h ON h.locktype = w.locktype AND h.obj = w.obj
    WHERE NOT w.granted AND h.pid != w.pid
),
procs AS (
    SELECT
        pid, state, wait_event_type, wait_event, usename, datname, client_addr,
        dateDiff('second', xact_start, ts)   AS tx_age_s,
        dateDiff('second', state_change, ts) AS st_age_s,
        dateDiff('second', query_start, ts)  AS q_age_s,
        substring(query, 1, 4096)            AS query
    FROM pg_stat_activity
    WHERE target = {target:String} AND ts = {point:DateTime}
)
SELECT p.waiter, p.locker, p.locktype, p.obj, p.locker_mode,
       w.state, w.wait_event_type, w.wait_event, w.usename, w.datname, w.client_addr,
       w.tx_age_s, w.st_age_s, w.q_age_s, w.query
FROM pairs p
LEFT JOIN procs w ON w.pid = p.waiter;
```

Дерево (корни, `path`, `level`, `blocked`, `is_deadlock`, `deadlock_pid`) строится
по шагам 2–6 раздела 4.3 либо рекурсивным `WITH RECURSIVE` в ClickHouse 24.4+, либо
на стороне приложения по списку `pairs`: корни — `locker`, не встречающиеся в `waiter`;
обход в глубину от корней по `pairs`, с проверкой уже пройденных `pid` для циклов. Для корней
`state`, `wait`, возрасты и `query` берутся из `procs` так же, как для ждущих. Сортировка
строк — по `tx_age_s` корня по убыванию, затем по `path`. Отличие dbperf: к строке ждущего
можно добавить `wait_age = {point} − waitstart` из `pg_locks` (раздел 5).
Запрос терминации для строки: `SELECT pg_terminate_backend(<pid>);`.

---

## 5. Что не входит

- Длительность ожиданий короче тика и события между снимками (ограничение снимков).
- Длительность самого ожидания блокировки: Kintsugi `waitstart` не собирает и показывает
  только возрасты транзакции, состояния и запроса. В dbperf `waitstart` хранится, и колонка
  `wait_age` в таблице и метрики `postgres_locks_wait_*` (раздел 8.2 плана MVP) остаются
  преимуществом dbperf, а не условием паритета (книга, с. 61–63).
- Проверка совместимости режимов при поиске блокирующего процесса: как и в Kintsugi, любой
  держатель объекта того же `locktype` считается блокирующим.
- Лёгкие блокировки (`LWLock`): в `pg_locks` их нет, они видны только как тип ожидания
  на дашборде активности.
- Имена отношений по `relation`: требуют обращения к каталогу `pg_class` наблюдаемой базы
  или отдельного словаря; на первом этапе показывается OID (Kintsugi тоже показывает объект
  ожидания числами в JSON `wait_on_object`).
- Нормализация текста запроса на стороне dbperf: берётся `query_id` и текст из
  `pg_stat_statements`. Kintsugi группирует по точному тексту до 4096 байт (раздел 2.3).
- Разрез «Приложения» и фильтр по `application_name`: отличие dbperf, в Kintsugi его нет.
