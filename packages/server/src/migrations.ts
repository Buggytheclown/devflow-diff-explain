/** Миграция схемы: имя фиксировано навсегда, SQL применяется один раз и не переписывается. */
export interface Migration {
    readonly name: string;
    readonly sql: string;
}

/**
 * Миграции применяются по порядку; версия схемы = число применённых миграций
 * и хранится в `meta.schema_version`. Список append-only: применённая миграция не переписывается.
 */
export const MIGRATIONS: readonly Migration[] = [
    {
        name: '001-meta',
        sql: `
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `,
    },
    {
        // Очередь с lease (docs/protocol.md §5). `id` — он же TaskId контракта, в UI и промптах — `sherpa/<id>`.
        name: '002-queue',
        sql: `
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                priority TEXT NOT NULL CHECK (priority IN ('interactive', 'background')),
                instructions TEXT NOT NULL,
                context_files TEXT NOT NULL,
                result_schema_file TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'cancelled')),
                attempt INTEGER NOT NULL CHECK (attempt >= 1),
                worker_id TEXT,
                lease_expires_at TEXT,
                progress_text TEXT,
                result TEXT,
                fail_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX tasks_scheduler ON tasks (status, priority, id);
        `,
    },
    {
        // Воркер PR (docs/protocol.md §7). Ровно одна строка: сервер per-PR, а воркер у PR один;
        // история сессий не нужна, реконнект перезаписывает слот.
        name: '003-worker',
        sql: `
            CREATE TABLE worker (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                worker_id TEXT NOT NULL,
                harness TEXT,
                registered_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );
        `,
    },
    {
        // Имя модели воркера рядом с харнесом: сессия называет его сама, UI показывает в статусе.
        name: '004-worker-model',
        sql: `
            ALTER TABLE worker ADD COLUMN model TEXT;
        `,
    },
    {
        // Прогресс чтения PR (docs/architecture.md §3). БД одна на PR, поэтому ключей по prKey внутри нет.
        // Строка в `file_progress` появляется только после явного действия ревьюера; её отсутствие —
        // состояние по умолчанию, которое трактует UI. `file_seen_ranges` — задел под остановки маршрута:
        // запись диапазонов приедет с ними, чтение работает уже сейчас.
        // Колонки границ — `start_line`/`end_line`: `end` в SQLite ключевое слово.
        name: '005-progress',
        sql: `
            CREATE TABLE file_progress (
                file_id TEXT PRIMARY KEY,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL
            );

            CREATE TABLE file_seen_ranges (
                file_id TEXT NOT NULL,
                side TEXT NOT NULL CHECK (side IN ('old', 'new')),
                start_line INTEGER NOT NULL CHECK (start_line >= 1),
                end_line INTEGER NOT NULL CHECK (end_line >= start_line)
            );

            CREATE INDEX file_seen_ranges_file ON file_seen_ranges (file_id);
        `,
    },
    {
        // Маршрут PR. Ровно одна строка: БД одна на PR, снапшот на тот момент один
        // (версионирование снапшотов приехало миграцией `010`). Снапшот и замыслы стопов лежат JSON-блобами —
        // их форма описана схемами протокола, дублировать её колонками незачем; на входе и
        // выходе они прогоняются через `routeSnapshotSchema` (fail-closed граница).
        // `route_tasks` связывает задачу очереди со стопами, которые она заполняет: по этой
        // связи оркестратор восстанавливает статусы стопов после рестарта и не ставит дубли.
        // `rejections` — отклонения результата в рамках одной аренды: аренду отказ не снимает,
        // но бесконечно править модель не даём (docs/protocol.md §3).
        name: '006-route',
        sql: `
            CREATE TABLE route_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                phase TEXT NOT NULL CHECK (phase IN ('none', 'reading', 'filling', 'ready', 'failed')),
                small_pr INTEGER CHECK (small_pr IN (0, 1)),
                snapshot TEXT,
                failure_message TEXT,
                failure_raw_output TEXT,
                intents TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE route_tasks (
                task_id INTEGER PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('skeleton', 'section')),
                plan_indexes TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            ALTER TABLE tasks ADD COLUMN rejections INTEGER NOT NULL DEFAULT 0;
        `,
    },
    {
        // Прогресс остановок маршрута (docs/architecture.md §7.1). Отметка стопа персистится per PR, а
        // seen-диапазоны, которые она принесла, помечаются её `stop_id`: снятие отметки удаляет
        // ровно диапазоны своего стопа и не трогает ни чужие, ни ручные файловые отметки.
        // `source_stop_id IS NULL` — диапазон не от стопа (писателей таких сейчас нет, но
        // очистка прогресса стопов обязана уметь их отличить).
        name: '007-stop-progress',
        sql: `
            CREATE TABLE stop_progress (
                stop_id TEXT PRIMARY KEY,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL
            );

            ALTER TABLE file_seen_ranges ADD COLUMN source_stop_id TEXT;

            CREATE INDEX file_seen_ranges_stop ON file_seen_ranges (source_stop_id);
        `,
    },
    {
        // Обмены чата и локальные ИИ-заметки. Якоря лежат JSON-блобами: их
        // каноническая форма живёт в `chatAnchorSchema`, на чтении и записи стор валидирует её.
        // `task_id` — текущая попытка обмена; retry заменяет её новой задачей.
        name: '008-chat',
        sql: `
            CREATE TABLE chat_exchanges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question TEXT NOT NULL,
                anchor TEXT,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
                answer TEXT,
                progress_text TEXT,
                error TEXT,
                task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
                head_commit TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX chat_exchanges_task ON chat_exchanges (task_id) WHERE task_id IS NOT NULL;

            CREATE TABLE agent_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exchange_id INTEGER NOT NULL REFERENCES chat_exchanges (id) ON DELETE CASCADE,
                anchor TEXT NOT NULL,
                text TEXT NOT NULL,
                commit_hash TEXT,
                created_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX agent_notes_exchange ON agent_notes (exchange_id);
        `,
    },
    {
        // Попытка растёт и при смерти воркера, и при штатном вытеснении. Причина последнего
        // возврата аренды нужна оркестраторам, чтобы эти случаи не смешивать после рестарта.
        name: '009-task-lease-return-reason',
        sql: `
            ALTER TABLE tasks ADD COLUMN last_lease_return_reason TEXT
                CHECK (last_lease_return_reason IN ('expired', 'displaced'));
        `,
    },
    {
        // Итерации PR и множественность снапшотов (docs/product.md §4a, F3).
        //
        // `iterations` — локально сохранённый патч каждой итерации: после force-push хост её
        // больше не отдаёт, а читать старый снапшот всё равно надо. `interdiffs` — кэш срезов
        // (у Арканума срез считается 2.8–3.7 с, повторно платить за него незачем).
        //
        // Снапшот маршрута переезжает из блоба `route_state.snapshot` в свою таблицу: снапшотов
        // у PR много (по одному на генерацию), а `route_state` держит только id текущего.
        // Существующая строка накопленной БД переезжает данными миграции — маршрут не теряется.
        // `json_valid` в условии: повреждённый блоб (ручная правка БД) обязан остаться
        // «маршрута нет», а не уронить старт сервера на миграции. Раз блоб не переехал, фазу
        // тоже сбрасываем: «ready»/«filling» без снапшота — соврать UI готовым маршрутом.
        name: '010-iterations',
        sql: `
            CREATE TABLE iterations (
                diff_id TEXT PRIMARY KEY,
                base_commit TEXT NOT NULL,
                head_commit TEXT NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'previous', 'gone')),
                diff_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );

            CREATE TABLE interdiffs (
                base_id TEXT NOT NULL,
                head_id TEXT NOT NULL,
                diff_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (base_id, head_id)
            );

            CREATE TABLE route_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                diff_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                previous_snapshot_id TEXT,
                snapshot_json TEXT NOT NULL,
                content_hash TEXT
            );

            CREATE INDEX route_snapshots_created ON route_snapshots (created_at);

            ALTER TABLE route_state ADD COLUMN current_snapshot_id TEXT;

            INSERT INTO route_snapshots (
                snapshot_id, diff_id, created_at, previous_snapshot_id, snapshot_json, content_hash
            )
            SELECT
                json_extract(snapshot, '$.snapshotId'),
                json_extract(snapshot, '$.diffId'),
                json_extract(snapshot, '$.createdAt'),
                json_extract(snapshot, '$.previousSnapshotId'),
                snapshot,
                json_extract(snapshot, '$.contentHash')
            FROM route_state
            WHERE snapshot IS NOT NULL
              AND json_valid(snapshot)
              AND json_extract(snapshot, '$.snapshotId') IS NOT NULL
              AND json_extract(snapshot, '$.diffId') IS NOT NULL
              AND json_extract(snapshot, '$.createdAt') IS NOT NULL;

            UPDATE route_state
               SET current_snapshot_id = (
                   SELECT snapshot_id FROM route_snapshots
                    WHERE snapshot_json = route_state.snapshot
               )
             WHERE snapshot IS NOT NULL;

            UPDATE route_state
               SET phase = 'none'
             WHERE current_snapshot_id IS NULL AND phase IN ('ready', 'filling');

            ALTER TABLE route_state DROP COLUMN snapshot;
        `,
    },
    {
        // Состояние UI этого PR: свёрнутые каталоги и карточки, недавние команды палитры.
        // KV, а не колонки: набор ключей задаёт схема контракта, и новое поле не требует миграции.
        // Колонки prKey нет — база и так per-PR.
        name: '011-ui-pr-state',
        sql: `
            CREATE TABLE ui_pr_state (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
    {
        // Итерация задачи маршрута: приёмщик обязан резолвить якоря против того самого
        // диффа, из которого собран payload задачи, — после рестарта сервера узнать его больше
        // неоткуда. Привязки прежней версии итерации не называют, поэтому стираются: их задачи
        // становятся сиротами, оркестратор их отменяет и ставит генерацию заново.
        name: '012-route-task-iteration',
        sql: `
            ALTER TABLE route_tasks ADD COLUMN diff_id TEXT;

            DELETE FROM route_tasks;
        `,
    },
    {
        // Измерение итерации у прогресса чтения. Файловые отметки и
        // seen-диапазоны ключуются итерацией, отметки остановок — снапшотом: после пуша прогресс
        // прошлой итерации обязан остаться читаемым, а стопы нового снапшота получают свои
        // отметки переносом. `progress_carries` помнит выполненные переносы: пересчёт вернул бы
        // отметку, которую ревьюер уже снял.
        //
        // PK у SQLite не меняется — таблицы пересоздаются с копированием (образец `010`).
        // Строки накопленной БД уезжают на активную итерацию, а её нет — на итерацию текущего
        // снапшота, и уже её нет — на `unknown` (`LEGACY_DIFF_ID`): такой сервер живёт без хоста,
        // и это его единственная «итерация». Отметки остановок без снапшота смысла не имеют
        // и удаляются.
        name: '013-progress-iterations',
        sql: `
            CREATE TABLE file_progress_next (
                diff_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (diff_id, file_id)
            );

            INSERT INTO file_progress_next (diff_id, file_id, viewed, updated_at)
            SELECT COALESCE(
                       (SELECT diff_id FROM iterations WHERE status = 'active' LIMIT 1),
                       (SELECT s.diff_id FROM route_snapshots s
                          JOIN route_state r ON r.current_snapshot_id = s.snapshot_id LIMIT 1),
                       'unknown'
                   ),
                   file_id, viewed, updated_at
              FROM file_progress;

            DROP TABLE file_progress;
            ALTER TABLE file_progress_next RENAME TO file_progress;

            CREATE TABLE file_seen_ranges_next (
                diff_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                side TEXT NOT NULL CHECK (side IN ('old', 'new')),
                start_line INTEGER NOT NULL CHECK (start_line >= 1),
                end_line INTEGER NOT NULL CHECK (end_line >= start_line),
                source_stop_id TEXT,
                carried_from TEXT
            );

            INSERT INTO file_seen_ranges_next (
                diff_id, file_id, side, start_line, end_line, source_stop_id, carried_from
            )
            SELECT COALESCE(
                       (SELECT diff_id FROM iterations WHERE status = 'active' LIMIT 1),
                       (SELECT s.diff_id FROM route_snapshots s
                          JOIN route_state r ON r.current_snapshot_id = s.snapshot_id LIMIT 1),
                       'unknown'
                   ),
                   file_id, side, start_line, end_line, source_stop_id, NULL
              FROM file_seen_ranges;

            DROP TABLE file_seen_ranges;
            ALTER TABLE file_seen_ranges_next RENAME TO file_seen_ranges;

            CREATE INDEX file_seen_ranges_file ON file_seen_ranges (diff_id, file_id);
            CREATE INDEX file_seen_ranges_stop ON file_seen_ranges (source_stop_id);

            CREATE TABLE stop_progress_next (
                snapshot_id TEXT NOT NULL,
                stop_id TEXT NOT NULL,
                viewed INTEGER NOT NULL CHECK (viewed IN (0, 1)),
                updated_at TEXT NOT NULL,
                PRIMARY KEY (snapshot_id, stop_id)
            );

            INSERT INTO stop_progress_next (snapshot_id, stop_id, viewed, updated_at)
            SELECT (SELECT current_snapshot_id FROM route_state), stop_id, viewed, updated_at
              FROM stop_progress
             WHERE (SELECT current_snapshot_id FROM route_state) IS NOT NULL;

            DROP TABLE stop_progress;
            ALTER TABLE stop_progress_next RENAME TO stop_progress;

            CREATE TABLE progress_carries (
                from_diff_id TEXT NOT NULL,
                to_diff_id TEXT NOT NULL,
                carried_at TEXT NOT NULL,
                PRIMARY KEY (from_diff_id, to_diff_id)
            );
        `,
    },
    {
        // Якоря заметок после пуша. `anchor` и `commit_hash` описывают текущее место
        // заметки и переезжают на новую итерацию, поэтому исходное место переносится в свои
        // колонки: `origin` контракта не меняется никогда. `lost_anchor` — пуш переписал сами
        // строки, переносить некуда; заметка уходит из кода и остаётся в чате с пометкой.
        //
        // Номер 013 занят миграцией переноса прогресса.
        name: '014-notes-anchors',
        sql: `
            ALTER TABLE agent_notes ADD COLUMN lost_anchor INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE agent_notes ADD COLUMN origin_anchor TEXT;
            ALTER TABLE agent_notes ADD COLUMN origin_commit TEXT;

            UPDATE agent_notes SET origin_anchor = anchor, origin_commit = commit_hash;
        `,
    },
    {
        // Учёт переноса отметок на снапшот. Заморозка снапшота повторяется при
        // дозаполнении стопа, а «перенесено N из M» суммируется по проходам: без пометки
        // о том, что остановка уже посчитана, второй проход считал бы её заново.
        name: '015-stop-carried',
        sql: `
            ALTER TABLE stop_progress ADD COLUMN carried INTEGER NOT NULL DEFAULT 0;
        `,
    },
    {
        // Путь файла рядом с его `fileId` в записях прогресса. `fileId` у Арканума —
        // непрозрачный id диффсета, и сопоставить записи двух итераций можно только через путь;
        // брался он из сохранённого патча итерации-источника, а у итераций, записанных сервером
        // 0.3.x, патча нет и не будет — перенос молча давал ноль.
        //
        // Бэкфилла нет по той же причине: разрешать старые `fileId` нечем. Их разбирает
        // лестница резолвера в переносе (патч источника, якоря снапшотов и заметок), а новые
        // записи путь несут в себе и от сохранности патча больше не зависят.
        name: '016-progress-paths',
        sql: `
            ALTER TABLE file_seen_ranges ADD COLUMN path TEXT;
            ALTER TABLE file_progress ADD COLUMN path TEXT;
        `,
    },
    {
        // Язык, на котором агент общается с ревьюером: третья метка сессии рядом с харнесом
        // и моделью. Для UI это подсказка в лестнице выбора локали, не приказ.
        name: '017-worker-lang',
        sql: `
            ALTER TABLE worker ADD COLUMN lang TEXT;
        `,
    },
    {
        // Буфер черновиков (docs/architecture.md §6 «драфты не теряются никогда»): текст, который сервер
        // принял, но в хост ещё не довёз. `id` — `clientKey` композера, поэтому повтор той же
        // записи апсёртит строку, а не плодит вторую. `idempotency_key` рождается вместе со
        // строкой и переживает все попытки: хост, уже принявший запись, на повторе с тем же
        // ключом дубля не создаст. `draft_json` — блоб `commentDraftSchema`, как снапшот маршрута:
        // его форму описывает контракт, дублировать её колонками незачем.
        name: '018-draft-buffer',
        sql: `
            CREATE TABLE draft_buffer (
                id TEXT PRIMARY KEY,
                comment_id TEXT,
                draft_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('pending', 'failed')),
                error TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                idempotency_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
    {
        // Черновики, созданные по записям буфера: `id` — тот же `clientKey` композера,
        // пара переживает удаление строки буфера. Без неё повторная запись тем же ключом ушла бы
        // в хост как создание: ключ идемпотентности вернул бы уже созданный комментарий со
        // старым текстом, а новый текст тихо пропал бы (сервер счёл бы запись сохранённой).
        name: '019-draft-buffer-saved',
        sql: `
            CREATE TABLE draft_buffer_saved (
                id TEXT PRIMARY KEY,
                comment_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `,
    },
    {
        // Язык, на котором просили ответить: промпт повтора обязан говорить на языке
        // исходного вопроса, иначе ответ сменил бы язык посреди ленты. NULL — обмен старше колонки,
        // он русский; бэкфилла нет, читатель разбирает NULL как `ru`.
        name: '020-chat-locale',
        sql: `
            ALTER TABLE chat_exchanges ADD COLUMN locale TEXT;
        `,
    },
    {
        // Привязка раунда локального ревью к его задаче `review.feedback`. Сами раунды живут в
        // файле хоста, здесь — только связь с очередью, и она обязана пережить рестарт: иначе
        // сверка поставила бы на тот же раунд вторую задачу. `state` отличает открытую задачу от
        // провалившейся: провал оставляет раунд `pending`, но заново его никто не ставит —
        // иначе петля крутила бы одну и ту же неподъёмную задачу. `locale` — язык, на котором
        // задача просила отвечать: по нему же проверяется сданный результат, поэтому смена
        // настроек между постановкой и сдачей на проверку влиять не должна.
        name: '021-feedback-tasks',
        sql: `
            CREATE TABLE feedback_tasks (
                round_id TEXT PRIMARY KEY,
                task_id INTEGER NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('open', 'done', 'failed')),
                locale TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `,
    },
    {
        name: '022-chat-explanation',
        sql: `ALTER TABLE chat_exchanges ADD COLUMN explanation TEXT;`,
    },
];

/** Ключ версии схемы в таблице `meta`. */
export const SCHEMA_VERSION_KEY = 'schema_version';
