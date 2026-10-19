# SQL-запросы для анализа производительности PostgreSQL

Конспект по книге **Алексей Лесовский, «Мониторинг PostgreSQL» (Бумба, 2024, 247 с.)**.
Источник: `books/monitoring.pdf`. Репозиторий автора с тестовым окружением и скриптами:
<https://github.com/lesovsky/postgresql-monitoring-book>.

Цель документа: собрать в одном месте SQL-запросы из книги, которые можно положить в основу
инструмента анализа производительности PostgreSQL, и для каждого описать, какую информацию
он даёт и как её интерпретировать. Номера страниц указаны по печатной нумерации книги.

---

## 0. Общие принципы (глава 1, с. 15–26)

Эти правила влияют на то, как запросы ниже нужно использовать в инструменте.

1. **Два типа статистики.**
   - *Текущее состояние* (`pg_stat_activity`, `pg_locks`, `pg_stat_replication`, `pg_stat_progress_*`,
     `pg_buffercache`): снимок на момент запроса, история не хранится. Для мониторинга нужно
     опрашивать часто (секунды).
   - *Накопительная (кумулятивная)* статистика (`pg_stat_database`, `pg_stat_statements`,
     `pg_stat_user_tables`, `pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_archiver` и т. п.):
     счётчики растут с момента последнего сброса. Абсолютные значения малоинформативны,
     инструмент должен считать **дельты между двумя снимками** (rate) и учитывать поле `stats_reset`.
2. **`clock_timestamp()` вместо `now()`** при вычислении длительностей: `now()` возвращает время
   начала транзакции, `clock_timestamp()` фактическое текущее время (с. 58).
3. **Представления уровня БД** (`pg_stat_user_tables`, `pg_statio_*`, `pg_stat_user_functions`,
   `pg_stat_user_indexes`) показывают только объекты текущей базы. Чтобы собрать статистику по всему
   кластеру, нужно подключаться к каждой БД по очереди (с. 113, 141).
4. **Фоновые процессы** отфильтровываются условием `backend_type = 'client backend'`
   (PostgreSQL 10+); в старых версиях использовалось `datname IS NOT NULL` (с. 41).
5. **Права.** Для чтения большинства представлений достаточно роли `pg_monitor`; функции
   `pg_ls_*`, `pg_read_file` по умолчанию доступны суперпользователю и `pg_monitor` (с. 124–127).
6. **Параметры, влияющие на полноту статистики:** `track_io_timing` (время ввода-вывода),
   `pg_stat_statements.track_planning` (статистика планирования), `compute_query_id`
   (сквозной `query_id`), `log_lock_waits`, `log_temp_files`, `track_functions`.
7. **Сквозная идентификация запросов** (с. 91): с PostgreSQL 14 `pg_stat_activity.query_id`,
   `pg_stat_statements.queryid`, журнал (`%Q` в `log_line_prefix`) и `EXPLAIN VERBOSE` используют один
   идентификатор, по которому инструмент может связывать источники.

---

## 1. Статистика активности: сеансы, состояния, ожидания, блокировки (глава 2, с. 27–70)

Источники: `pg_stat_activity` (текущие сеансы), `pg_locks` (текущие блокировки),
`pg_stat_database` (накопительные счётчики по базам).

### 1.1. Количество подключений по базам (с. 39)

Быстрая оценка того, сколько клиентов подключено к каждой базе. Сравнивать с `max_connections`.

```sql
SELECT datname, numbackends
FROM pg_stat_database
ORDER BY numbackends DESC;
```

### 1.2. Клиентские подключения по адресу, пользователю и базе (с. 40–41)

Кто и откуда подключён. Помогает найти приложение, которое создаёт слишком много соединений,
и понять, какую нагрузку они могут генерировать. Группировку можно менять
(`application_name`, `state`, `backend_type`).

```sql
SELECT client_addr, usename, datname, count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Полный список процессов с типами (включая фоновые службы):

```sql
SELECT
    row_number() OVER (ORDER BY pid) AS n,
    pid, backend_type, client_addr, application_name, usename, datname
FROM pg_stat_activity;
```

### 1.3. Транзакционная активность по базам (с. 44–45)

`xact_commit + xact_rollback` — общее число транзакций; как дельта между снимками даёт TPS.
Большая доля `xact_rollback` сигнализирует об ошибках в приложении (см. раздел 3.5).

```sql
SELECT datname,
       xact_commit,
       xact_rollback,
       xact_commit + xact_rollback AS xacts
FROM pg_stat_database
ORDER BY xact_commit + xact_rollback DESC;
```

### 1.4. Статусы завершения сеансов (с. 46–47, PostgreSQL 14+)

`sessions_abandoned` (клиент оборвал соединение), `sessions_fatal` (ошибка уровня FATAL),
`sessions_killed` (сеанс убит администратором). В норме все три должны быть нулевыми;
рост любого из них — повод разбираться с приложением или сетью.
Дополнительно `session_time`, `active_time`, `idle_in_transaction_time` дают накопленное время
по состояниям.

```sql
SELECT datname, sessions, sessions_abandoned, sessions_fatal, sessions_killed,
       session_time, active_time, idle_in_transaction_time
FROM pg_stat_database
WHERE sessions > 0;
```

### 1.5. Распределение клиентских сеансов по состояниям (с. 50)

`active` — выполняется запрос; `idle` — ждёт команды; `idle in transaction` — транзакция открыта,
но запрос не выполняется (опасно: удерживает блокировки и горизонт очистки);
`idle in transaction (aborted)` — транзакция с ошибкой, не закрыта.

```sql
SELECT state, count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1
ORDER BY 2 DESC;
```

### 1.6. Распределение по событиям ожидания (с. 51–52)

Что именно ждут процессы: `Client.ClientRead` (ждут команду от клиента, норма для idle),
`Lock.*` (тяжёлые блокировки), `LWLock.*` (внутренние структуры, например `WALWrite`),
`IO.*` (ввод-вывод), `Timeout.*`. Большое число `Lock.*` и `IO.*` у активных процессов указывает
на проблемы с конкурентностью или дисками.

```sql
SELECT wait_event_type || '.' || wait_event AS waiting, count(*)
FROM pg_stat_activity
WHERE wait_event_type IS NOT NULL
  AND backend_type = 'client backend'
GROUP BY 1
ORDER BY 2 DESC;
```

### 1.7. Состояния сеансов с выделением ожидания блокировок (с. 53)

Основной запрос для метрики «состояния клиентов». Процессы, ожидающие тяжёлую блокировку,
выделяются в псевдосостояние `waiting` по условию `wait_event_type = 'Lock'`.

```sql
SELECT
    CASE WHEN wait_event_type = 'Lock' THEN 'waiting' ELSE state END AS state,
    count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1
ORDER BY 2 DESC;
```

Альтернативный (академический) вариант через `pg_locks.granted` (с. 53–54):

```sql
SELECT
    CASE WHEN NOT l.granted THEN 'waiting' ELSE a.state END AS state,
    count(*)
FROM pg_stat_activity a
LEFT JOIN pg_locks l ON a.pid = l.pid AND NOT l.granted
WHERE a.backend_type = 'client backend'
GROUP BY 1
ORDER BY 2 DESC;
```

### 1.8. Длительность транзакций и запросов (с. 58–59)

Выявляет самые долгие транзакции и запросы. `xact_age` — возраст транзакции, `query_age` — возраст
текущего (или последнего) запроса. Для мониторинга обычно снимают максимум по каждому состоянию
(`max(xact_age)` для `active`, `idle in transaction`, `waiting`). Порог в `WHERE` можно поднять
(например, `> '1 second'`), чтобы отсечь шум.

```sql
SELECT pid,
       usename, datname, application_name,
       CASE WHEN wait_event_type = 'Lock' THEN 'waiting' ELSE state END AS state,
       clock_timestamp() - xact_start  AS xact_age,
       clock_timestamp() - query_start AS query_age,
       left(query, 64) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND (
        clock_timestamp() - xact_start > '00:00:00'::interval
     OR (clock_timestamp() - query_start > '00:00:00'::interval
         AND state = 'idle in transaction (aborted)')
  )
ORDER BY coalesce(xact_start, query_start);
```

### 1.9. Принудительное завершение зависших бездействующих транзакций (с. 58)

Пример действия, а не метрики: завершить сеансы конкретного приложения, которые дольше минуты
висят в `idle in transaction`. Предпочтительнее настраивать `idle_in_transaction_session_timeout`.
В инструменте такое действие должно требовать явного подтверждения.

```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = 'pgbench' AND application_name = 'pgbench'
  AND clock_timestamp() - coalesce(xact_start, query_start) > '00:01:00'::interval
  AND state ~ 'idle in transaction';
```

### 1.10. Время ожидания блокировок по процессам (с. 61–62, PostgreSQL 14+)

Поле `pg_locks.waitstart` фиксирует момент начала ожидания. Запрос показывает каждый процесс,
который не смог получить блокировку, и сколько он уже ждёт.

```sql
SELECT
    a.pid, a.state, l.granted,
    a.wait_event_type || '.' || a.wait_event AS wait,
    clock_timestamp() - l.waitstart AS wait_age,
    left(a.query, 64) AS query
FROM pg_stat_activity a
JOIN pg_locks l ON a.pid = l.pid
WHERE NOT l.granted
ORDER BY wait_age DESC;
```

### 1.11. Сводка по ожиданиям блокировок: количество, максимум, сумма (с. 62)

Два подхода к метрике: сумма всех ожиданий (общая «цена» блокировок для системы) и максимальное
ожидание (худший процесс в данный момент). Используется для графиков ожиданий.

```sql
WITH q AS (
    SELECT clock_timestamp() - l.waitstart AS wait_age
    FROM pg_stat_activity a
    JOIN pg_locks l ON a.pid = l.pid
    WHERE NOT l.granted
)
SELECT count(*),
       coalesce(max(wait_age), '0'::interval) AS max,
       coalesce(sum(wait_age), '0'::interval) AS sum
FROM q;
```

### 1.12. Ожидание блокировок без `waitstart` (PostgreSQL < 14, с. 63–65)

Менее точный способ через `pg_stat_activity.state_change`: время с момента перехода в текущее
состояние засчитывается как ожидание, если у процесса есть маркер `Lock`. Переоценивает
ожидание для долгих запросов (включает полезную работу до начала ожидания).

```sql
SELECT
    a.pid, a.state, l.granted,
    a.wait_event_type || '.' || a.wait_event AS wait,
    (clock_timestamp() - a.state_change)::interval(0) AS state_age,
    (clock_timestamp() - l.waitstart)::interval(0)    AS wait_age
FROM pg_stat_activity a
JOIN pg_locks l ON a.pid = l.pid
WHERE a.wait_event_type = 'Lock';
```

### 1.13. Дерево блокировок (с. 65–68)

Полный запрос занимает несколько десятков строк и приведён в репозитории книги:
`playground/scripts/locktree.sql`. Ключевой элемент — функция `pg_blocking_pids(pid)`, которая
возвращает список процессов, блокирующих данный. Выводимые поля: `pid`, `blocked_by`, `state`
(с псевдосостоянием `waiting`), `wait`, `wait_age`, `tx_age`, `usename`, `datname`,
`blkd` (сколько процессов заблокировано этим), `query` с отступом по глубине дерева.

Предупреждение из книги: `pg_blocking_pids` берёт кратковременную эксклюзивную блокировку
менеджера блокировок, поэтому её **не следует вызывать регулярно для снятия метрик**, только
при расследовании. Минимальный вариант, пригодный для разового анализа:

```sql
SELECT
    a.pid,
    pg_blocking_pids(a.pid) AS blocked_by,
    CASE WHEN a.wait_event_type = 'Lock' THEN 'waiting' ELSE a.state END AS state,
    a.wait_event_type || '.' || a.wait_event AS wait,
    clock_timestamp() - a.xact_start AS tx_age,
    a.usename, a.datname,
    (SELECT count(*) FROM pg_stat_activity b
      WHERE a.pid = ANY(pg_blocking_pids(b.pid))) AS blkd,
    left(a.query, 80) AS query
FROM pg_stat_activity a
WHERE a.backend_type = 'client backend'
  AND (cardinality(pg_blocking_pids(a.pid)) > 0
       OR EXISTS (SELECT 1 FROM pg_stat_activity b
                   WHERE a.pid = ANY(pg_blocking_pids(b.pid))))
ORDER BY blkd DESC, tx_age DESC;
```

Для регулярного мониторинга автор рекомендует строить дерево на основе `pg_locks`
(ссылка в книге: dev.to/bolajiwahab/2022-01-13-postgresql-lock-trees-56e0).

### 1.14. Взаимоблокировки (с. 55–56)

Счётчик `pg_stat_database.deadlocks` накопительный; детали (участники, запросы) есть только
в журнале сообщений (`deadlock detected`). Любой рост счётчика следует считать ошибкой.

```sql
SELECT datname, deadlocks
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY deadlocks DESC;
```

---

## 2. Выполнение запросов и функций: `pg_stat_statements` (глава 3, с. 71–98)

Требуется расширение `pg_stat_statements` (`shared_preload_libraries`, `CREATE EXTENSION`).
Все счётчики накопительные; период накопления берётся из `pg_stat_statements_info.stats_reset`.
Время во всех полях в миллисекундах. При построении отчётов учитывать поле `toplevel`,
чтобы не считать вложенные вызовы дважды (с. 76).

Примечание по версиям: в PostgreSQL 17 поля `blk_read_time`/`blk_write_time` переименованы
в `shared_blk_read_time`/`shared_blk_write_time` (и добавлены `local_blk_*_time`);
`temp_blk_read_time`/`temp_blk_write_time` появились в 15. В запросах ниже используются имена
для версий 15–16, как в книге.

### 2.1. Сколько типов запросов накоплено и за какой период (с. 73, 90, 95)

Показывает заполненность статистики. Если `dealloc > 0`, то `pg_stat_statements.max` слишком мал
и редкие запросы вытесняются; `stats_reset` даёт период, к которому относятся все суммы.

```sql
SELECT count(*) AS statements FROM pg_stat_statements;

SELECT dealloc, stats_reset, now() - stats_reset AS age
FROM pg_stat_statements_info;
```

### 2.2. Распределение запросов по пользователям и базам (с. 76)

Метаданные: кто какие типы запросов выполняет. Полезно для группировки отчётов.

```sql
SELECT pg_get_userbyid(s.userid) AS username, d.datname, count(*)
FROM pg_stat_statements s
JOIN pg_database d ON s.dbid = d.oid
GROUP BY 1, 2
ORDER BY 3 DESC;
```

### 2.3. Общее количество вызовов (с. 80)

База для расчёта производительности в запросах/сек (дельта между снимками, делённая на интервал).

```sql
SELECT sum(calls) AS total_calls
FROM pg_stat_statements;
```

### 2.4. Самые часто вызываемые запросы (с. 81)

Какие типы запросов составляют основную долю нагрузки по количеству. Кандидаты на кеширование
на стороне приложения или на batching.

```sql
SELECT sum(calls) AS total_calls,
       left(query, 64) AS query_trunc
FROM pg_stat_statements
GROUP BY query
ORDER BY sum(calls) DESC
LIMIT 10;
```

### 2.5. Запросы, возвращающие/затрагивающие больше всего строк (с. 82–84)

Большие `rows` при частых вызовах обычно означают забытый `LIMIT` или обработку данных на стороне
приложения вместо СУБД. Среднее `rows / calls` помогает отделить массовые операции от OLTP.

```sql
SELECT sum(rows) AS total_rows,
       sum(rows) / greatest(sum(calls), 1) AS rows_per_call,
       left(query, 64) AS query_trunc
FROM pg_stat_statements
GROUP BY query
ORDER BY sum(rows) DESC
LIMIT 10;
```

### 2.6. Запросы с наибольшим суммарным временем выполнения (с. 84–85)

Главная метрика для приоритизации оптимизации: уменьшение общего времени высвобождает ресурсы
под другие запросы. Обязательно соотносить с периодом накопления (`stats_reset`).

```sql
SELECT
    to_char(interval '1 millisecond' * sum(total_exec_time), 'HH24:MI:SS') AS exec_time,
    sum(calls) AS calls,
    round((sum(total_exec_time) / greatest(sum(calls), 1))::numeric, 3) AS avg_ms,
    left(query, 64) AS query_trunc
FROM pg_stat_statements
GROUP BY query
ORDER BY sum(total_exec_time) DESC
LIMIT 10;
```

### 2.7. Статистика планирования (с. 76–79, требует `pg_stat_statements.track_planning = on`)

Поля `plans`, `total_plan_time`, `min/max/mean/stddev_plan_time`. Подозрительны случаи, когда время
планирования выросло при неизменном числе планирований. По умолчанию сбор выключен из-за накладных
расходов на OLTP.

```sql
SELECT
    plans,
    round(total_plan_time::numeric, 2) AS total_plan_ms,
    round(mean_plan_time::numeric, 3)  AS mean_plan_ms,
    round(stddev_plan_time::numeric, 3) AS stddev_plan_ms,
    left(query, 64) AS query_trunc
FROM pg_stat_statements
WHERE plans > 0
ORDER BY total_plan_time DESC
LIMIT 10;
```

### 2.8. Запросы с наибольшим временем ввода-вывода (с. 86–87, требует `track_io_timing = on`)

Суммарное время чтения/записи блоков (общий кеш + временные файлы). Показывает запросы,
которым регулярно нужен доступ к диску: кандидаты на индексы, увеличение `shared_buffers`
или ресурсов.

```sql
SELECT
    to_char(
        interval '1 millisecond' * sum(
            blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time
        ), 'HH24:MI:SS.MS'
    ) AS io_time,
    left(query, 64) AS query_trunc
FROM pg_stat_statements
WHERE blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time > 0
GROUP BY query
ORDER BY sum(blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time) DESC
LIMIT 10;
```

### 2.9. Запросы с наибольшим процессорным временем (с. 88–89)

CPU-время оценивается как `total_exec_time` минус время ввода-вывода. Точнее считает расширение
`pg_stat_kcache` (через `getrusage`), но оно не входит в стандартную поставку.

```sql
SELECT
    to_char(
        interval '1 millisecond' * sum(total_exec_time - (
            blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time)),
        'HH24:MI:SS'
    ) AS cpu_time,
    left(query, 64) AS query_trunc
FROM pg_stat_statements
GROUP BY query
ORDER BY sum(total_exec_time - (
    blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time)) DESC
LIMIT 10;
```

### 2.10. Доля ввода-вывода и CPU в общем времени (с. 89–90)

Сводный показатель по всему экземпляру: на что уходит время. Высокая доля IO — повод смотреть
кеш и диски, высокая доля CPU — планы и сами запросы.

```sql
SELECT
    sum(blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time)
        / sum(total_exec_time) AS io_percent,
    sum(total_exec_time -
        (blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time))
        / sum(total_exec_time) AS cpu_percent
FROM pg_stat_statements;
```

Та же картина по отдельным запросам (топ по общему времени с разбивкой IO / CPU):

```sql
SELECT
    to_char(interval '1 millisecond' * sum(total_exec_time), 'HH24:MI:SS') AS exec_time,
    (100 * sum(blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time)
         / sum(total_exec_time))::numeric(5,2)::text
    || ' / ' ||
    (100 * sum(total_exec_time - (
         blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time))
         / sum(total_exec_time))::numeric(5,2) AS "io / cpu, %",
    left(query, 48) AS query_trunc
FROM pg_stat_statements
GROUP BY query
ORDER BY sum(total_exec_time) DESC
LIMIT 10;
```

### 2.11. Сводный отчёт по запросам (с. 91–94)

Концепция отчёта: для каждой проекции (время, вызовы, строки, IO, WAL) посчитать общую сумму
и вклад каждого запроса в процентах, отсортировать по общему времени. Готовые скрипты:
`github.com/dataegret/pg-utils/blob/master/sql/global_reports/query_stat_total_13.sql` и отчёт
в утилите `pgcenter`. Базовая заготовка для такого отчёта:

```sql
WITH totals AS (
    SELECT sum(calls) AS calls,
           sum(rows)  AS rows,
           sum(total_exec_time) AS exec_time,
           sum(total_plan_time) AS plan_time,
           sum(blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time) AS io_time,
           sum(wal_bytes) AS wal_bytes
    FROM pg_stat_statements
    WHERE toplevel
)
SELECT
    s.queryid,
    pg_get_userbyid(s.userid) AS username,
    d.datname,
    s.calls,
    round(100.0 * s.calls / greatest(t.calls, 1), 2) AS calls_pct,
    round(s.total_exec_time::numeric, 1) AS exec_ms,
    round((100 * s.total_exec_time / greatest(t.exec_time, 1))::numeric, 2) AS exec_pct,
    round((s.total_exec_time / greatest(s.calls, 1))::numeric, 3) AS avg_ms,
    round((100 * (s.blk_read_time + s.blk_write_time + s.temp_blk_read_time + s.temp_blk_write_time)
           / greatest(s.total_exec_time, 1))::numeric, 2) AS io_pct_in_query,
    s.rows,
    round(100.0 * s.rows / greatest(t.rows, 1), 2) AS rows_pct,
    pg_size_pretty(s.wal_bytes) AS wal,
    round(100.0 * s.wal_bytes / greatest(t.wal_bytes, 1), 2) AS wal_pct,
    left(s.query, 100) AS query
FROM pg_stat_statements s
JOIN pg_database d ON d.oid = s.dbid
CROSS JOIN totals t
WHERE s.toplevel
ORDER BY s.total_exec_time DESC
LIMIT 20;
```

### 2.12. Статистика выполнения функций (с. 95–97, требует `track_functions = pl` или `all`)

`calls`, `total_time` (включая вложенные вызовы), `self_time` (без вложенных). Основной сценарий:
найти самые частые и самые долгие функции.

```sql
SELECT schemaname, funcname, calls,
       round(total_time::numeric, 2) AS total_ms,
       round(self_time::numeric, 2)  AS self_ms,
       round((self_time / greatest(calls, 1))::numeric, 3) AS avg_self_ms
FROM pg_stat_user_functions
ORDER BY self_time DESC
LIMIT 20;
```

---

## 3. Базы данных, таблицы, индексы (глава 4, с. 99–128)

### 3.1. Строки, затронутые нагрузкой, по базам (с. 107–108)

`tup_returned` / `tup_fetched` — строки, прочитанные при доступе к таблицам и индексам
(не отданные клиенту!), их нельзя суммировать между собой. `tup_inserted/updated/deleted` —
изменённые строки. Как дельты дают профиль нагрузки (чтение против записи) и позволяют заметить
смену планов (резкий рост прочитанных строк при той же нагрузке).

```sql
SELECT datname,
       tup_returned, tup_fetched,
       tup_inserted, tup_updated, tup_deleted
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY tup_returned + tup_fetched DESC;
```

### 3.2. Таблицы с последовательным сканированием (с. 110–111)

Избыточный `seq_scan` на больших таблицах в OLTP указывает на отсутствие индексов. Полезные
производные показатели: среднее число строк за одно сканирование (`seq_tup_read / seq_scan`),
доля последовательных обращений (`seq_scan / (seq_scan + idx_scan)`), размер таблицы (маленькие
таблицы сканируются последовательно законно).

```sql
SELECT relname,
       seq_scan, seq_tup_read,
       idx_scan, idx_tup_fetch,
       seq_tup_read / greatest(seq_scan, 1) AS avg_seq_tup_read,
       round(100.0 * seq_scan / greatest(seq_scan + coalesce(idx_scan, 0), 1), 2) AS seq_scan_pct,
       pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC;
```

### 3.3. Таблицы с наибольшим количеством вставок, обновлений и удалений (с. 112–113)

Какие таблицы принимают основную нагрузку на запись. `n_tup_hot_upd` показывает долю HOT-обновлений
(без обновления индексов): чем выше, тем дешевле обновления.

```sql
SELECT relname,
       seq_tup_read   AS seq_read,
       idx_tup_fetch  AS idx_fetch,
       n_tup_ins      AS inserted,
       n_tup_upd      AS updated,
       n_tup_hot_upd  AS hot_updated,
       n_tup_del      AS deleted,
       round(100.0 * n_tup_hot_upd / greatest(n_tup_upd, 1), 2) AS hot_pct
FROM pg_stat_user_tables
ORDER BY n_tup_ins + n_tup_upd + n_tup_del DESC;
```

### 3.4. Использование индексов (с. 110)

`idx_scan = 0` при длительном периоде накопления означает неиспользуемый индекс: он занимает место
и замедляет запись. `idx_tup_read` и `idx_tup_fetch` показывают, сколько элементов индекса прочитано
и сколько живых строк таблицы получено.

```sql
SELECT schemaname, relname, indexrelname,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
```

### 3.5. Ошибки и нежелательные события по базам (с. 114–116)

Все поля — счётчики событий, которых в норме быть не должно. Хорошая практика: один график со всеми
метриками. Наиболее серьёзны `deadlocks` и `checksum_failures` (повреждение данных);
`xact_rollback` и `conflicts` чаще являются следствием поведения приложения.

```sql
SELECT datname,
       xact_rollback,
       conflicts,
       deadlocks,
       checksum_failures, checksum_last_failure,
       sessions_abandoned, sessions_fatal, sessions_killed,
       stats_reset
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY datname;
```

### 3.6. Размеры табличных пространств (с. 118)

```sql
SELECT spcname,
       pg_tablespace_location(oid) AS path,
       pg_size_pretty(pg_tablespace_size(spcname)) AS size
FROM pg_tablespace
ORDER BY pg_tablespace_size(spcname) DESC;
```

### 3.7. Размеры баз данных (с. 119)

```sql
SELECT t.spcname AS tablespace,
       d.datname AS dbname,
       pg_get_userbyid(d.datdba) AS owner,
       pg_size_pretty(pg_database_size(d.datname)) AS size
FROM pg_database d
JOIN pg_tablespace t ON d.dattablespace = t.oid
ORDER BY pg_database_size(d.datname) DESC;
```

### 3.8. Размеры таблиц по слоям (с. 119–120)

`pg_total_relation_size` = таблица + TOAST + индексы; `pg_table_size` = без индексов;
`pg_relation_size(oid, fork)` даёт отдельные слои (`main`, `fsm`, `vm`, `init`).
Условие `NOT EXISTS (... AccessExclusiveLock ...)` защищает запрос от зависания на таблице,
которую в этот момент перестраивают (`VACUUM FULL`, `CLUSTER`, `TRUNCATE`).

```sql
SELECT c.relname AS "table",
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS n_idx,
       pg_size_pretty(pg_total_relation_size(c.oid))      AS total,
       pg_size_pretty(pg_relation_size(c.reltoastrelid))  AS toast,
       pg_size_pretty(pg_indexes_size(c.oid))             AS indexes,
       pg_size_pretty(pg_relation_size(c.oid, 'main'))    AS main,
       pg_size_pretty(pg_relation_size(c.oid, 'fsm'))     AS fsm,
       pg_size_pretty(pg_relation_size(c.oid, 'vm'))      AS vm,
       pg_size_pretty(pg_relation_size(c.oid, 'init'))    AS init
FROM pg_class c
WHERE c.relkind IN ('p', 'r', 'm')
  AND NOT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE relation = c.oid AND mode = 'AccessExclusiveLock' AND granted
  )
  AND pg_total_relation_size(c.oid) > 500 * 2^10
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 10;
```

### 3.9. Размеры индексов (с. 121)

```sql
SELECT coalesce(tablespace, 'pg_default') AS tablespace,
       schemaname || '.' || tablename AS "table",
       indexname AS index,
       pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes
ORDER BY pg_relation_size(indexname::regclass) DESC
LIMIT 10;
```

Для мониторинга автор советует два графика: самые большие объекты и объекты с наибольшим
**изменением** размера за интервал (аномальный рост заметен раньше).

### 3.10. Файловая система: журналы, WAL, статусы архивирования (с. 124–127)

Функции доступа к файловой системе из SQL (только суперпользователь / `pg_monitor`).
Объём журналов сообщений может незаметно исчерпать диск. `pg_ls_logdir()` возвращает ошибку,
если `logging_collector = off` и каталога `log_directory` не существует (с. 126).

```sql
-- файлы в каталоге журналов сообщений и их суммарный размер
SELECT * FROM pg_ls_logdir() ORDER BY modification DESC LIMIT 10;
SELECT pg_size_pretty(sum(size)) AS log_size FROM pg_ls_logdir();

-- последние сегменты WAL
SELECT * FROM pg_ls_waldir() ORDER BY modification DESC LIMIT 5;

-- каталог статусов архивирования
SELECT * FROM pg_ls_archive_statusdir() ORDER BY modification DESC LIMIT 5;

-- произвольные каталоги и файлы
SELECT pg_ls_dir('/');
SELECT pg_read_file('/etc/os-release');
SELECT convert_from(pg_read_binary_file('file_in_utf8.txt'), 'UTF8');
```

---

## 4. Общая память и ввод-вывод (глава 5, с. 129–156)

### 4.1. Содержимое буферного кеша по объектам (с. 131–133, расширение `pg_buffercache`)

Какие таблицы и индексы занимают больше всего буферов. `pg_buffercache` показывает только
объекты, находящиеся в кеше в момент запроса. Размер блока лучше брать из
`current_setting('block_size')`, а не константой 8192.

```sql
SELECT n.nspname, c.relname,
       count(*) AS buffers,
       pg_size_pretty(count(*) * current_setting('block_size')::bigint) AS bytes
FROM pg_buffercache b
JOIN pg_class c
  ON b.relfilenode = pg_relation_filenode(c.oid)
 AND b.reldatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
JOIN pg_namespace n ON n.oid = c.relnamespace
GROUP BY n.nspname, c.relname
ORDER BY 3 DESC
LIMIT 10;
```

### 4.2. Состояние буферов кеша: свободные, чистые, грязные, закреплённые (с. 134)

Много грязных буферов = интенсивная запись; много свободных = кеш избыточен или только что
перезапущен.

```sql
SELECT
    pg_size_pretty(count(*) FILTER (WHERE reldatabase IS NULL) * 8192) AS free,
    pg_size_pretty(count(*) FILTER (WHERE pinning_backends = 0 AND NOT isdirty) * 8192) AS clean,
    pg_size_pretty(count(*) FILTER (WHERE pinning_backends > 0 AND NOT isdirty) * 8192) AS "clean/pinned",
    pg_size_pretty(count(*) FILTER (WHERE pinning_backends = 0 AND isdirty) * 8192) AS dirty,
    pg_size_pretty(count(*) FILTER (WHERE pinning_backends > 0 AND isdirty) * 8192) AS "dirty/pinned"
FROM pg_buffercache;
```

### 4.3. Структура общей памяти (с. 135–136, PostgreSQL 13+)

Какие служебные структуры занимают общую память помимо буферного кеша.

```sql
SELECT name, off, size, allocated_size
FROM pg_shmem_allocations
ORDER BY size DESC
LIMIT 10;
```

### 4.4. Память клиентского процесса (с. 136–137, PostgreSQL 14+)

Представление показывает контексты памяти **только текущего сеанса**. Для чужого процесса
используется `pg_log_backend_memory_contexts(pid)`, которая пишет раскладку в журнал СУБД.

```sql
SELECT name, ident, parent, level, total_bytes, used_bytes, free_bytes
FROM pg_backend_memory_contexts
ORDER BY used_bytes DESC
LIMIT 10;

-- для другого процесса (результат в журнале сервера)
SELECT pg_log_backend_memory_contexts(12345);
```

### 4.5. SLRU-кеши (с. 137–138, PostgreSQL 13+)

Кеши транзакционных структур (Xact, Subtrans, MultiXact, CommitTs, Notify). Высокое `blks_read`
относительно `blks_hit` у `Subtrans` или `MultiXact*` указывает на тяжёлые сценарии
(много savepoint, `SELECT FOR SHARE`).

```sql
SELECT name, blks_zeroed, blks_hit, blks_read, blks_written, blks_exists, flushes, truncates,
       round(100.0 * blks_hit / greatest(blks_hit + blks_read, 1), 2) AS hit_pct
FROM pg_stat_slru;
```

### 4.6. Коэффициент попаданий в кеш по базам (с. 139)

Значения близкие к 1 — данные находятся в кеше. Низкое значение лечится не столько увеличением
`shared_buffers`, сколько поиском запросов, которые создают основной ввод-вывод (раздел 2.8).
Поля `blk_read_time`/`blk_write_time` (при `track_io_timing`) дают время, потраченное на диск.

```sql
SELECT datname,
       blks_hit, blks_read,
       round(blks_hit::numeric / greatest(blks_hit + blks_read, 1), 4) AS hit_ratio,
       blk_read_time, blk_write_time
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY blks_read DESC;

-- по всему экземпляру
SELECT sum(blks_hit) / sum(blks_hit + blks_read) AS hit_ratio
FROM pg_stat_database;
```

### 4.7. Ввод-вывод по таблицам и индексам (с. 139–142)

Представления `pg_statio_user_tables` / `pg_statio_user_indexes` / `pg_statio_user_sequences`:
блоки, прочитанные с диска (`*_blks_read`) и найденные в кеше (`*_blks_hit`), раздельно для
таблицы, её индексов, TOAST и индексов TOAST. Автор предупреждает: не сравнивать напрямую
hit и read в байтах, оценивать отношение. Нужна редко, в основном при поиске узких мест.

```sql
SELECT relname,
       heap_blks_read, heap_blks_hit,
       idx_blks_read,  idx_blks_hit,
       toast_blks_read, toast_blks_hit,
       tidx_blks_read,  tidx_blks_hit,
       round(100.0 * (heap_blks_hit + idx_blks_hit)
             / greatest(heap_blks_hit + idx_blks_hit + heap_blks_read + idx_blks_read, 1), 2) AS hit_pct
FROM pg_statio_user_tables
ORDER BY heap_blks_read + idx_blks_read DESC
LIMIT 20;
```

### 4.8. Ввод-вывод по запросам (с. 143–144)

В `pg_stat_statements` статистика блоков полнее, чем в `pg_statio_*`: `shared_blks_hit/read/dirtied/written`,
`local_blks_*` (временные таблицы), `temp_blks_*` (временные файлы). Сценарии: объём IO конкретных
запросов, эффект оптимизации, приоритет оптимизации.

```sql
SELECT
    calls,
    shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written,
    local_blks_hit,  local_blks_read,
    temp_blks_read,  temp_blks_written,
    round(100.0 * shared_blks_hit / greatest(shared_blks_hit + shared_blks_read, 1), 2) AS shared_hit_pct,
    left(query, 64) AS query_trunc
FROM pg_stat_statements
ORDER BY shared_blks_read DESC
LIMIT 10;
```

### 4.9. Временные файлы по базам (с. 145–146)

`temp_files` и `temp_bytes` накапливаются **после завершения** запроса. Рост означает, что
`work_mem` не хватает для сортировок, хешей, материализации CTE.

```sql
SELECT datname, temp_files, pg_size_pretty(temp_bytes) AS temp_size
FROM pg_stat_database
WHERE temp_files > 0
ORDER BY temp_bytes DESC;
```

### 4.10. Временные файлы по запросам (с. 146–147)

Какие запросы используют временные файлы и сколько времени тратят на них.

```sql
SELECT calls,
       round(total_exec_time::numeric, 1) AS exec_ms,
       pg_size_pretty(temp_blks_read * 8192)    AS temp_read_bytes,
       pg_size_pretty(temp_blks_written * 8192) AS temp_written_bytes,
       temp_blk_read_time, temp_blk_write_time,
       left(query, 64) AS query_trunc
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 10;
```

### 4.11. Активные временные файлы (с. 148–149)

Статистика выше не видит файлы **выполняющихся** запросов, а долгий запрос может исчерпать диск.
Файлы лежат в `<tablespace>/pgsql_tmp/pgsql_tmpPPP.NNN` (PPP = pid). Полный скрипт в репозитории
книги: `playground/scripts/active_temp_files.sql`. Упрощённая версия для табличного
пространства по умолчанию:

```sql
SELECT a.pid,
       clock_timestamp() - a.query_start AS query_age,
       'base/pgsql_tmp/' || f.name AS filename,
       pg_size_pretty(f.size) AS size,
       clock_timestamp() - f.modification AS last_modification,
       left(a.query, 64) AS query
FROM pg_ls_tmpdir() f
JOIN pg_stat_activity a
  ON a.pid = substring(f.name FROM 'pgsql_tmp(\d+)')::int
ORDER BY f.size DESC;
```

### 4.12. Фоновая запись и контрольные точки (с. 149–155)

`pg_stat_bgwriter` (до PostgreSQL 16 включительно одна строка; в 17 поля контрольных точек вынесены
в `pg_stat_checkpointer`, а `buffers_backend` в `pg_stat_io`).

Интерпретация:
- `checkpoints_req` растёт при превышении `max_wal_size` до истечения `checkpoint_timeout`:
  при «стратегии по расписанию» это нежелательно, сигнал о росте записи.
- `checkpoint_sync_time` большой относительно `checkpoint_write_time` — медленная дисковая
  подсистема (очереди на `fsync`).
- `buffers_backend` и `maxwritten_clean`: чем меньше оба, тем лучше справляется фоновая запись;
  рост означает, что клиентские процессы сами вытесняют грязные буферы.
- `buffers_backend_fsync > 0` — плохой признак, клиенты вынуждены делать `fsync` сами.

```sql
SELECT checkpoints_timed, checkpoints_req,
       checkpoint_write_time, checkpoint_sync_time,
       buffers_checkpoint, buffers_clean, maxwritten_clean,
       buffers_backend, buffers_backend_fsync, buffers_alloc,
       stats_reset
FROM pg_stat_bgwriter;
```

---

## 5. Журнал упреждающей записи, WAL (глава 6, с. 157–172)

### 5.1. Активность WAL (с. 161–164, PostgreSQL 14+)

`wal_records`, `wal_fpi` (полные образы страниц после контрольных точек), `wal_bytes` — объём
генерируемого журнала; `wal_buffers_full` — сколько раз буфер WAL переполнялся (повод увеличить
`wal_buffers`); `wal_write`/`wal_sync` и их время (при `track_wal_io_timing`) показывают
стоимость записи журнала.

```sql
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal_bytes,
       wal_buffers_full, wal_write, wal_sync,
       wal_write_time, wal_sync_time, stats_reset
FROM pg_stat_wal;
```

### 5.2. Текущие позиции журнала (с. 160)

```sql
SELECT pg_current_wal_insert_lsn() AS insert_lsn,
       pg_current_wal_lsn()        AS write_lsn,
       pg_current_wal_flush_lsn()  AS flush_lsn,
       pg_walfile_name(pg_current_wal_lsn()) AS current_segment;
```

### 5.3. Запросы, генерирующие больше всего WAL (с. 165)

Состав журнала по типам запросов. Помогает понять, что именно нагружает репликацию, архив и диск.

```sql
SELECT pg_size_pretty(sum(wal_bytes)) AS wal_volume,
       sum(wal_records) AS wal_records,
       sum(wal_fpi)     AS wal_fpi,
       left(query, 64)  AS query_trunc
FROM pg_stat_statements
GROUP BY query
ORDER BY sum(wal_bytes) DESC
LIMIT 10;
```

### 5.4. Анализ содержимого WAL (с. 159–160, расширение `pg_walinspect`, PostgreSQL 15+)

Для детального разбора записей между двумя LSN (аналог `pg_waldump` через SQL).

```sql
SELECT * FROM pg_get_wal_records_info('4B/DF000000', '4B/E0000000') LIMIT 14;
SELECT pg_walfile_name('4B/DF008B78');
```

### 5.5. Состояние архивирования (с. 166–170)

`archived_count` должен расти, `failed_count` нет. Возраст последнего успешного архивирования
(`last_archived_age`) растёт как при ошибках, так и при зависании `archive_command`.

```sql
SELECT archived_count, last_archived_wal, last_archived_time,
       now() - last_archived_time AS last_archived_age,
       failed_count, last_failed_wal, last_failed_time,
       stats_reset
FROM pg_stat_archiver;
```

### 5.6. Очередь архивирования (с. 169–171)

Самый универсальный индикатор проблем архивирования: число сегментов со статусом `.ready`
(ещё не отправлены в архив). Умножив на размер сегмента (по умолчанию 16 МБ), получаем объём
на диске.

```sql
SELECT count(*) AS ready_segments,
       pg_size_pretty(count(*) * 16 * 1024 * 1024) AS approx_size
FROM pg_ls_archive_statusdir()
WHERE name ~ '\.ready$';
```

---

## 6. Репликация (глава 7, с. 173–194)

### 6.1. Отставание реплик, на основном узле (с. 177–180)

По одной строке на процесс `walsender`. Отставание в байтах по этапам (отправка, запись,
синхронизация, воспроизведение) и во времени (`write_lag`, `flush_lag`, `replay_lag`).
Какой этап отстаёт, тот и является узким местом: сеть, диск реплики или её CPU/конфликты.

```sql
SELECT client_addr, application_name, state, sync_state,
       pg_current_wal_lsn() - replay_lsn AS total_lag_bytes,
       pg_current_wal_lsn() - sent_lsn   AS pending_bytes,
       sent_lsn  - write_lsn  AS write_lag_bytes,
       write_lsn - flush_lsn  AS flush_lag_bytes,
       flush_lsn - replay_lsn AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag,
       backend_xmin
FROM pg_stat_replication;
```

### 6.2. Состояние приёма журнала на реплике (с. 181–183)

На резервном узле. Для мониторинга используется редко (всё есть в `pg_stat_replication` на
основном), но полезно для выбора кандидата при аварийном переключении: сравнить
`pg_last_wal_receive_lsn()` и `pg_last_wal_replay_lsn()` между репликами.

```sql
SELECT pg_is_in_recovery() AS in_recovery,
       pg_last_wal_receive_lsn() AS receive_lsn,
       pg_last_wal_replay_lsn()  AS replay_lsn,
       pg_last_wal_receive_lsn() - pg_last_wal_replay_lsn() AS replay_backlog_bytes,
       now() - pg_last_xact_replay_timestamp() AS replay_delay;

SELECT pid, status, sender_host, sender_port, slot_name,
       written_lsn, flushed_lsn,
       last_msg_send_time, last_msg_receipt_time,
       latest_end_lsn, latest_end_time
FROM pg_stat_wal_receiver;
```

### 6.3. Слоты репликации (с. 183–187)

Слоты удерживают WAL до передачи потребителю. Неактивный слот с растущим `backlog` грозит
исчерпанием диска; `wal_status` (`reserved`, `extended`, `unreserved`, `lost`) и `safe_wal_size`
(запас до `max_slot_wal_keep_size`) показывают, насколько близка потеря слота.
Поля `xmin`/`catalog_xmin` удерживают горизонт очистки (см. раздел 7.6).

```sql
SELECT slot_name, slot_type, active, active_pid, database,
       pg_current_wal_lsn() - restart_lsn AS backlog,
       pg_size_pretty(pg_current_wal_lsn() - restart_lsn) AS backlog_pretty,
       wal_status, safe_wal_size,
       xmin, catalog_xmin
FROM pg_replication_slots;
```

### 6.4. Логическая репликация: слоты, подписки, ошибки (с. 187–190, PostgreSQL 14/15+)

`pg_stat_replication_slots`: `spill_*` (вытеснение на диск при нехватке `logical_decoding_work_mem`)
и `stream_*` (потоковая отправка), `total_txns`/`total_bytes`. `pg_stat_subscription_stats`:
`apply_error_count`, `sync_error_count` — конфликты, требующие ручного вмешательства.

```sql
SELECT slot_name, spill_txns, spill_count, pg_size_pretty(spill_bytes) AS spill_bytes,
       stream_txns, stream_count, pg_size_pretty(stream_bytes) AS stream_bytes,
       total_txns, pg_size_pretty(total_bytes) AS total_bytes, stats_reset
FROM pg_stat_replication_slots;

SELECT subid, subname, pid, relid, received_lsn,
       last_msg_send_time, last_msg_receipt_time, latest_end_lsn, latest_end_time
FROM pg_stat_subscription;

SELECT subid, subname, apply_error_count, sync_error_count, stats_reset
FROM pg_stat_subscription_stats;
```

### 6.5. Конфликты восстановления на реплике (с. 190–192)

Запросы на реплике отменяются, если мешают применению WAL дольше `max_standby_streaming_delay`.
Общий счётчик в `pg_stat_database.conflicts`, причины в `pg_stat_database_conflicts`
(чаще всего `confl_snapshot` из-за очистки на основном узле). Способы снижения:
`hot_standby_feedback`, увеличение задержки, отдельная реплика для аналитики.

```sql
SELECT datname,
       confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock
FROM pg_stat_database_conflicts
WHERE datname IS NOT NULL
ORDER BY confl_snapshot + confl_lock + confl_bufferpin + confl_deadlock + confl_tablespace DESC;
```

---

## 7. Очистка, счётчик транзакций и раздувание (глава 8, с. 195–220)

### 7.1. Какие таблицы требуют автоочистки и опаздывает ли она (с. 198–200)

Порог запуска: `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * reltuples`
(с учётом индивидуальных storage-параметров таблицы, которые этот запрос не учитывает).
`av_need = true` и `since_last_av > autovacuum_naptime` означают, что очистка не успевает.
`dead_ratio` — доля мёртвых версий.

```sql
SELECT *,
       av.dead_tup > av.boundary AS av_need,
       CASE WHEN reltuples > 0
            THEN round(100.0 * av.dead_tup / reltuples)
            ELSE 0
       END AS dead_ratio
FROM (
    SELECT n.nspname || '.' || c.relname AS relation,
           c.reltuples,
           pg_stat_get_live_tuples(c.oid) AS live_tup,
           pg_stat_get_dead_tuples(c.oid) AS dead_tup,
           round(current_setting('autovacuum_vacuum_threshold')::integer +
                 current_setting('autovacuum_vacuum_scale_factor')::numeric * c.reltuples
           ) AS boundary,
           pg_stat_get_autovacuum_count(c.oid) AS av_cnt,
           now() - pg_stat_get_last_autovacuum_time(c.oid) AS since_last_av
    FROM pg_class c
    LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
) AS av
ORDER BY av_need DESC, dead_tup DESC;
```

### 7.2. Регулярность очистки и анализа (с. 200–201)

Счётчики ручных и автоматических операций и время с последней. Таблица с большим числом
изменений и `last_autovacuum IS NULL` — повод проверить настройки.

```sql
SELECT schemaname || '.' || relname AS relation,
       n_live_tup, n_dead_tup, n_mod_since_analyze,
       vacuum_count      AS vacuum,      now() - last_vacuum      AS since_last_vacuum,
       autovacuum_count  AS autovacuum,  now() - last_autovacuum  AS since_last_autovacuum,
       analyze_count     AS analyze,     now() - last_analyze     AS since_last_analyze,
       autoanalyze_count AS autoanalyze, now() - last_autoanalyze AS since_last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

### 7.3. Горизонт заморозки по таблицам (с. 203–204)

`age(relfrozenxid)` — сколько транзакций прошло с момента последней заморозки таблицы. При
приближении к `autovacuum_freeze_max_age` (по умолчанию 200 млн) запускается принудительная
очистка «to prevent wraparound», которую нельзя отменить настройками.

```sql
SELECT c.relname, c.relfrozenxid, age(c.relfrozenxid) AS horizon,
       mxid_age(c.relminmxid) AS mxid_horizon,
       pg_stat_get_autovacuum_count(c.oid) + pg_stat_get_vacuum_count(c.oid) AS maint_count,
       now() - coalesce(pg_stat_get_last_autovacuum_time(c.oid),
                        pg_stat_get_last_vacuum_time(c.oid)) AS since_last_maint
FROM pg_class c
WHERE c.relkind IN ('r', 'm', 't')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 20;
```

### 7.4. Горизонт заморозки по базам (с. 205)

Самое старое `datfrozenxid` в кластере определяет горизонт всего кластера.

```sql
SELECT datname, datfrozenxid, age(datfrozenxid) AS horizon,
       datminmxid, mxid_age(datminmxid) AS mxid_horizon
FROM pg_database
ORDER BY age(datfrozenxid) DESC;
```

### 7.5. Запас идентификаторов транзакций, способ 1 (с. 206–207)

Из половины диапазона (2^31 − 1) вычитается максимальный возраст по `datfrozenxid` и `datminmxid`.
Критично, если `available_xids` стремится к нулю: при исчерпании СУБД перестаёт принимать запись.

```sql
SELECT max_horizon,
       2147483647 - max_horizon AS available_xids
FROM (
    SELECT greatest(max(age(datfrozenxid)), max(mxid_age(datminmxid))) AS max_horizon
    FROM pg_database
) AS d;
```

### 7.6. Горизонт видимости: кто удерживает старые версии строк (с. 207–208)

Второй способ: найти самый старый активный источник (транзакция, подготовленная транзакция,
слот репликации) и его возраст. В норме вывод пустой или возраст мал; долгие транзакции и
забытые слоты мешают очистке и вызывают раздувание.

```sql
SELECT pid, src, age AS active_horizon,
       2147483647 - coalesce(age, 0) AS available_xids
FROM (
    SELECT pid, 'pg_stat_activity', age(backend_xid)
    FROM pg_stat_activity WHERE pid != pg_backend_pid()
    UNION
    SELECT NULL, 'pg_prepared_xacts', age(transaction)
    FROM pg_prepared_xacts
    UNION
    SELECT active_pid, 'pg_replication_slots', greatest(age(xmin), age(catalog_xmin))
    FROM pg_replication_slots
) AS x(pid, src, age)
WHERE age IS NOT NULL
ORDER BY age DESC
LIMIT 1;
```

### 7.7. Раздувание таблиц, точная оценка (с. 210–212, расширение `pgstattuple`)

`pgstattuple` читает таблицу целиком (дорого на больших таблицах, запускать редко).
`dead_tuple_percent` и `free_percent` показывают долю мёртвых версий и свободного места,
которое не возвращается ОС без `VACUUM FULL`/`pg_repack`. Приближённые оценки по статистике
каталога есть в PostgreSQL Wiki.

```sql
SELECT * FROM pgstattuple('pgbench_accounts');

-- по индексу
SELECT * FROM pgstatindex('pgbench_accounts_pkey');
```

### 7.8. Активные процессы очистки (с. 213–215)

Что сейчас делает (авто)очистка и на чём ждёт. `Timeout.VacuumDelay` — штатная пауза
(`vacuum_cost_delay`); долгое ожидание блокировок или ввода-вывода — проблема.
Запрос `autovacuum: ... (to prevent wraparound)` означает принудительную очистку.

```sql
SELECT pid, datname,
       now() - xact_start AS duration,
       state, wait_event_type, wait_event,
       query
FROM pg_stat_activity
WHERE query ~ '^autovacuum' OR query ~* '^vacuum';
```

### 7.9. Ход выполнения очистки (с. 216–219)

`pg_stat_progress_vacuum` в удобочитаемом виде: фаза, процент просканированного и очищенного,
заполненность рабочей памяти (`num_dead_tuples / max_dead_tuples`; при 100 % начинается
дополнительный цикл очистки индексов), режим (`wraparound`, `user`, `regular`).
В PostgreSQL 17 поля `max_dead_tuples`/`num_dead_tuples` заменены на `max_dead_tuple_bytes`/`dead_tuple_bytes`.

```sql
SELECT
    p.pid,
    now() - a.xact_start AS duration,
    a.wait_event_type || '.' || a.wait_event AS wait_event,
    CASE
        WHEN a.query ~ '^autovacuum.*to prevent wraparound' THEN 'wraparound'
        WHEN a.query ~ '^vacuum' THEN 'user'
        ELSE 'regular'
    END AS mode,
    p.datname AS database,
    p.relid::regclass AS "table",
    p.phase,
    pg_size_pretty(p.heap_blks_total * current_setting('block_size')::int) AS table_size,
    pg_size_pretty(pg_total_relation_size(p.relid)) AS total_size,
    pg_size_pretty(p.heap_blks_scanned * current_setting('block_size')::int) AS scanned,
    round(100.0 * p.heap_blks_scanned / greatest(p.heap_blks_total, 1), 1) AS scanned_pct,
    pg_size_pretty(p.heap_blks_vacuumed * current_setting('block_size')::int) AS vacuumed,
    round(100.0 * p.heap_blks_vacuumed / greatest(p.heap_blks_total, 1), 1) AS vacuumed_pct,
    p.index_vacuum_count,
    round(100.0 * p.num_dead_tuples / greatest(p.max_dead_tuples, 1), 1) AS work_mem_usage
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a ON a.pid = p.pid
ORDER BY now() - a.xact_start DESC;
```

---

## 8. Ход выполнения длительных операций (глава 9, с. 221–234)

Все представления `pg_stat_progress_*` показывают текущее состояние и для систем мониторинга
обычно не собираются; они нужны для оперативного ответа на вопрос «когда закончится».
Общий приём: соединить с `pg_stat_activity` по `pid`, перевести блоки в байты, посчитать проценты.

### 8.1. `ANALYZE` (с. 222–224)

```sql
SELECT
    a.pid, now() - a.xact_start AS xact_age,
    p.datname, p.relid::regclass AS relation,
    a.state, a.wait_event_type || '.' || a.wait_event AS wait_event,
    p.phase,
    pg_size_pretty(p.sample_blks_total * (SELECT current_setting('block_size')::int)) AS sample_size,
    round(100 * p.sample_blks_scanned / greatest(p.sample_blks_total, 1), 2) AS "scanned,%",
    p.ext_stats_total   || '/' || p.ext_stats_computed AS "ext_total/done",
    p.child_tables_total || '/' || p.child_tables_done AS "child_total/done",
    p.current_child_table_relid::regclass AS child_in_progress,
    a.query
FROM pg_stat_progress_analyze p
JOIN pg_stat_activity a ON p.pid = a.pid
ORDER BY now() - a.xact_start DESC;
```

### 8.2. `pg_basebackup` (с. 224–226)

`backup_total` — оценка объёма (может быть `NULL` при `--no-estimate-size`), `backup_streamed` —
передано. Ожидания чаще всего `IO.*`, так как блокировки не используются.

```sql
SELECT
    a.pid,
    host(a.client_addr) AS started_from,
    to_char(a.backend_start, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
    now() - a.backend_start AS duration,
    a.state, a.wait_event_type || '.' || a.wait_event AS waiting,
    p.phase,
    pg_size_pretty(p.backup_total)    AS size_total,
    pg_size_pretty(p.backup_streamed) AS sent,
    round(100 * p.backup_streamed / greatest(p.backup_total, 1), 2) AS "sent,%",
    p.tablespaces_total || '/' || p.tablespaces_streamed AS "ts_total/streamed"
FROM pg_stat_progress_basebackup p
JOIN pg_stat_activity a ON p.pid = a.pid
ORDER BY now() - a.backend_start DESC;
```

### 8.3. `CLUSTER` и `VACUUM FULL` (с. 226–228)

Эти команды берут исключительную блокировку. Поле `blocked_total` показывает, сколько сеансов
ждут окончания перестроения, то есть насколько операция мешает приложению.

```sql
SELECT
    a.pid,
    now() - a.xact_start AS xact_age,
    p.datname,
    p.relid::regclass AS relation,
    p.cluster_index_relid::regclass AS index,
    p.command,
    a.state,
    (SELECT count(DISTINCT l.pid) FROM pg_locks l
      WHERE l.relation = p.relid AND NOT l.granted) AS blocked_total,
    a.wait_event_type || '.' || a.wait_event AS wait_event,
    p.phase,
    pg_size_pretty(p.heap_blks_total * (SELECT current_setting('block_size')::int)) AS size_total,
    round(100 * p.heap_blks_scanned / greatest(p.heap_blks_total, 1), 2) AS "scanned,%",
    coalesce(p.heap_tuples_scanned, 0) AS tuples_scanned,
    coalesce(p.heap_tuples_written, 0) AS tuples_written,
    p.index_rebuild_count,
    a.query
FROM pg_stat_progress_cluster p
JOIN pg_stat_activity a ON p.pid = a.pid
ORDER BY now() - a.xact_start DESC;
```

### 8.4. `CREATE INDEX` / `REINDEX` (с. 228–231)

Фазы ожидания (`waiting for writers before build`, `waiting for old snapshots` и т. п.) с полями
`lockers_total/done` и `current_locker_pid` показывают, какая транзакция задерживает
`CONCURRENTLY`-построение. Значения блоков и строк относятся к текущей фазе, а не к операции
в целом.

```sql
SELECT
    a.pid,
    now() - a.xact_start AS xact_age,
    p.datname,
    p.relid::regclass AS relation,
    p.index_relid::regclass AS index,
    p.command,
    a.state, a.wait_event_type || '.' || a.wait_event AS wait_event,
    p.phase,
    p.current_locker_pid AS locker_pid,
    p.lockers_total || '/' || p.lockers_done AS lockers,
    pg_size_pretty(p.blocks_total * (SELECT current_setting('block_size')::int)) AS size_total,
    round(100 * p.blocks_done / greatest(p.blocks_total, 1), 2) AS "size_done,%",
    p.tuples_total,
    round(100 * p.tuples_done / greatest(p.tuples_total, 1), 2) AS "tuples_done,%",
    p.partitions_total || '/' ||
        round(100 * p.partitions_done / greatest(p.partitions_total, 1), 2) AS "parts_total/done,%",
    a.query
FROM pg_stat_progress_create_index p
JOIN pg_stat_activity a ON p.pid = a.pid
ORDER BY now() - a.xact_start DESC;
```

### 8.5. `COPY` (с. 231–233)

Для `COPY FROM` прогресс считается по байтам исходного файла, для `COPY TO` — по строкам
относительно `pg_class.reltuples` (точность зависит от свежести статистики).

```sql
SELECT
    a.pid,
    a.state, a.wait_event_type || '.' || a.wait_event AS wait_event,
    now() - a.xact_start AS xact_age,
    p.datname, p.relid::regclass AS relation,
    pg_size_pretty(pg_relation_size(p.relid)) AS table_size_total,
    c.reltuples::bigint AS table_tuples_total,
    p.tuples_processed,
    p.tuples_excluded,
    pg_size_pretty(p.bytes_total)     AS source_file_total,
    pg_size_pretty(p.bytes_processed) AS processed,
    CASE WHEN p.command = 'COPY FROM'
         THEN round(100 * p.bytes_processed / greatest(p.bytes_total, 1), 2)
         ELSE round(100 * p.tuples_processed / greatest(c.reltuples::bigint, p.tuples_processed, 1), 2)
    END AS "done,%",
    p.command || ' ' || p.type AS command,
    a.query
FROM pg_stat_progress_copy p
LEFT JOIN pg_class c ON p.relid = c.oid
JOIN pg_stat_activity a ON p.pid = a.pid
ORDER BY now() - a.xact_start DESC;
```

---

## 9. Сводная таблица: какой запрос за что отвечает

| Область | Вопрос | Запрос | Источник | Тип |
|---|---|---|---|---|
| Подключения | Сколько клиентов и откуда, не близко ли к `max_connections` | 1.1, 1.2 | `pg_stat_database`, `pg_stat_activity` | текущее |
| Нагрузка | TPS, QPS | 1.3, 2.3 | `pg_stat_database`, `pg_stat_statements` | накопит. |
| Сеансы | Доля idle / active / idle in transaction / waiting | 1.5, 1.7 | `pg_stat_activity` | текущее |
| Ожидания | На чём ждут процессы (Lock, LWLock, IO) | 1.6 | `pg_stat_activity` | текущее |
| Блокировки | Кто сколько ждёт, кто кого блокирует | 1.10–1.13 | `pg_locks`, `pg_blocking_pids` | текущее |
| Долгие операции | Самые старые транзакции и запросы | 1.8 | `pg_stat_activity` | текущее |
| Запросы | Топ по времени, вызовам, строкам, IO, CPU, WAL | 2.4–2.10, 5.3 | `pg_stat_statements` | накопит. |
| Запросы | Планирование | 2.7 | `pg_stat_statements` | накопит. |
| Функции | Самые дорогие функции | 2.12 | `pg_stat_user_functions` | накопит. |
| Таблицы | Seq scan, профиль записи, HOT | 3.2, 3.3 | `pg_stat_user_tables` | накопит. |
| Индексы | Неиспользуемые индексы | 3.4 | `pg_stat_user_indexes` | накопит. |
| Ошибки | Откаты, deadlocks, конфликты, checksum, аварийные сеансы | 1.14, 3.5, 6.5 | `pg_stat_database(_conflicts)` | накопит. |
| Размеры | БД, таблицы, индексы, табличные пространства | 3.6–3.9 | функции `pg_*_size` | текущее |
| Кеш | Hit ratio, содержимое и состояние буферов | 4.1, 4.2, 4.6 | `pg_buffercache`, `pg_stat_database` | текущее/накопит. |
| IO | По объектам и по запросам | 4.7, 4.8 | `pg_statio_*`, `pg_stat_statements` | накопит. |
| Временные файлы | По базам, по запросам, активные | 4.9–4.11 | `pg_stat_database`, `pg_stat_statements`, `pg_ls_tmpdir` | накопит./текущее |
| Checkpoint / bgwriter | Внеплановые контрольные точки, время sync, buffers_backend | 4.12 | `pg_stat_bgwriter` | накопит. |
| WAL | Объём генерации, wal_buffers_full, архивирование, очередь | 5.1, 5.5, 5.6 | `pg_stat_wal`, `pg_stat_archiver`, `pg_ls_archive_statusdir` | накопит./текущее |
| Репликация | Отставание по этапам, слоты, логическая репликация | 6.1–6.4 | `pg_stat_replication`, `pg_replication_slots` | текущее |
| Очистка | Нужна ли, успевает ли, что делает сейчас | 7.1, 7.2, 7.8, 7.9 | `pg_stat_user_tables`, `pg_stat_progress_vacuum` | накопит./текущее |
| Wraparound | Запас XID, кто держит горизонт | 7.3–7.6 | `pg_class`, `pg_database`, `pg_stat_activity` | текущее |
| Раздувание | Доля мёртвых строк и свободного места | 7.7 | `pgstattuple` | по запросу |
| Прогресс | ANALYZE, basebackup, CLUSTER, CREATE INDEX, COPY | 8.1–8.5 | `pg_stat_progress_*` | текущее |

## 10. Замечания для реализации инструмента

- **Снимки и дельты.** Для всех накопительных представлений хранить предыдущий снимок и считать
  `rate = (new − old) / Δt`, обнуляя дельту при изменении `stats_reset` или уменьшении счётчика.
- **Нормализация единиц.** Блоки умножать на `current_setting('block_size')`, время в
  `pg_stat_statements`/`pg_stat_database` в миллисекундах, `pg_stat_wal` байты.
- **Версии PostgreSQL.** Проверять `server_version_num` и подставлять имена полей:
  `waitstart` (14+), `sessions_*` (14+), `pg_stat_wal` (14+), `temp_blk_*_time` (15+),
  `pg_stat_io` (16+), `pg_stat_checkpointer` и `shared_blk_*_time` (17+).
- **Top-K с «other».** Автор везде использует графики top-K, где остальные значения суммируются
  в отдельную серию `other`: так видно и лидеров, и общий объём.
- **Дорогие запросы.** `pg_blocking_pids`, `pgstattuple`, `pg_buffercache` на большом кеше и
  функции `pg_ls_*` на каталогах с тысячами файлов нельзя вызывать с высокой частотой.
- **Осторожность с размерами.** Запросы размеров объектов должны исключать таблицы под
  `AccessExclusiveLock`, иначе сборщик метрик сам повиснет (раздел 3.8).
