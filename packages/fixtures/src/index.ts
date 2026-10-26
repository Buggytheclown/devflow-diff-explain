/**
 * Фикстурный хост-адаптер: детерминированные PR для UI, галереи состояний и тестов.
 * Сервер выбирает его по prKey вида `fixture-<name>` (см. `hosts/select.ts`) — дев и e2e.
 */
export { FixtureHost, makeFixtureHost } from './fixture-host.js';
export type { FixtureHostOptions } from './fixture-host.js';
export {
    FIXTURE_NAMES,
    fixtureData,
    fixtureInterdiff,
    fixtureIteration,
    HUGE_CHANGED_LINE_COUNT,
    HUGE_COLLAPSED_FILE_LINES,
    HUGE_COLLAPSED_FILE_PATH,
    HUGE_DIFF_ID,
    HUGE_FILE_COUNT,
    HUGE_PARSED_FILE_COUNT,
    HUGE_PARSED_LINE_COUNT,
    LARGE_FILE_COUNT,
    LONG_LINE_FILE_PATH,
    LONG_LINE_MARKER,
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    MEDIUM_HEAD_COMMIT_V3,
    MEDIUM_TOTALS,
} from './data/index.js';
/** Чат и локальные ИИ-заметки: история для галереи без сервера. */
export { chatFixtures } from './data/index.js';
export type { ChatFixtures } from './data/index.js';
/** Маршрут: состояния генерации для галереи и заготовленные выводы модели для e2e. */
export { routeFixtures } from './data/index.js';
/**
 * Конструкторы доменных объектов: наборы тредов, которых нет в готовых фикстурах, галерея
 * и тесты собирают ими (масштаб §1e — 86 тредов от 85 ботов).
 */
export { anchor, bot, comment, human, lens, singleIteration, thread } from './builders.js';
export type { CommentSpec, LensSpec, ThreadSpec } from './builders.js';
/** Фото людей для галереи: офлайн-data-URI и заведомо битый URL для отката на инициалы. */
export { GALLERY_AVATAR_BROKEN, GALLERY_AVATAR_PHOTOS, withAvatar, withAvatars } from './avatars.js';
export type { RouteBrokenResults, RouteFixtures, RouteRawResults, RouteRawResultsEn } from './data/index.js';
/** Картинка вне состава `medium`: галерее нужна вторая сторона другого размера. */
export { PNG_SMALL_BASE64 } from './data/images.js';
/** Текст файла по обе стороны: галерее состояний он нужен без сервера и без хоста. */
export { fileContentOf } from './file-content.js';
export type { FixtureData, FixtureInterdiff, FixtureIteration, FixtureIterationView, FixtureName } from './data/index.js';
export { guidedStoryFixture } from './guided-story.js';
export { readableStoryFixture } from './readable-story.js';
