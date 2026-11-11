# Браузерные проверки объяснения

`pnpm test:e2e` собирает UI/CLI и запускает четыре спеки, 12 desktop-сценариев на временных фикстурных серверах:

- `guided-story.spec.ts` — описание → блок → файл, полный дифф, чат и локальный повтор.
- `readable-story.spec.ts` — короткие пояснения, примеры и независимая схема потока.
- `story-reading.spec.ts` — место, фокус, выделение, версии, источники и поздние загрузки.
- `story.spec.ts` — совместимость прежних рассказов и чтение без агента.

Обычный прогон использует Chromium Headless Shell без окна и значка в Dock. Установка: `pnpm --filter @sherpa/e2e exec playwright install chromium --only-shell`. Обычно `SHERPA_E2E_EXECUTABLE_PATH` не нужен; для своего бинарника на macOS укажи путь к `chrome-headless-shell`, а не к браузеру из `.app`. `PLAYWRIGHT_BROWSERS_PATH`, если задан, должен совпадать при установке и запуске. Для видимой отладки установи полный Chromium (`pnpm --filter @sherpa/e2e exec playwright install chromium`) и добавь `--headed` без `SHERPA_E2E_EXECUTABLE_PATH`. Трассы и скриншоты идут в Playwright test-results. Старые сценарии комментариев и публикации ревью удалены; серверы реальных PR не используются.
