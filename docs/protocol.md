# Протокол сессия ↔ сервер

## 1. Граница ответственности

Агент работает в собственном харнесе, исследует PR/локальные изменения нативными инструментами и передаёт готовые байты. Приложение хранит снимки, проверяет связи архитектуры, блоков и всех файлов, показывает сохранённый код и ставит задачи по явным вопросам. Приложение не имеет PR/VCS-адаптеров, provider credentials и автоматического polling.

Канон — Zod в `packages/protocol`; модельный ввод, HTTP и сохранённые данные валидируются на границах. Payload-файлы доступны из локальной файловой системы; наличие пути не означает обязательного чтения моделью.

## 2. Топология

Сессия ↔ standalone CLI ↔ локальный HTTP/SSE сервер ↔ SQLite и браузер. Сервер сам LLM не вызывает. Пять файлов поставки: SKILL.md, agents/openai.yaml, version.json, CLI и сервер со встроенным UI. Состояние остаётся в `~/.sherpa`, SHERPA_DIR переопределяет корень.

## 3. CLI

```sh
devflow-diff-explain snapshot schema
devflow-diff-explain sources schema
devflow-diff-explain up --snapshot /absolute/export/snapshot.json --harness codex --model <model> --lang ru
devflow-diff-explain up --pr <saved-project>
devflow-diff-explain snapshot import --pr <project> --file /absolute/export/snapshot.json
devflow-diff-explain sources import --pr <project> --file /absolute/export/sources.json
devflow-diff-explain worker next --pr <project>
devflow-diff-explain task complete <id> --file <result> [--next] --pr <project>
devflow-diff-explain task progress <id> --text <status> --pr <project>
devflow-diff-explain task fail <id> --reason <reason> --pr <project>
```

`up --snapshot` получает project из manifest, импортирует данные до регистрации worker и печатает ссылку с fragment-токеном. `--pr` обозначает сохранённый проект, не запускает чтение провайдера; --local/--base сообщают о переходе на импорт. Snapshot/sources import работают с запущенным сервером и не регистрируют новую модель. --no-open оставляет только ссылку. Worker next ждёт задачу; complete --next после сдачи продолжает ожидание. DONE и «stop the loop» завершают петлю.

## 4. Импорт кода

`code-snapshot/1`: project (локальный ключ из букв, цифр, точки, дефиса и подчёркивания), diffId, baseCommit/headCommit, capturedAt, pr (необязательные известные title/url/id/author/branches/state/updatedAt или null, без review-возможностей), полный files и дополнительные sources. Файл: path, changeType, oldPath, before/after (null только для отсутствующей стороны), patch (путь полного оригинала либо null для генерации), optional fileId/generated/hostFileUrl. Артефакт: относительный file, kind text/binary/symlink/gitlink и известный mode. Gitlink сохраняет объект, symlink — байты цели без разыменования. Все изменённые файлы и существующие стороны обязательны; усечённого ready-снимка нет.

`code-sources/1`: project, codeSnapshotId, sources с path/revision/artifact. Ревизия — pinned base/head. У внешнего документа origin сохраняет URL, время, scope и известную исходную revision; байты сохраняются локальным артефактом в контексте этой версии кода. Источники дополняются, конфликтующие байты не перезаписываются.

Importer проверяет точные координаты строк патча, пути, отсутствие symlink escape, инвентарь и воспроизведение new из old+patch; hashes/sizes считает приложение. Временные файлы агента копируются в собственное хранилище приложения. codeSnapshotId отделён от snapshotId объяснения; diffId внутри проекта не может обозначить другие ревизии или байты. Полнота upstream PR и истинность ревизий относительно провайдера не могут независимо доказываться без запроса провайдера: агент экспортирует полный нативный инвентарь. Новая версия импортируется явно; activate:false и старый capturedAt не переключают активную версию.

HTTP получает только `{manifest: "/absolute/path/manifest.json"}`, сами байты идут из файлов вне лимита model result:

| Ручка | Результат |
|---|---|
| POST /api/snapshot/import | codeSnapshotId, diffId, число файлов/источников |
| POST /api/sources/import | тот же кодовый снимок с дополнительными источниками |
| GET /api/snapshot/raw?diffId=&fileId=&side=old\|new | полный оригинал стороны файла |
| GET /api/review/source?id= | сохранённый диапазон, hash, pinned revision, признак полного исходника |
| GET /api/snapshot/source?id= | полный импортированный источник, на который указывает диапазон |

Все ручки требуют локальный bearer. Ошибка до атомарной регистрации оставляет прежний читаемый снимок. Оригиналы не урезаются из-за preview или 256 КиБ результата. Чтение, restart и удаление экспортного каталога не требуют модели, сети или VCS. Отсутствующий материал даёт адресную недоступность без fallback и без новой задачи.

## 5. Задачи и результат

Task содержит id/type/priority/attempt, instructions, contextFiles и при необходимости resultSchemaFile. Контекст map именует версии и размеры; target ведёт к отдельным полным патчам/исходникам. Контекст с неизменными байтами имеет стабильный путь по хэшу, новый snapshotId объяснения сам по себе не требует перечитывания. Выданный путь результата и команда complete обязательны для передачи ответа приложению.

Единственный текущий JSON-ввод подготовки: contractVersion:6 и overview, update, files. Первому checkpoint нужен overview: summary/evidence, flow и stops с архитектурными nodeIds, основными files и relatedFiles. Он может одновременно содержать пояснения всех файлов. Update меняет предметные поля; blocks редактирует блоки по ID, removeBlocks/blockOrder перегруппировывают. Каждый изменённый файл имеет одного основного владельца, затронутые узлы связаны с блоками. Связанные изменения проверяются атомарно; независимый файл принимается целиком. Файлы сдаются плоским массивом по путям, в любом порядке и любой полезной частью; annotations/example при отсутствии сохраняются. Evidence на входе — sources и optional limitation; внутренние claims модель не формирует.

Невалидный envelope/граф/владелец отклоняет структурный результат. Ошибка одного файла не мешает другим; partial-квитанция содержит сохранённые пути и необходимые исправления. Пустая фиктивная правка summary для files-only не создаётся. Повтор схемы — route.prepare с требованием flow, с тем же валидатором и сохранением готовых файлов.

Чат возвращает непустой Markdown. Для кода: `[label](#code?path=URL_ENCODED_PATH&side=new&start=9&end=9)`; диапазон вне патча разрешается из импортированного полного источника. Приложение заменяет его стабильной `#source?id=<hash>` ссылкой. Недостающий источник импортируется агентом перед сдачей; приложение не читает его в провайдере. Ответ не принимается с недостоверной ссылкой. Явный вопрос закрепляет версию, вложение, показанное объяснение и историю; retry не подменяет материалы новым импортом.

## 6. Очередь и восстановление

route.prepare — background, chat — interactive. Приоритет действует между арендами/checkpoint; приложение не прерывает выполняющийся процесс харнеса. Worker next арендует одну задачу. Worker-регистрация передаёт слот новой сессии; аренда прежнего владельца возвращается в очередь. TTL и пределы попыток задаются константами protocol. Необратимые статусы — done/failed/cancelled; поздний ответ отменённой задачи не применяется. Результат ограничен 256 КиБ UTF-8; артефакты импортируются отдельно.

Документ/ответ, done, привязки и квитанция записываются в общей SQLite-транзакции. Retry возвращает квитанцию без повторного применения. Вложенное исключение отменяет общую запись, даже если перехвачено внешним кодом. После commit публикуются память и уведомления; сбой одного listener не отменяет запись и не подавляет остальные. Доменные ошибки-значения сохраняют необходимые счётчики. Незавершённые задачи и budget исправлений переживают restart.

Подготовка учитывает N=2+B+F единиц: описание, архитектура, блоки и файлы. До принятого обзора знаменатель неизвестен. Сохранённый результат читается при ошибке/отмене новой подготовки; готовность относится к текущей подготовке. Ошибка Mermaid допускает повтор обычным checkpoint. Настройки генерации отделены от фиксированного русского Arcanum dark UI; первый рендер не ждёт GET settings.

## 7. Живость и безопасность

Long-poll поддерживает живость worker; CLI продолжает idle-ожидание самостоятельно. Молчание с арендой и уход UI учитываются отдельно. Уход последнего SSE-клиента дольше grace позволяет завершить петлю после закрытия работы. Остановка закрывает ожидающие соединения/подписки до БД.

Discovery manifest содержит prKey/PID/port/token/versions, создаётся атомарно; живой сервер повторно используется. API требует bearer, только SSE принимает token в query. Fragment-токен показывается пользователю, не публикуется в сторонних системах. Сервер по умолчанию слушает loopback. Provider credentials приложение не ищет и не использует.

## 8. Совместимость

Protocol 0.26, эпоха задания 8. В 0.x несовпадение minor несовместимо; worker/server/UI обновляются согласованно. Новая сессия не принимает bare overview/flow, legacy stops или внутренние claims. Старые rows отменённых/завершённых типов остаются читаемыми, но их исполнители не возвращаются. Старые объяснения v2–v6 и explanation/1 читаются без перегенерации. Текущий runtime не дописывает им фиктивные review-поля.

Исторические migrations, таблицы и пользовательские байты не удаляются. Прежний неполный кэш не объявляется полным: доступны уже сохранённые материалы, явный импорт той же версии проверяет прежние ревизии/инвентарь и сохраняет ID/patch для существующих ссылок. Новый импорт не переписывает прежние вопросы. Canonical blobs не зависят от GC временного payload.

## 9. HTTP приложения

Таблица UI/worker ниже генерируется `node scripts/protocol-endpoints.mjs --write`. Echo enqueue и fixture advance доступны только dev. Импортные ручки перечислены выше; production не содержит fixture-провайдера.


<!-- endpoints:start -->
### UI-ручки

| Ключ | Метод и путь | Назначение |
|---|---|---|
| `state` | `GET /api/ui/state` | снимок состояния PR для первой отрисовки |
| `enqueue` | `POST /api/ui/tasks` | постановка задачи из UI (только `echo`, дев-демо петли) |
| `cancel` | `POST /api/ui/tasks/cancel` | снятие поставленной задачи |
| `events` | `GET /api/ui/events` | SSE-поток: состояние очереди, ревизии объяснения и чата |
| `reviewDiff` | `GET /api/ui/review/diff` | дифф итерации PR |
| `reviewFileContent` | `GET /api/ui/review/file-content` | содержимое файла для разворота контекста |
| `reviewBlob` | `GET /api/ui/review/blob` | байты картинки по `blobId` |
| `reviewRoute` | `GET /api/ui/review/route` | маршрут снапшота |
| `reviewSnapshots` | `GET /api/ui/review/snapshots` | список снапшотов маршрута |
| `reviewRouteGenerate` | `POST /api/ui/review/route/generate` | запуск и перезапуск генерации маршрута |
| `reviewRouteFillStop` | `POST /api/ui/review/route/fill-stop` | перезаполнение одной остановки |
| `reviewRouteRetryDiagram` | `POST /api/ui/review/route/retry-diagram` | локальный повтор схемы текущего разбора |
| `reviewRouteCancelGeneration` | `POST /api/ui/review/route/cancel-generation` | остановка подготовки с сохранением готовых материалов |
| `reviewChat` | `GET /api/ui/review/chat` | история вопросов и ответов |
| `reviewChatAsk` | `POST /api/ui/review/chat/ask` | вопрос агенту |
| `reviewChatCancel` | `POST /api/ui/review/chat/cancel` | отмена заданного вопроса |
| `reviewChatRetry` | `POST /api/ui/review/chat/retry` | повтор провалившегося вопроса |
| `settings` | `GET, PATCH /api/ui/settings` | настройки ревьюера: чтение и правка |

### Воркерские ручки

| Ключ | Метод и путь | Назначение |
|---|---|---|
| `register` | `POST /api/worker/register` | регистрация сессии воркером PR |
| `next` | `POST /api/worker/next` | long-poll за следующей задачей |
| `complete` | `POST /api/task/complete` | сдача результата задачи |
| `progress` | `POST /api/task/progress` | статусная отметка по задаче |
| `fail` | `POST /api/task/fail` | отказ от задачи с причиной |
<!-- endpoints:end -->

Пустые sources/limitation у явно описанных узлов схемы и пустые relatedFiles блока можно опустить: приложение подставляет пустые значения и наследует доказательства связанных блоков. Явный unknown по-прежнему требует содержательной оговорки; added/modified — подтверждения изменёнными строками.
