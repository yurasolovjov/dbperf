# Представления статистики PostgreSQL: справочник

Конспект по книге **Алексей Лесовский, «Мониторинг PostgreSQL» (Бумба, 2024)**, `books/monitoring.pdf`.
Документ описывает основные таблицы и представления, из которых инструмент анализа
производительности может получать статистику: что в них хранится, какие поля важны и как их
читать. Готовые SQL-запросы к этим представлениям собраны в
[postgres-monitoring-queries.md](postgres-monitoring-queries.md); ссылки вида «запрос 2.6»
указывают на разделы того документа. Номера страниц даны по печатной нумерации книги.

---

## 0. Как устроена статистика (глава 1, с. 23–25)

**Интерфейс статистики.** Все представления `pg_stat_*` — это SQL-обёртки над функциями
`pg_stat_get_*` (например, `pg_stat_activity` над `pg_stat_get_activity`, `pg_stat_database`
над семейством `pg_stat_get_db_*`, `pg_locks` над `pg_lock_status`). Функции можно вызывать
напрямую, что удобно, когда нужно одно значение для конкретного объекта
(`pg_stat_get_dead_tuples(oid)`, `pg_stat_get_last_autovacuum_time(oid)`).

**Два класса представлений.**

| Класс | Что показывает | Примеры | Как использовать в инструменте |
|---|---|---|---|
| Снимок (текущее состояние) | Что происходит в момент запроса; история не хранится, события между снимками теряются | `pg_stat_activity`, `pg_locks`, `pg_stat_replication`, `pg_replication_slots`, `pg_stat_progress_*`, `pg_buffercache` | Частый опрос (секунды); агрегировать в метрики `count`, `max`, `sum`; помнить о неполноте (с. 37) |
| Накопительные счётчики | Суммы с момента последнего сброса | `pg_stat_database`, `pg_stat_statements`, `pg_stat_*_tables`, `pg_statio_*`, `pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_archiver`, `pg_stat_slru` | Хранить предыдущий снимок и считать дельты (rate); учитывать `stats_reset` и сброс при перезапуске |

**Область видимости.** Часть представлений глобальна для кластера (`pg_stat_activity`,
`pg_stat_database`, `pg_stat_statements`, `pg_stat_bgwriter`, `pg_stat_wal`), часть показывает
только объекты базы, к которой выполнено подключение (`pg_stat_*_tables`, `pg_stat_*_indexes`,
`pg_statio_*`, `pg_stat_user_functions`, `pg_stat_progress_*` для relid). Для последних инструмент
должен обходить все базы.

**Префиксы `all / user / sys`.** `pg_stat_all_tables` содержит все таблицы, `pg_stat_user_tables`
только пользовательские, `pg_stat_sys_tables` только системного каталога. То же для индексов и
`pg_statio_*`. В книге везде используются `user`-варианты.

**Параметры, от которых зависит полнота данных.**

| Параметр | Что включает |
|---|---|
| `track_activities` | заполнение `pg_stat_activity.query`, `state`, `wait_event*` (по умолчанию on) |
| `track_activity_query_size` | размер буфера текста запроса в `pg_stat_activity.query` (1 КБ) |
| `track_counts` | накопительные счётчики таблиц и баз, без него не работает автоочистка |
| `track_io_timing` | `blk_read_time`/`blk_write_time` в `pg_stat_database` и `pg_stat_statements` |
| `track_wal_io_timing` | `wal_write_time`/`wal_sync_time` в `pg_stat_wal` |
| `track_functions` | `pg_stat_user_functions` (`none`/`pl`/`all`) |
| `compute_query_id` | `query_id` в `pg_stat_activity`, журнале и `EXPLAIN` |
| `shared_preload_libraries = pg_stat_statements` | само расширение |
| `pg_stat_statements.track_planning` | статистика планирования |

**Права.** Роль `pg_monitor` (и входящие в неё `pg_read_all_stats`, `pg_read_all_settings`)
даёт чтение всех представлений; функции файловой системы `pg_ls_*` доступны `pg_monitor`.

---

## 1. Активность: `pg_stat_activity`, `pg_locks`, `pg_stat_database` (глава 2)

### 1.1. `pg_stat_activity` (с. 31–35)

**Назначение.** Главный источник первичной информации при любых подозрениях на проблемы.
Одна строка на серверный процесс: клиентские процессы и фоновые службы. **Снимок.**
Глобально для кластера.

| Группа | Поля | Что показывают |
|---|---|---|
| Идентификация клиента | `client_addr`, `client_hostname`, `client_port`, `usename`, `datname`, `application_name` | Откуда и кто подключён. `client_addr` NULL для UNIX-сокета. `application_name` задаёт само приложение, удобно для различения приложений с одинаковыми реквизитами |
| Тип процесса | `backend_type` | `client backend`, `autovacuum worker`, `walsender`, `checkpointer`, `background writer`, `walwriter`, `archiver` и т. д. (с PostgreSQL 10). Фильтр клиентов: `backend_type = 'client backend'` |
| Идентификаторы процессов | `pid`, `leader_pid` | `pid` — ключ для соединения с `pg_locks`, `pg_stat_progress_*`, `pg_stat_replication`. `leader_pid` у рабочих процессов параллельного запроса указывает на ведущий процесс |
| Время | `backend_start`, `xact_start`, `query_start`, `state_change` | Начало сеанса, текущей транзакции, текущего (или последнего) запроса, последнего перехода состояния. Длительности считать через `clock_timestamp()` |
| Состояние | `state` | `active`, `idle`, `idle in transaction`, `idle in transaction (aborted)`, `fastpath function call`, `disabled`. Для фоновых процессов NULL |
| Ожидания | `wait_event_type`, `wait_event` | Тип (`Lock`, `LWLock`, `IO`, `Client`, `Timeout`, `IPC`, `BufferPin`, `Activity`, `Extension`) и конкретное событие. NULL означает, что процесс работает на CPU. `wait_event_type = 'Lock'` — ожидание тяжёлой блокировки (псевдосостояние `waiting`) |
| Запрос | `query`, `query_id` | Текст текущего/последнего запроса (обрезан до `track_activity_query_size`) и его идентификатор для связи с `pg_stat_statements.queryid` (с 14, при `compute_query_id`) |
| Транзакции | `backend_xid`, `backend_xmin` | Номер транзакции процесса и его горизонт видимости. Нужны при расследовании раздувания и удержания горизонта очистки (глава 8) |

**Особенность (с. 37).** Снимок не показывает, что было между опросами; короткие ожидания
теряются. Объективность картины зависит от частоты опроса. Автор рекомендует интервал
в несколько секунд, на практике 15–60 секунд.

**Что считать.** Количество сеансов по состояниям (запрос 1.5, 1.7), по событиям ожидания (1.6),
максимальные длительности транзакций/запросов/ожиданий по состояниям (1.8), активные
процессы очистки (7.8).

### 1.2. `pg_locks` (с. 35–37)

**Назначение.** Удерживаемые и ожидаемые тяжёлые блокировки. Одна строка на пару
«объект – процесс»; один объект может встречаться несколько раз, если его ждут несколько
процессов. Лёгкие блокировки (LWLock) здесь не отображаются. **Снимок.** Почти всегда
используется в соединении с `pg_stat_activity` по `pid`.

| Группа | Поля | Что показывают |
|---|---|---|
| Объект блокировки | `locktype`, `relation`, `page`, `tuple`, `virtualxid`, `transactionid`, `classid`, `objid`, `objsubid`, `database` | Что заблокировано: отношение, страница, строка, транзакция (виртуальная/реальная), объект каталога. Незначимые поля NULL |
| Кто | `pid`, `virtualtransaction` | Процесс и виртуальная транзакция, которая удерживает или ждёт |
| Детали | `mode` | Режим (`AccessShareLock` … `AccessExclusiveLock`), определяет совместимость |
| | `granted` | `true` — удерживается, `false` — ожидается |
| | `waitstart` | Время начала ожидания (с 14). Единственный достоверный источник длительности ожидания; сразу после `granted = false` может недолго быть NULL |
| | `fastpath` | Взята через fast-path интерфейс (устаревший) |

**Что считать.** Число ожидающих процессов, максимальное и суммарное время ожидания
(запросы 1.10, 1.11). Дерево блокировок строится либо через `pg_blocking_pids()` (дорого,
не для регулярного опроса), либо через самосоединение `pg_locks` (1.13).

### 1.3. `pg_stat_database` (с. 37–39, 44–47, 107–116, 139, 145)

**Назначение.** Накопительная статистика по каждой базе плюс одна строка с NULL в `datname`
для разделяемых объектов. Основано на `pg_stat_get_db_*`. Единственное текущее поле —
`numbackends`, остальные **накопительные**.

| Группа | Поля | Что показывают |
|---|---|---|
| Подключения | `numbackends` | Текущее число клиентских процессов в базе |
| Транзакции | `xact_commit`, `xact_rollback` | Зафиксированные и откаченные транзакции (включая неявные одиночные запросы). Сумма — TPS; `xact_rollback` как счётчик ошибок приложения |
| Сеансы (с 14) | `sessions`, `sessions_abandoned`, `sessions_fatal`, `sessions_killed` | Всего сеансов; оборваны клиентом/сетью; завершены по FATAL (в т. ч. `idle_in_transaction_session_timeout`); убиты администратором или при остановке сервера. Три последних в норме не растут |
| Время сеансов (с 14) | `session_time`, `active_time`, `idle_in_transaction_time` | Накопленное время во всех сеансах, в активном состоянии и в `idle in transaction`. Обновляется при смене состояния, поэтому возможны скачки |
| Строки | `tup_returned`, `tup_fetched`, `tup_inserted`, `tup_updated`, `tup_deleted` | Строки, прочитанные при последовательном/индексном доступе (не отданные клиенту!), и изменённые. `returned` и `fetched` не суммировать |
| Ввод-вывод | `blks_read`, `blks_hit`, `blk_read_time`, `blk_write_time` | Блоки с диска (включая page cache ОС) и из кеша; время при `track_io_timing`. Hit ratio = `blks_hit / (blks_hit + blks_read)` |
| Временные файлы | `temp_files`, `temp_bytes` | Количество и объём временных файлов, учитываются после завершения запроса |
| Ошибки | `deadlocks`, `conflicts`, `checksum_failures`, `checksum_last_failure` | Взаимоблокировки, конфликты восстановления (на репликах), ошибки контрольных сумм. Все должны быть нулевыми |
| Служебное | `stats_reset` | Время сброса статистики |

**Что считать.** Запросы 1.1, 1.3, 1.4, 3.1, 3.5, 4.6, 4.9.

---

## 2. Запросы и функции: `pg_stat_statements` (глава 3)

### 2.1. `pg_stat_statements` (с. 73–90)

**Назначение.** Накопительная статистика по **типам** запросов: текст нормализуется
(константы заменяются на `$1, $2 …`), и все однотипные запросы учитываются в одной строке.
Сохраняются только успешно выполненные запросы; завершившиеся ошибкой не учитываются.
Глобально для всех баз, хотя расширение устанавливается в одну базу. **Накопительное.**

**Настройка.** `shared_preload_libraries = 'pg_stat_statements'` + перезапуск,
затем `CREATE EXTENSION pg_stat_statements` в любой базе. Параметры:

| Параметр | Значение | Замечание из книги |
|---|---|---|
| `pg_stat_statements.max` | число отслеживаемых типов (5000) | На production увеличивать минимум вдвое, чтобы избежать перезапуска; факт вытеснения виден в `pg_stat_statements_info.dealloc` |
| `pg_stat_statements.track` | `top` / `all` / `none` | `all` при наличии хранимых функций; тогда в отчётах фильтровать по `toplevel` |
| `pg_stat_statements.track_utility` | on/off | Учитывать служебные команды (`VACUUM`, `CREATE INDEX`, …) |
| `pg_stat_statements.track_planning` | off | Включает статистику планирования; может снижать производительность на OLTP |
| `pg_stat_statements.save` | on | Сохранять статистику между перезапусками |

**Категории полей** (с. 75):

| Категория | Поля | Описание |
|---|---|---|
| Метаданные | `userid`, `dbid`, `queryid`, `query`, `toplevel` | Пользователь (`pg_get_userbyid`), база (join `pg_database`), идентификатор запроса (одинаков для одного текста в разных базах/у разных пользователей), нормализованный текст, признак вызова верхнего уровня (с 14) |
| Планирование (с 13) | `plans`, `total_plan_time`, `min/max/mean/stddev_plan_time` | Число планирований и время, мс. Подозрительно, когда время выросло при неизменном `plans` |
| Исполнение | `calls`, `rows`, `total_exec_time`, `min/max/mean/stddev_exec_time` | Вызовы, возвращённые/затронутые строки, время исполнения (включает ожидание блокировок!). `calls` и `plans` независимы: prepared statements кешируют план. До версии 1.9 поля назывались без `exec` (`total_time`) |
| Ввод-вывод, общий кеш | `shared_blks_hit`, `shared_blks_read`, `shared_blks_dirtied`, `shared_blks_written` | Блоки в кеше, прочитанные с диска/page cache, загрязнённые и записанные. Загрязнение не равно записи |
| Ввод-вывод, локальный кеш | `local_blks_hit`, `local_blks_read`, `local_blks_dirtied`, `local_blks_written` | То же для временных таблиц (`temp_buffers`) |
| Временные файлы | `temp_blks_read`, `temp_blks_written`, `temp_blk_read_time`, `temp_blk_write_time` (с 15) | Объём и время работы с временными файлами (сортировки, хеши при нехватке `work_mem`). `_hit`/`_dirtied` отсутствуют, так как кеширования нет |
| Время IO | `blk_read_time`, `blk_write_time` | Время блочного ввода-вывода в общем и локальном кешах, мс, при `track_io_timing`. В PostgreSQL 17 переименованы в `shared_blk_read_time`/`shared_blk_write_time`, добавлены `local_blk_*_time` |
| WAL (с 13) | `wal_records`, `wal_fpi`, `wal_bytes` | Сколько журнала генерирует тип запроса |
| JIT (с 15) | `jit_functions`, `jit_generation_time`, `jit_inlining_*`, `jit_optimization_*`, `jit_emission_*` | Статистика JIT-компиляции |

**Производные величины, которые использует автор.**
- CPU-время ≈ `total_exec_time − (blk_read_time + blk_write_time + temp_blk_read_time + temp_blk_write_time)`
  (точнее даёт `pg_stat_kcache`).
- Доля IO/CPU по экземпляру и по запросу (запрос 2.10).
- Среднее время = `total_exec_time / calls`; `stddev_exec_time` близкое к нулю — стабильная нагрузка,
  большой разброс — ожидания блокировок или смена планов.
- Период накопления = `now() − pg_stat_statements_info.stats_reset`.

**Что считать.** Top-K по `calls`, `rows`, `total_exec_time`, IO-времени, CPU-времени,
`wal_bytes`, `temp_blks_written` (запросы 2.3–2.10, 4.8, 4.10, 5.3); сводный отчёт с долями
(2.11).

### 2.2. `pg_stat_statements_info` (с. 94–95, с 14)

Одна строка, два поля:

| Поле | Описание |
|---|---|
| `dealloc` | Сколько раз расширение удаляло редко используемую статистику из-за `pg_stat_statements.max`. Ненулевое значение означает потерю данных и неточные отчёты |
| `stats_reset` | Время последнего сброса (`pg_stat_statements_reset()`); определяет период, за который накоплена статистика |

### 2.3. `pg_stat_user_functions` (с. 95–97)

**Назначение.** Статистика выполнения функций на процедурных языках (при `track_functions = pl`)
или всех, включая SQL и C (`all`). Встраиваемые (inline) SQL-функции не отслеживаются.
Уровень базы данных. **Накопительное.**

| Поле | Описание |
|---|---|
| `funcid`, `schemaname`, `funcname` | Идентификация; имя может повторяться из-за перегрузки |
| `calls` | Число вызовов |
| `total_time` | Общее время, мс, включая вложенные функции |
| `self_time` | Время самой функции без вложенных |

Сценарий: найти самые горячие и самые дорогие функции (запрос 2.12), затем через
`pg_stat_statements` найти запросы, которые их вызывают.

---

## 3. Объекты базы: таблицы, индексы, размеры (глава 4)

### 3.1. `pg_stat_user_tables` / `pg_stat_all_tables` (с. 109–113, 196–201)

**Назначение.** Накопительная статистика использования и обслуживания каждой таблицы.
Уровень базы. Основано на функциях `pg_stat_get_*` с аргументом oid.

| Группа | Поля | Описание |
|---|---|---|
| Идентификация | `relid`, `schemaname`, `relname` | |
| Доступ | `seq_scan`, `seq_tup_read` | Число последовательных сканирований и прочитанных ими строк. Избыточно для OLTP на больших таблицах |
| | `idx_scan`, `idx_tup_fetch` | Число индексных сканирований и живых строк, полученных через индексы (включая битовые карты, которые нельзя отнести к конкретному индексу) |
| Изменения | `n_tup_ins`, `n_tup_upd`, `n_tup_del`, `n_tup_hot_upd` | Вставлено, обновлено (включая HOT), удалено, HOT-обновлений. Высокая доля HOT означает дешёвые обновления без правки индексов |
| | `n_tup_newpage_upd` (с 16) | Обновления с переносом версии на новую страницу |
| Состояние | `n_live_tup`, `n_dead_tup`, `n_mod_since_analyze`, `n_ins_since_vacuum` | Оценка живых и мёртвых версий; изменений с последнего ANALYZE; вставок с последнего VACUUM |
| Очистка | `last_vacuum`, `last_autovacuum`, `vacuum_count`, `autovacuum_count` | Когда и сколько раз таблица очищалась вручную и автоматически |
| Анализ | `last_analyze`, `last_autoanalyze`, `analyze_count`, `autoanalyze_count` | То же для сбора статистики планировщика |
| | `last_seq_scan`, `last_idx_scan` (с 16) | Время последнего сканирования |

**Производные показатели (с. 111).** Среднее строк на одно seq-сканирование
`seq_tup_read / seq_scan`; доля последовательных обращений `seq_scan / (seq_scan + idx_scan)`;
размер таблицы для приоритизации. Порог автоочистки
`autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples`
сравнивается с `n_dead_tup` (запрос 7.1). Запросы 3.2, 3.3, 7.2.

### 3.2. `pg_stat_user_indexes` / `pg_stat_all_indexes` (с. 110)

| Поле | Описание |
|---|---|
| `relid`, `indexrelid`, `schemaname`, `relname`, `indexrelname` | Идентификация таблицы и индекса |
| `idx_scan` | Число обращений к индексу. Ноль за длительный период — неиспользуемый индекс (занимает место, замедляет запись) |
| `idx_tup_read` | Элементов индекса прочитано при сканированиях |
| `idx_tup_fetch` | Живых строк таблицы получено при простых индексных сканированиях. При битовых картах не растёт (растёт `pg_stat_user_tables.idx_tup_fetch`) |
| `last_idx_scan` (с 16) | Время последнего использования |

Запрос 3.4.

### 3.3. `pg_statio_user_tables`, `pg_statio_user_indexes`, `pg_statio_user_sequences` (с. 140–142)

**Назначение.** Ввод-вывод в блоках по объектам. Уровень базы. **Накопительное.**
По опыту автора нужны редко, для точечного поиска узких мест; на больших кластерах
дают много метрик.

| Представление | Поля |
|---|---|
| `pg_statio_user_tables` | `heap_blks_read/hit` (таблица), `idx_blks_read/hit` (все её индексы), `toast_blks_read/hit`, `tidx_blks_read/hit` (TOAST и его индексы) |
| `pg_statio_user_indexes` | `idx_blks_read`, `idx_blks_hit` |
| `pg_statio_user_sequences` | `blks_read`, `blks_hit` |

`_hit` — блок найден в буферном кеше, ввода-вывода не было; `_read` — прочитан с диска или
из page cache ОС. Оценивать отношение hit к (hit + read), а не сравнивать объёмы в байтах.
Запрос 4.7.

### 3.4. Системный каталог для размеров и горизонтов (с. 117–121, 203–206)

Не статистика, но источники, без которых анализ неполон.

| Источник | Поля / функции | Для чего |
|---|---|---|
| `pg_class` | `relname`, `relkind`, `reltuples`, `relpages`, `relfrozenxid`, `relminmxid`, `reltoastrelid`, `relfilenode` | Оценка числа строк, горизонт заморозки таблицы (`age(relfrozenxid)`), связь с `pg_buffercache` |
| `pg_database` | `datname`, `datfrozenxid`, `datminmxid`, `dattablespace` | Горизонт заморозки базы и кластера (`age(datfrozenxid)`, `mxid_age(datminmxid)`) |
| `pg_tablespace`, `pg_indexes`, `pg_index`, `pg_namespace` | | Табличные пространства, список индексов и их принадлежность |
| `pg_prepared_xacts` | `transaction`, `prepared` | Подготовленные транзакции, удерживающие горизонт |
| Функции размеров | `pg_database_size`, `pg_tablespace_size`, `pg_total_relation_size` (таблица + TOAST + индексы), `pg_table_size` (без индексов), `pg_indexes_size`, `pg_relation_size(oid, fork)` с `main`/`fsm`/`vm`/`init` | Размеры объектов, запросы 3.6–3.9 |
| Функции файловой системы | `pg_ls_dir`, `pg_ls_logdir`, `pg_ls_waldir`, `pg_ls_archive_statusdir`, `pg_ls_tmpdir`, `pg_stat_file`, `pg_read_file`, `pg_read_binary_file`, `pg_relation_filepath` | Объём журналов сообщений, очередь архивирования, активные временные файлы |

---

## 4. Память и ввод-вывод (глава 5)

### 4.1. `pg_buffercache` (с. 130–134, расширение)

**Назначение.** Одна строка на каждый буфер общего кеша (`shared_buffers`): какие объекты
сейчас в кеше, сколько они занимают, сколько буферов свободных, чистых, грязных. Расширение
ставится в одну базу, но показывает буферы всех баз; преобразовать `relfilenode` в имя через
`pg_class` можно только для текущей базы. **Снимок.** Дорого на больших кешах.

| Поле | Описание |
|---|---|
| `bufferid` | Номер буфера; у свободных буферов все остальные поля NULL |
| `relfilenode`, `reltablespace`, `reldatabase` | Объект: файл отношения (`pg_relation_filenode(oid)`), табличное пространство, база (0 для разделяемых объектов) |
| `relforknumber` | Слой: 0 main, 1 fsm, 2 vm, 3 init |
| `relblocknumber` | Номер блока в отношении |
| `isdirty` | Буфер изменён и ещё не записан |
| `usagecount` | Счётчик обращений 0–5 для алгоритма Clock Sweep: насколько активно используется |
| `pinning_backends` | Сколько процессов закрепили буфер (читают/изменяют прямо сейчас) |

Состояния буфера по книге: свободный (`reldatabase IS NULL`), чистый, чистый/закреплённый,
грязный, грязный/закреплённый. Запросы 4.1, 4.2. В PostgreSQL 16 есть также
`pg_buffercache_summary()` и `pg_buffercache_usage_counts()`.

### 4.2. `pg_shmem_allocations` (с. 135–136, с 13)

Служебные структуры в общей памяти помимо буферного кеша: `name`, `off`, `size`,
`allocated_size`. Строка `<anonymous>` — анонимные выделения, строка с NULL в `name` —
неиспользованная память. Запрос 4.3.

### 4.3. `pg_backend_memory_contexts` (с. 136–137, с 14)

Контексты памяти **только текущего** сеанса: `name`, `ident`, `parent`, `level`, `total_bytes`,
`total_nblocks`, `free_bytes`, `free_chunks`, `used_bytes`. Для чужого процесса
`pg_log_backend_memory_contexts(pid)` выводит раскладку в журнал сервера. Запрос 4.4.

### 4.4. `pg_stat_slru` (с. 137–138, с 13)

Накопительная статистика SLRU-кешей (`CommitTs`, `MultiXactMember`, `MultiXactOffset`, `Notify`,
`Serial`, `Subtrans`, `Xact`, `other`): `blks_zeroed`, `blks_hit`, `blks_read`, `blks_written`,
`blks_exists`, `flushes`, `truncates`, `stats_reset`. Размеры этих кешей не настраиваются
(до 17), поэтому статистика нужна для оценки эффективности. Запрос 4.5.

### 4.5. `pg_stat_bgwriter` (с. 149–155)

**Назначение.** Одна строка со статистикой фоновой записи и контрольных точек.
**Накопительное.** В PostgreSQL 17 поля контрольных точек вынесены в `pg_stat_checkpointer`,
а `buffers_backend*` удалены в пользу `pg_stat_io` (с 16).

| Поле | Описание и интерпретация |
|---|---|
| `checkpoints_timed` | Контрольные точки по расписанию (`checkpoint_timeout`) |
| `checkpoints_req` | По необходимости: превышен `max_wal_size`, команда `CHECKPOINT`, остановка сервера. При стратегии «по расписанию» их рост означает рост записи |
| `checkpoint_write_time` | Время записи страниц, мс; основная часть контрольной точки |
| `checkpoint_sync_time` | Время `fsync`, мс; долгий sync — признак слабой дисковой подсистемы |
| `buffers_checkpoint` | Буферов записано процессом checkpointer |
| `buffers_clean` | Буферов записано background writer |
| `maxwritten_clean` | Сколько раз bgwriter останавливался, достигнув `bgwriter_lru_maxpages` |
| `buffers_backend` | Буферов записано клиентскими процессами (включая autovacuum). Чем меньше вместе с `maxwritten_clean`, тем лучше работает фоновая запись |
| `buffers_backend_fsync` | Клиенты сами выполняли `fsync`; должно быть 0 |
| `buffers_alloc` | Выделено буферов под новые страницы |
| `stats_reset` | Для сводных отчётов автор советует период 2–4 недели |

Запрос 4.12.

### 4.6. `pg_stat_io` (PostgreSQL 16+, в книге не рассматривается)

Единая накопительная статистика ввода-вывода по типам процессов (`backend_type`), объектам
(`object`: relation, temp relation) и контекстам (`context`: normal, vacuum, bulkread, bulkwrite):
`reads`, `writes`, `writebacks`, `extends`, `hits`, `evictions`, `reuses`, `fsyncs` и их время
(`read_time`, `write_time`, … при `track_io_timing`). Заменяет `buffers_backend` и даёт то,
чего не хватало в `pg_stat_database` (с. 139): статистику записанных блоков.

---

## 5. Журнал упреждающей записи (глава 6)

### 5.1. `pg_stat_wal` (с. 162–163, с 14)

Одна строка, **накопительное**.

| Поле | Описание |
|---|---|
| `wal_records` | Записей отправлено в журнал |
| `wal_fpi` | Полных образов страниц (full page image) после контрольных точек; пилообразный график с периодом `checkpoint_timeout` |
| `wal_bytes` | Объём журнала в байтах |
| `wal_buffers_full` | Сколько раз запись происходила из-за заполнения WAL-буфера; повод пересмотреть `wal_buffers` |
| `wal_write`, `wal_sync` | Операций записи из буфера и синхронизаций сегментов. При `synchronous_commit = off` синхронизации берёт на себя walwriter и их число падает |
| `wal_write_time`, `wal_sync_time` | Время, мс, при `track_wal_io_timing` |
| `stats_reset` | |

В PostgreSQL 18 часть полей перенесена в `pg_stat_io`. Запрос 5.1.

### 5.2. Функции позиций журнала (с. 160)

`pg_current_wal_insert_lsn()` (последняя вставленная запись), `pg_current_wal_lsn()`
(последняя записанная на диск), `pg_current_wal_flush_lsn()`, `pg_walfile_name(lsn)`,
`pg_wal_lsn_diff(a, b)` или оператор `-` для типа `pg_lsn`. Расширение `pg_walinspect` (с 15)
даёт `pg_get_wal_records_info(start, end)` для разбора записей. Запросы 5.2, 5.4.

### 5.3. `pg_stat_archiver` (с. 166–170)

Одна строка, **накопительное** плюс отметки времени.

| Поле | Описание |
|---|---|
| `archived_count`, `last_archived_wal`, `last_archived_time` | Успешно заархивировано сегментов, последний сегмент и время. `now() − last_archived_time` растёт при ошибках и при зависании `archive_command` |
| `failed_count`, `last_failed_wal`, `last_failed_time` | Неудачные попытки; archiver повторяет их до успеха, сегменты копятся на диске |
| `stats_reset` | |

Дополнение: число файлов `*.ready` в `pg_ls_archive_statusdir()` — размер очереди
архивирования, не зависящий от объёма записи (запросы 5.5, 5.6).

---

## 6. Репликация (глава 7)

### 6.1. `pg_stat_replication` (с. 177–180, на основном узле)

**Назначение.** Одна строка на процесс `walsender`, то есть на подключённую реплику или
клиента `pg_basebackup`. **Снимок**, как `pg_stat_activity`. Основной инструмент
отслеживания репликации.

| Группа | Поля | Описание |
|---|---|---|
| Идентификация | `pid`, `usesysid`, `usename`, `application_name`, `client_addr`, `client_hostname`, `client_port`, `backend_start` | Кто и откуда подключился; `application_name` используется в `synchronous_standby_names` |
| Горизонт | `backend_xmin` | Горизонт реплики, переданный через `hot_standby_feedback`; удерживает очистку на основном узле |
| Состояние | `state` | `startup`, `catchup` (догоняет), `streaming` (норма), `backup`, `stopping` |
| Позиции | `sent_lsn`, `write_lsn`, `flush_lsn`, `replay_lsn` | Отправлено; принято walreceiver, но не синхронизировано; синхронизировано; воспроизведено процессом startup |
| Задержки | `write_lag`, `flush_lag`, `replay_lag` | Время между локальной синхронизацией и подтверждением записи / синхронизации / применения на реплике. Определяют задержку `COMMIT` при синхронной репликации |
| Синхронность | `sync_priority`, `sync_state` | `async`, `sync`, `potential` (кандидат по приоритету), `quorum` |
| | `reply_time` | Время последнего служебного ответа реплики |

**Отставание в байтах (с. 178–179):** `pg_current_wal_lsn() − sent_lsn` (не отправлено),
`sent_lsn − write_lsn`, `write_lsn − flush_lsn`, `flush_lsn − replay_lsn`. Какой этап больше,
там узкое место: сеть, диск реплики или её процесс воспроизведения. Запрос 6.1.

### 6.2. `pg_stat_wal_receiver` (с. 181–183, на реплике)

Одна строка о процессе `walreceiver`: `pid`, `status`, `receive_start_lsn`, `receive_start_tli`,
`written_lsn`, `flushed_lsn`, `received_tli`, `last_msg_send_time`, `last_msg_receipt_time`,
`latest_end_lsn`, `latest_end_time`, `slot_name`, `sender_host`, `sender_port`, `conninfo`.
Воспроизведения здесь нет (это процесс startup). В мониторинге почти не используется:
всё есть в `pg_stat_replication` на основном узле.

Функции на реплике: `pg_is_in_recovery()` (роль узла), `pg_last_wal_receive_lsn()`,
`pg_last_wal_replay_lsn()`, `pg_last_xact_replay_timestamp()`. Годятся для выбора кандидата
при аварийном переключении, но не для расчёта отставания (не видят журнал, оставшийся на
основном узле). Запрос 6.2.

### 6.3. `pg_replication_slots` (с. 183–187)

**Назначение.** Одна строка на слот физической или логической репликации. **Снимок.**
Слот гарантирует удержание WAL до передачи потребителю, поэтому за ним нужно следить:
риск исчерпания диска.

| Поле | Описание |
|---|---|
| `slot_name`, `slot_type`, `plugin` | Имя, `physical`/`logical`, плагин декодирования (логические) |
| `datoid`, `database` | База (логические) |
| `temporary` | Временный слот, не сохраняется на диске |
| `active`, `active_pid` | Используется ли слот сейчас и кем. Неактивный слот с растущим отставанием — главный сигнал тревоги |
| `xmin`, `catalog_xmin` | Горизонты очистки, удерживаемые слотом |
| `restart_lsn` | Позиция, с которой журнал ещё нужен потребителю; сегменты от неё не перерабатываются до `max_slot_wal_keep_size` |
| `confirmed_flush_lsn` | Подтверждённая потребителем позиция (логические) |
| `wal_status` (с 13) | `reserved` (в пределах `max_wal_size`), `extended` (больше, но удерживается), `unreserved` (сегменты будут удалены на следующей контрольной точке), `lost` (слот непригоден) |
| `safe_wal_size` (с 13) | Сколько ещё байт можно записать до `lost`; NULL, если ограничение не задано |
| `two_phase` (с 14) | Декодирование подготовленных транзакций |
| `conflicting`, `invalidation_reason` (с 16/17) | Логический слот инвалидирован из-за конфликта |

Ключевые метрики: `pg_current_wal_lsn() − restart_lsn` (или `− confirmed_flush_lsn`),
`wal_status`, `safe_wal_size`, возраст `xmin`. Запрос 6.3.

### 6.4. `pg_stat_replication_slots` (с. 188–189, с 14)

Накопительная статистика **логических** слотов: `spill_txns`, `spill_count`, `spill_bytes`
(вытеснение на диск при нехватке `logical_decoding_work_mem`), `stream_txns`, `stream_count`,
`stream_bytes` (потоковая отправка незавершённых транзакций), `total_txns`, `total_bytes`,
`stats_reset`. Помогает настроить `logical_decoding_work_mem`.

### 6.5. `pg_stat_subscription`, `pg_stat_subscription_stats` (с. 189–190, на подписчике)

| Представление | Поля | Назначение |
|---|---|---|
| `pg_stat_subscription` | `subid`, `subname`, `pid`, `relid` (таблица в начальной синхронизации или NULL), `received_lsn`, `last_msg_send_time`, `last_msg_receipt_time`, `latest_end_lsn`, `latest_end_time` | Состояние подписки и скорость приёма изменений |
| `pg_stat_subscription_stats` (с 15) | `subid`, `subname`, `apply_error_count`, `sync_error_count`, `stats_reset` | Ошибки применения и начальной синхронизации (конфликты уникальности); требуют ручного вмешательства |

### 6.6. `pg_stat_database_conflicts` (с. 190–192, на реплике)

Причины отмены запросов на реплике из-за конфликтов восстановления (общий счётчик в
`pg_stat_database.conflicts`): `confl_tablespace`, `confl_lock`, `confl_snapshot` (самый частый:
очистка на основном узле удалила версии строк, нужные долгому запросу), `confl_bufferpin`,
`confl_deadlock`, `confl_active_logicalslot` (с 16). Меры: `max_standby_streaming_delay`,
`hot_standby_feedback`, отдельная реплика для аналитики. Запрос 6.5.

---

## 7. Очистка и раздувание (глава 8)

### 7.1. Функции `pg_stat_get_*` для таблиц (с. 198–201)

Используются, когда нужно одно значение для oid без обращения к представлению:
`pg_stat_get_live_tuples(oid)`, `pg_stat_get_dead_tuples(oid)`,
`pg_stat_get_vacuum_count(oid)`, `pg_stat_get_autovacuum_count(oid)`,
`pg_stat_get_last_vacuum_time(oid)`, `pg_stat_get_last_autovacuum_time(oid)`,
`pg_stat_get_analyze_count(oid)`, `pg_stat_get_last_analyze_time(oid)`. Запросы 7.1, 7.3.

### 7.2. `pgstattuple` (с. 210–212, расширение)

Точная оценка раздувания: функция читает объект целиком, поэтому дорога и запускается
по требованию. `pgstattuple(relation)` возвращает `table_len`, `tuple_count`, `tuple_len`,
`tuple_percent`, `dead_tuple_count`, `dead_tuple_len`, `dead_tuple_percent`, `free_space`,
`free_percent`. Для индексов `pgstatindex(index)` (`avg_leaf_density`, `leaf_fragmentation`).
Приближённые оценки по каталогу описаны в PostgreSQL Wiki. Запрос 7.7.

### 7.3. `pg_stat_progress_vacuum` (с. 217–219)

Одна строка на выполняющийся процесс очистки. **Снимок.**

| Поле | Описание |
|---|---|
| `pid`, `datid`, `datname`, `relid` | Процесс, база, таблица |
| `phase` | `initializing`, `scanning heap`, `vacuuming indexes` (может повторяться при нехватке памяти), `vacuuming heap`, `cleaning up indexes`, `truncating heap`, `performing final cleanup` |
| `heap_blks_total` | Блоков в таблице на старте |
| `heap_blks_scanned` | Просканировано (пропущенные по карте видимости тоже учитываются) |
| `heap_blks_vacuumed` | Очищено от мёртвых версий; растёт рывками |
| `index_vacuum_count` | Завершённых циклов очистки индексов |
| `max_dead_tuples`, `num_dead_tuples` | Ёмкость рабочей памяти под указатели мёртвых строк и текущее заполнение; при 100 % запускается ещё один цикл по индексам. В 17 заменены на `max_dead_tuple_bytes`, `dead_tuple_bytes`, `num_dead_item_ids` |

Режим очистки (`regular` / `user` / `wraparound`) определяется по тексту
`pg_stat_activity.query`. Запрос 7.9. Для истории очисток надёжнее журнал при
`log_autovacuum_min_duration` (с. 216–217): там есть длительность, IO, WAL и CPU каждой очистки.

---

## 8. Ход выполнения операций: `pg_stat_progress_*` (глава 9)

Все представления — **снимки**, по одной строке на выполняющуюся операцию, общий приём:
соединение с `pg_stat_activity` по `pid`, блоки × `current_setting('block_size')`, проценты.
В мониторинг обычно не собираются.

| Представление | Операция | Ключевые поля | Запрос |
|---|---|---|---|
| `pg_stat_progress_analyze` (с 13) | `ANALYZE` | `phase` (`acquiring sample rows`, `computing statistics`, `computing extended statistics`, …), `sample_blks_total/scanned`, `ext_stats_total/computed`, `child_tables_total/done`, `current_child_table_relid` | 8.1 |
| `pg_stat_progress_basebackup` (с 13) | `pg_basebackup` | `phase` (`waiting for checkpoint to finish`, `estimating backup size`, `streaming database files`, `transferring wal files`, …), `backup_total` (оценка, NULL при `--no-estimate-size`), `backup_streamed`, `tablespaces_total/streamed` | 8.2 |
| `pg_stat_progress_cluster` | `CLUSTER`, `VACUUM FULL` | `command`, `phase` (`seq scanning heap`, `index scanning heap`, `sorting tuples`, `writing new heap`, `swapping relation files`, `rebuilding index`), `cluster_index_relid`, `heap_tuples_scanned/written`, `heap_blks_total/scanned`, `index_rebuild_count` | 8.3 |
| `pg_stat_progress_create_index` | `CREATE INDEX [CONCURRENTLY]`, `REINDEX` | `command`, `phase` (`building index`, `waiting for writers before build/validation`, `index validation: …`, `waiting for old snapshots`, `waiting for readers before marking dead/dropping`), `lockers_total/done`, `current_locker_pid`, `blocks_total/done`, `tuples_total/done`, `partitions_total/done`. Счётчики относятся к текущей фазе | 8.4 |
| `pg_stat_progress_copy` (с 14) | `COPY`, `pg_dump`/`pg_restore` | `command` (`COPY FROM`/`COPY TO`), `type` (`FILE`, `PROGRAM`, `PIPE`, `CALLBACK`), `bytes_processed`, `bytes_total` (только FROM), `tuples_processed`, `tuples_excluded`, `tuples_skipped` (с 17) | 8.5 |

---

## 9. Сводная карта: откуда брать ответ на вопрос

| Вопрос | Представление | Тип | Раздел |
|---|---|---|---|
| Что сейчас делают процессы, на чём ждут | `pg_stat_activity` | снимок | 1.1 |
| Кто кого блокирует, сколько ждут | `pg_locks` + `pg_stat_activity` | снимок | 1.2 |
| TPS, откаты, сеансы, hit ratio, temp-файлы, ошибки по базам | `pg_stat_database` | накопит. | 1.3 |
| Какие запросы самые дорогие (время, IO, CPU, строки, WAL) | `pg_stat_statements` | накопит. | 2.1 |
| За какой период накоплена статистика запросов | `pg_stat_statements_info` | накопит. | 2.2 |
| Какие функции самые дорогие | `pg_stat_user_functions` | накопит. | 2.3 |
| Seq scan, запись, HOT, очистка по таблицам | `pg_stat_user_tables` | накопит. | 3.1 |
| Неиспользуемые индексы | `pg_stat_user_indexes` | накопит. | 3.2 |
| Ввод-вывод по объектам | `pg_statio_user_*` | накопит. | 3.3 |
| Размеры объектов, горизонт заморозки | `pg_class`, `pg_database`, функции размеров | снимок | 3.4 |
| Что в буферном кеше | `pg_buffercache` | снимок | 4.1 |
| Структура общей памяти / памяти процесса | `pg_shmem_allocations`, `pg_backend_memory_contexts` | снимок | 4.2, 4.3 |
| SLRU-кеши | `pg_stat_slru` | накопит. | 4.4 |
| Контрольные точки, фоновая запись | `pg_stat_bgwriter` (`pg_stat_checkpointer`, `pg_stat_io` в новых версиях) | накопит. | 4.5, 4.6 |
| Объём и стоимость WAL | `pg_stat_wal` | накопит. | 5.1 |
| Архивирование и его очередь | `pg_stat_archiver`, `pg_ls_archive_statusdir()` | накопит./снимок | 5.3 |
| Отставание реплик | `pg_stat_replication` | снимок | 6.1 |
| Слоты и удерживаемый WAL | `pg_replication_slots`, `pg_stat_replication_slots` | снимок/накопит. | 6.3, 6.4 |
| Логическая репликация на подписчике | `pg_stat_subscription`, `pg_stat_subscription_stats` | снимок/накопит. | 6.5 |
| Конфликты восстановления на реплике | `pg_stat_database_conflicts` | накопит. | 6.6 |
| Раздувание | `pgstattuple`, `pgstatindex` | по запросу | 7.2 |
| Ход очистки и других длительных операций | `pg_stat_progress_*` | снимок | 7.3, 8 |

## 10. Версии PostgreSQL: когда что появилось

| Версия | Изменения в статистике, упомянутые в книге и важные для инструмента |
|---|---|
| 10 | `pg_stat_activity.backend_type`, события ожидания для фоновых процессов |
| 13 | `pg_stat_slru`, `pg_shmem_allocations`, `pg_stat_progress_analyze`, `pg_stat_progress_basebackup`, планирование и WAL в `pg_stat_statements` 1.8, `wal_status`/`safe_wal_size` в слотах |
| 14 | `pg_locks.waitstart`, `pg_stat_activity.query_id`, `sessions_*` и `*_time` в `pg_stat_database`, `pg_stat_wal`, `pg_stat_statements_info`, `toplevel`, `pg_backend_memory_contexts`, `pg_stat_replication_slots`, `pg_stat_progress_copy` |
| 15 | `temp_blk_read_time`/`temp_blk_write_time` и JIT в `pg_stat_statements` 1.10, `pg_stat_subscription_stats`, `pg_walinspect`, статистика в общей памяти (нет процесса stats collector) |
| 16 | `pg_stat_io`, `last_seq_scan`/`last_idx_scan`, `n_tup_newpage_upd`, `pg_buffercache_summary()` |
| 17 | `pg_stat_checkpointer`, переименование `blk_*_time` в `shared_blk_*_time`, изменения в `pg_stat_progress_vacuum`, `pg_wait_events` |
