import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import type { RoutePreset, SessionStore, StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import type { ThreadStore } from '../../threads/store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-workspace.tsx';
import { createT } from '../../i18n/index.js';
import { TOUR_HINT, TRIAGE_HINT } from './route-toolbar.tsx';
import { DIGEST_NOTE, UNCOVERED_NOTE } from './test-digest.tsx';

const t = createT('ru');

/**
 * Компонентные тесты вью маршрута — статическая разметка на фикстуре (тот же приём, что
 * у панели действий). Проверяется то, что видит ревьюер: порядок остановок, свёртки,
 * копирайт «Прочего» и эджи docs/design/SPEC-elements.md §2.9.
 */

const DATA = fixtureIteration('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;
if (READY?.snapshot == null) {
    throw new Error('фикстуре medium нужен готовый снапшот маршрута');
}
const SNAPSHOT: RouteSnapshot = READY.snapshot;
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const ORDER_FILE = DATA.diff.files.find((file) => file.path === 'services/orders/src/domain/order.ts');
const GENERATED_FILE = DATA.diff.files.find((file) => file.path === 'pnpm-lock.yaml');
if (ORDER_FILE === undefined || GENERATED_FILE === undefined) {
    throw new Error('фикстуре medium нужны order.ts и pnpm-lock.yaml');
}

function render(
    options: {
        snapshot?: RouteSnapshot;
        filter?: string;
        preset?: RoutePreset;
        stops?: StopsState;
        stopViewed?: readonly string[];
        keptStopId?: string;
        /** Общая сессия и общий стор тредов: так проверяется, что переживает смену пресета. */
        session?: SessionStore;
        threadStore?: ThreadStore;
        /** `false` — модели диффа ещё не разобраны: вью в состоянии «числа не окончательные». */
        parsed?: boolean;
        /** Глобальный диффмод (docs/design/SPEC-elements.md §2.6): действует и на карточки маршрута. */
        mode?: 'unified' | 'split';
        progress?: readonly UiFileProgress[];
        collapsed?: ReadonlyMap<string, boolean>;
        onSetStopViewed?: (stopId: string, viewed: boolean) => Promise<number>;
        onFillStop?: (planIndex: number) => void;
        /** Вкладка смотрит прошлую итерацию: записи из маршрута недоступны. */
        readOnly?: boolean;
        /** Файлы, пришедшие из хоста конфликтными (docs/design/SPEC-elements.md §4.1): они вне покрытия маршрута. */
        conflicts?: readonly string[];
    } = {},
): string {
    const conflicts = new Set(options.conflicts ?? []);
    const files = DATA.diff.files.map((file) =>
        conflicts.has(file.fileId) ? { ...file, changeType: 'conflict' as const } : file,
    );
    const store = createDiffViewStore({
        files,
        ...(options.progress === undefined ? {} : { progress: options.progress }),
        ...(options.collapsed === undefined ? {} : { collapsed: options.collapsed }),
    });
    if (options.mode !== undefined) {
        store.setDiffMode(options.mode);
    }
    if (options.parsed !== false) {
        for (const file of files) {
            store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
    }
    return renderToStaticMarkup(
        <ReadOnlyIterationProvider readOnly={options.readOnly ?? false}>
        <RouteWorkspace
            pr={DATA.pr}
            diff={{ ...DATA.diff, files }}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            snapshot={options.snapshot ?? SNAPSHOT}
            session={
                options.session ??
                createSessionStore({
                    initial: {
                        view: 'route',
                        filter: options.filter ?? 'all',
                        stops: options.stops ?? EMPTY_STOPS,
                        ...(options.preset === undefined ? {} : { preset: options.preset }),
                    },
                })
            }
            store={store}
            threadStore={options.threadStore ?? createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            {...(options.keptStopId === undefined ? {} : { initialKeptStopId: options.keptStopId })}
            {...(options.stopViewed === undefined ? {} : { initialStopViewed: options.stopViewed })}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={options.onSetStopViewed ?? (() => Promise.resolve(0))}
            onSetStopFileViewed={() => Promise.resolve(0)}
            {...(options.onFillStop === undefined ? {} : { onFillStop: options.onFillStop })}
        />
        </ReadOnlyIterationProvider>,
    );
}

/**
 * Подсказки путей именно из чипов файлов: тот же путь лежит в тултипе карточки файла справа,
 * поэтому поиск по одной подстроке `title="…"` проверял бы чужой элемент.
 */
function chipPathTitles(html: string): string[] {
    return [...html.matchAll(/<span\b[^>]*\bclass="route-chip__path"[^>]*>/g)]
        .map((tag) => /\btitle="([^"]*)"/.exec(tag[0])?.[1])
        .filter((title): title is string => title !== undefined);
}

/** Порядок остановок в разметке — по атрибуту `data-stop`. */
function order(html: string): string[] {
    return [...html.matchAll(/data-stop="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function withStops(patch: (snapshot: RouteSnapshot) => RouteSnapshot['stops']): RouteSnapshot {
    return { ...SNAPSHOT, stops: patch(SNAPSHOT) };
}

/** Якоря утверждений дайджеста ведут в s01, а файлы самой s04 остаются прежними. */
function digestOutsideStopSnapshot(): RouteSnapshot {
    const target = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (target === undefined) {
        throw new Error('у остановки s01 нужен якорь для производного снапшота');
    }
    return withStops((snapshot) =>
        snapshot.stops.map((stop) =>
            stop.id !== 's04'
                ? stop
                : {
                      ...stop,
                      tests: stop.tests.map((claim) =>
                          claim.kind === 'uncovered'
                              ? claim
                              : {
                                    ...claim,
                                    anchor: { fileId: target.fileId, path: target.path, line: target.start },
                                },
                      ),
                  },
        ),
    );
}

describe('вью маршрута', () => {
    it('рисует остановки в триаж-порядке с план-фиксированными номерами и «Прочим» в конце', () => {
        const html = render();

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 'other']);
        expect(html).toContain('01 / 7');
        expect(html).toContain('07 / 7');
        expect(html).toContain('Прочее — модель не разместила эти строки');
        expect(html).toContain('Открыть 38 строк');
    });

    it('цель шага 02 тура достаётся первой отрисованной свёртке, а не первой low-остановке', () => {
        expect(render()).toContain('data-tour="fold-s05"');

        // Первая low-остановка ещё не заполнена: на её месте скелет, и обводить в ней нечего.
        const queued = render({
            snapshot: {
                ...SNAPSHOT,
                stops: SNAPSHOT.stops.map((stop) =>
                    stop.id === 's05' ? { ...stop, status: 'queued' as const } : stop,
                ),
            },
        });

        expect(queued).not.toContain('data-tour="fold-s05"');
        expect(queued).toContain('data-tour="fold-s06"');
    });

    it('переключатель пресета показывает активную опцию и её подсказку', () => {
        const triage = render();
        const tour = render({ preset: 'tour' });

        expect(triage).toContain(t(TRIAGE_HINT));
        expect(triage).not.toContain(t(TOUR_HINT));
        expect(triage).toContain('aria-pressed="true">Триаж</button>');
        expect(triage).toContain('aria-pressed="false">Полный тур</button>');
        expect(tour).toContain(t(TOUR_HINT));
        expect(tour).not.toContain(t(TRIAGE_HINT));
        expect(tour).toContain('aria-pressed="true">Полный тур</button>');
    });

    it('полный тур ставит остановки по tourOrder, а номера остаются план-фиксированными', () => {
        const html = render({ preset: 'tour' });

        expect(order(html)).toEqual([...SNAPSHOT.tourOrder]);
        expect(order(html)).not.toEqual(order(render()));
        // Первой едет остановка 03 — со своим номером, а не с «01».
        expect(section(html, 's03')).toContain('03 / 7');
        expect(section(html, 's01')).toContain('01 / 7');
        expect(section(html, 'other')).toContain('07 / 7');
    });

    it('кривой tourOrder не роняет вью: чужие id пропущены, забытые остановки — в хвост', () => {
        const html = render({
            preset: 'tour',
            snapshot: { ...SNAPSHOT, tourOrder: ['s04', 'нет-такого-стопа', 's01'] },
        });

        expect(order(html)).toEqual(['s04', 's01', 's02', 's03', 's05', 's06', 'other']);
        expect(html).toContain('просмотрено 0 из 7 остановок');
    });

    it('переключение пресета не трогает отметки, фильтр и развёртки', () => {
        const session = createSessionStore({
            initial: {
                view: 'route',
                filter: 'pci',
                stops: { ...EMPTY_STOPS, expanded: new Set(['s05']), collapsed: new Set(['s02']) },
            },
        });
        const triage = render({ session, stopViewed: ['s03'] });
        session.setPreset('tour');
        const tour = render({ session, stopViewed: ['s03'] });

        expect(session.getSnapshot().filter).toBe('pci');
        expect(session.getSnapshot().stops.expanded.has('s05')).toBe(true);
        expect(session.getSnapshot().stops.collapsed.has('s02')).toBe(true);
        // Фильтр действует в обоих пресетах на один и тот же набор остановок.
        expect([...order(tour)].sort()).toEqual([...order(triage)].sort());
        for (const html of [triage, tour]) {
            expect(section(html, 's03')).toContain('>Просмотрено</button>');
        }
    });

    it('черновик комментария переживает перестановку: он живёт в сторе, а не в карточке', () => {
        const threadStore = createThreadStore(DATA.threads, FILE_IDS);
        const anchor = SNAPSHOT.stops[0]?.anchors[0];
        if (anchor === undefined) {
            throw new Error('у первой остановки фикстуры должен быть якорь');
        }
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        threadStore.openComposer({
            key: `new:${anchor.fileId}:${anchor.side}:${String(anchor.start)}`,
            threadId: null,
            parentId: null,
            anchor: {
                fileId: anchor.fileId,
                path: anchor.path,
                position: { side: anchor.side, line: anchor.start, size: 1 },
            },
            text: 'черновик переживает перестановку',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const triage = render({ session, threadStore });
        session.setPreset('tour');
        const tour = render({ session, threadStore });

        expect(triage).toContain('черновик переживает перестановку');
        expect(tour).toContain('черновик переживает перестановку');
        expect(order(tour)).toEqual([...SNAPSHOT.tourOrder]);
    });

    it('шапка несёт индикатор снапшота с коротким коммитом и статусом', () => {
        const html = render();

        // Без пикера из App workspace рисует свой снапшот как текущий.
        expect(html).toContain(`снапшот ${SNAPSHOT.commit.slice(0, 7)} · текущий`);
    });

    it('high-остановка получает бейдж и роль региона с номером', () => {
        const html = render();

        expect(html).toContain('aria-label="Остановка 01 из 7 — Окно редактирования стало доменным понятием"');
        expect(html).toContain('>high<');
    });

    it('бэктики модели — моно-стиль в тексте и голый текст в атрибутах', () => {
        const html = render();
        const head = section(html, 's02').slice(0, section(html, 's02').indexOf('route-stop__diff'));

        // Заголовок и абзац остановки: код в бэктиках стал элементом, бэктиков на экране нет.
        expect(head).toContain('<code class="md-code">EditWindow</code>');
        expect(head).not.toContain('`');
        // Тот же заголовок в озвучке региона — без разметки вовсе.
        expect(html).toContain('aria-label="Остановка 02 из 7 — Политика решает по EditWindow, а не по часам"');
        // Утверждение дайджеста — тот же профиль.
        expect(section(html, 's04')).toContain('<code class="md-code">dispatch</code>');
    });

    it('low-остановки свёрнуты дашед-карточкой, раскрытая — нет', () => {
        const collapsed = render();
        const expanded = render({ stops: { ...EMPTY_STOPS, expanded: new Set(['s05']) } });

        expect(collapsed).toContain('низкая важность');
        expect(collapsed).toContain('ничего не спрятано — нажмите, чтобы раскрыть');
        // У раскрытой остановки остаётся только свёртка соседнего low-стопа.
        expect(count(collapsed, 'низкая важность')).toBe(2);
        expect(count(expanded, 'низкая важность')).toBe(1);
    });

    it('просмотренная остановка гаснет и схлопывается в строку-сводку', () => {
        const html = render({ stopViewed: ['s01'] });

        expect(html).toContain('route-stop--high is-viewed');
        expect(html).toContain('· просмотрено');
        expect(html).toContain('>Просмотрено</button>');
    });

    it('дрейф якорей даёт нотис вместо пустоты', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) =>
                    stop.id === 's01'
                        ? { ...stop, anchors: stop.anchors.map((anchor) => ({ ...anchor, fileId: 'ушёл' })) }
                        : stop,
                ),
            ),
        });

        expect(html).toContain('Эта остановка указывала на строки, которых в диффе больше нет.');
    });

    it('якоря ушли в конфликтный файл — нотис про конфликт, а не про дрейф (docs/design/SPEC-elements.md §4.1)', () => {
        const target = SNAPSHOT.stops.find((stop) => stop.id === 's01');
        if (target === undefined) {
            throw new Error('фикстуре нужен стоп s01');
        }
        const html = render({ conflicts: target.anchors.map((anchor) => anchor.fileId) });
        const stop = section(html, 's01');

        expect(stop).toContain('route-conflicts');
        expect(stop).toContain('в конфликте: разрешить их можно только вне Шерпы');
        expect(stop).not.toContain('которых в диффе больше нет');
        // Пути якорей названы: ревьюер должен знать, что именно разрешать.
        expect(stop).toContain(target.anchors[0]?.path ?? '');
    });

    it('часть якорей уехала — нотис встаёт над уцелевшими карточками', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) =>
                    stop.id === 's03'
                        ? {
                              ...stop,
                              anchors: stop.anchors.map((anchor, index) =>
                                  index === 0 ? { ...anchor, fileId: 'ушёл' } : anchor,
                              ),
                          }
                        : stop,
                ),
            ),
        });
        const stop = section(html, 's03');

        expect(stop).toContain('Часть якорей этой остановки указывала на строки, которых в диффе больше нет.');
        // Уцелевшие файлы остановки при этом продолжают рисоваться.
        expect(stop).toContain('file-card');
    });

    it('«Прочее» под фильтром обещает ровно то, что раскроет', () => {
        const all = render();
        const filtered = render({ filter: 'pci' });

        expect(all).toContain('Открыть 38 строк');
        expect(filtered).toContain('Открыть 15 строк');
        expect(filtered).not.toContain('Открыть 38 строк');
    });

    it('«Прочее», удержанное фильтром на экране, показывает всё своё непокрытое', () => {
        const html = render({ filter: 'pci', keptStopId: 'other' });

        expect(html).toContain('Открыть 38 строк');
        expect(section(html, 'other')).toContain('оставлена на экране — вне текущего фильтра');
    });

    it('незаполненная остановка даёт дозаполнение только когда оно доступно', () => {
        const snapshot = withStops((stops) =>
            stops.stops.map((stop) =>
                stop.id === 's01' ? { ...stop, status: 'failed', paragraph: null, bridge: null } : stop,
            ),
        );
        const fillingSnapshot = {
            ...snapshot,
            stops: snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, status: 'queued' as const } : stop)),
        };
        const available = section(render({ snapshot, onFillStop: () => undefined }), 's01');
        const unavailable = section(render({ snapshot }), 's01');
        const whileFilling = section(render({ snapshot: fillingSnapshot, onFillStop: () => undefined }), 's01');

        expect(available).toContain('Не заполнена — агент остановился раньше');
        expect(available).toContain('route-stop__regenerate">Дозаполнить</button>');
        expect(unavailable).not.toContain('route-stop__regenerate');
        expect(whileFilling).not.toContain('route-stop__regenerate');

        // Дозаполнение пишет в снапшот вкладки: в прошлой итерации кнопка видна, но выключена.
        const reading = section(render({ snapshot, onFillStop: () => undefined, readOnly: true }), 's01');
        expect(reading).toMatch(
            /<button [^>]*class="[^"]*route-stop__regenerate"[^>]*disabled=""[^>]*>Дозаполнить<\/button>/,
        );
        expect(reading).toContain('только в активной итерации');
    });

    it('пометка валидатора живёт только у незаполненной остановки', () => {
        const note = 'Остановка осталась незаполненной: агент не назвал причину';
        const failed = withStops((snapshot) =>
            snapshot.stops.map((stop) =>
                stop.id === 's01'
                    ? {
                          ...stop,
                          status: 'failed' as const,
                          paragraph: null,
                          bridge: null,
                          validationNotes: [note],
                      }
                    : stop,
            ),
        );
        const ready = withStops((snapshot) =>
            snapshot.stops.map((stop) => (stop.id === 's01' ? { ...stop, validationNotes: [note] } : stop)),
        );

        // У пустого слота пометка — единственное объяснение; у заполненного место дороже.
        expect(section(render({ snapshot: failed }), 's01')).toContain(note);
        expect(section(render({ snapshot: ready }), 's01')).not.toContain(note);
    });

    it('остановка без якорей показывает дашед-карточку, а не пустоту', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, anchors: [] } : stop)),
            ),
        });

        expect(html).toContain('Ханков нет: заполнение не разметило ни одного диапазона.');
    });

    it('«Прочее» поднимается над low-стопами, когда непокрыто больше 40%', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) =>
                    stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
                ),
            ),
        });

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 'other', 's05', 's06']);
    });

    it('фильтр прячет остановки без своих файлов и держит на экране ту, что читали', () => {
        const html = render({ filter: 'pci', keptStopId: 's01' });

        expect(order(html)).toEqual(['s01', 's03', 'other']);
        expect(html).toContain('оставлена на экране — вне текущего фильтра');
    });

    it('тулбар несёт полосу покрытия с числами фикстуры и счётчиком остановок', () => {
        const html = render();

        expect(html).toContain('866 изменённых строк');
        expect(html).toContain('95% объяснено');
        expect(html).toContain('38 строк не объяснено');
        expect(html).toContain('high · остановки 01–02 · 196 строк');
        expect(html).toContain('просмотрено 0 из 7 остановок');
        // Нулевых тиров у фикстуры нет: сегментов ровно четыре.
        expect(count(html, 'coverage__segment coverage__segment--')).toBe(4);
    });

    it('пока дифф не разобран, полоса стоит в загрузке и не обещает 100% объяснено', () => {
        const html = render({ parsed: false });

        expect(html).toContain('считаю покрытие по диффу');
        expect(html).not.toContain('объяснено');
        expect(html).not.toContain('coverage__segment');
        // Непокрытое ещё не посчитано — «Прочего» нет, пока разбор не покажет, что ему есть что показать.
        expect(order(html)).not.toContain('other');
        expect(html).toContain('01 / 6');
    });

    it('пока диапазоны не посчитаны, отметку остановки поставить нельзя', () => {
        const pending = render({ parsed: false });
        const marked = render({ parsed: false, stopViewed: ['s01'] });

        expect(count(pending, 'class="viewed-toggle ctl ctl--toggle route-stop__viewed" aria-pressed="false" disabled=""')).toBe(6);
        // Снятие отметки диапазонов не требует — уже отмеченная остановка остаётся кликабельной.
        expect(section(marked, 's01')).toContain('aria-pressed="true"');
        expect(section(marked, 's01')).not.toContain('disabled=""');
        expect(render()).not.toContain('route-stop__viewed" aria-pressed="false" disabled');
    });

    it('счётчик остановок считает реальные отметки', () => {
        const html = render({ stopViewed: ['s01', 'other'] });

        expect(html).toContain('просмотрено 2 из 7 остановок');
    });

    it('«Прочее» — такая же остановка: у него есть своя отметка просмотра', () => {
        const html = section(render({ stopViewed: ['other'] }), 'other');

        expect(html).toContain('>Просмотрено</button>');
        expect(html).toContain('aria-pressed="true"');
    });

    it('чипы файлов несут счётчики остановки и коробку прочитанности', () => {
        const html = render();

        expect(html).toContain('route-chip__read');
        expect(html).toContain('edit-window.ts');
        expect(html).toContain('Перейти к этому файлу в диффе остановки');
        // Путь режется слева, поэтому полный путь есть только в тултипе (docs/design/SPEC-elements.md §1.2).
        expect(chipPathTitles(html)).toContain('services/orders/src/domain/edit-window.ts');
        // Место счётчикам даёт контейнер имени с путём, а не спейсер.
        expect(html).toContain('route-chip__file');
        expect(html).not.toContain('route-chip__spacer');
    });

    it('дайджест-остановка рисует утверждения вместо тест-кода', () => {
        const stop = section(render(), 's04');

        expect(stop).toContain('Поведенческий дайджест · 12 утверждений');
        expect(stop).toContain(t(DIGEST_NOTE));
        expect(stop).toContain('Показать тест-код');
        // 10 строк списка плюс 2 футерных: чипы всех четырёх категорий на месте.
        expect(count(stop, 'class="digest__row')).toBe(12);
        expect(count(stop, 'digest__chip--new')).toBe(6);
        expect(count(stop, 'digest__chip--changed')).toBe(2);
        expect(count(stop, 'digest__chip--weakened')).toBe(2);
        expect(count(stop, 'digest__chip--uncovered')).toBe(2);
        expect(stop).toContain('Через 30 минут и одну миллисекунду окно закрыто.');
        expect(stop).toContain('edit-window.test.ts:17');
    });

    it('uncovered уезжает в футер со своей нотой, отброшенные считаются отдельно', () => {
        const stop = section(render(), 's04');
        const footer = stop.slice(stop.indexOf('digest__footer'));

        expect(stop).toContain(t(UNCOVERED_NOTE));
        // Обе футерные строки — внутри футера, а не в общем списке.
        expect(count(footer, 'digest__chip--uncovered')).toBe(2);
        expect(stop).toContain('2 утверждения отброшены — якорь не нашёл теста');
        // Счётчик футера — единственное упоминание: пометку валидатора заполненная остановка не рисует.
        expect(stop).not.toContain('Два утверждения отброшены: якорь вёл в');
    });

    it('якорь без цели на маршруте не кликается, а объясняет себя', () => {
        const stop = section(render(), 's04');

        // `edit-window.ts:92` объясняет остановка 01 — ссылка живая.
        expect(stop).toContain('edit-window.ts:92');
        expect(stop).not.toContain('digest__anchor--off');
        // У второго uncovered якоря нет вовсе: ссылки в его строке не появляется.
        expect(stop).toContain('Маскирование PAN в логе reauthorize');
    });

    it('тест-код спрятан по умолчанию и раскрывается тоглом', () => {
        const hidden = section(render(), 's04');
        const shown = section(render({ stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }), 's04');

        expect(hidden).not.toContain('file-card');
        expect(hidden).not.toContain('diff-rows');
        expect(shown).toContain('file-card');
        expect(shown).toContain('diff-rows');
        expect(shown).toContain('Скрыть тест-код');
        // Нота про спрятанный тест-код в раскрытом состоянии не врёт.
        expect(shown).not.toContain(t(DIGEST_NOTE));
    });

    it('при пустом пересечении вместо тогла и ложной ноты показывает ссылку на тест-код', () => {
        const stop = section(
            render({
                snapshot: digestOutsideStopSnapshot(),
                stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) },
            }),
            's04',
        );

        expect(stop).not.toContain('Показать тест-код');
        expect(stop).not.toContain('Скрыть тест-код');
        expect(stop).not.toContain(t(DIGEST_NOTE));
        expect(stop).toContain('digest__anchor digest__location"');
        expect(stop).toContain('тест-код — в остановке 01</button>');
        // Файлы s04 не совпали с файлами утверждений, поэтому никакие карточки не скрыты.
        expect(stop).toContain('file-card');
    });

    it('глобальный диффмод действует и на раскрытый тест-код (docs/design/SPEC-elements.md §2.6)', () => {
        const unified = section(render({ stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }), 's04');
        const split = section(
            render({ mode: 'split', stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }),
            's04',
        );

        expect(unified).not.toContain('diff-rows--split');
        expect(split).toContain('diff-rows--split');
    });

    it('тогл тест-кода не трогает прогресс: он живёт только в сессии', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const writes: string[] = [];
        const onSetStopViewed = (stopId: string): Promise<number> => {
            writes.push(stopId);
            return Promise.resolve(0);
        };

        render({ session, onSetStopViewed });
        session.setStopTestCode('s04', true);
        const shown = render({ session, onSetStopViewed });

        expect(writes).toEqual([]);
        expect(session.getSnapshot().stops.testCode).toEqual(new Set(['s04']));
        expect(section(shown, 's04')).toContain('Скрыть тест-код');
    });

    it('отметка дайджест-остановки живёт независимо от тогла', () => {
        const hidden = section(render({ stopViewed: ['s04'] }), 's04');
        const shown = section(
            render({ stopViewed: ['s04'], stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }),
            's04',
        );

        // Свёртка просмотренной остановки называет и утверждения, и файлы с строками.
        expect(hidden).toContain('12 утверждений · 3 файла · 172 строки · просмотрено');
        expect(shown).toContain('12 утверждений · 3 файла · 172 строки · просмотрено');
        expect(hidden).toContain('>Просмотрено</button>');
        expect(shown).toContain('>Просмотрено</button>');
    });

    it('просмотренный файл сворачивается внутри остановки', () => {
        const html = section(
            render({ progress: [{ fileId: ORDER_FILE.fileId, viewed: true, seenRanges: [] }] }),
            's02',
        );

        expect(html).toContain('order.ts');
        expect(html).toContain('file-card__collapsed--file');
        expect(html).toContain('· просмотрено');
    });

    it('сводка машинного файла считает срез и прячет отдельную кнопку collapsed-якорей', () => {
        const stops = { ...EMPTY_STOPS, expanded: new Set(['s06']) };
        const collapsed = section(render({ stops }), 's06');
        const expanded = section(
            render({ stops, collapsed: new Map([[GENERATED_FILE.fileId, false]]) }),
            's06',
        );

        expect(collapsed).toContain('+217');
        expect(collapsed).toContain('−9');
        expect(collapsed).toContain('· машинный файл');
        expect(collapsed).not.toContain('route-stop__collapsed-lines');
        expect(expanded).toContain('route-stop__collapsed-lines');
        expect(expanded).toContain('226 изменённых строк свёрнуто моделью');
    });

    it('карточка стопа рисует дифф, обрезанный якорями', () => {
        const html = render();
        const stop = section(html, 's01');

        // Первая остановка объясняет edit-window.ts целиком: 94 добавленные строки.
        expect(stop).toContain('+94');
        expect(stop).toContain('edit-window.ts');
        // Файлы чужих остановок в её колонке не появляются ни карточкой, ни чипом.
        expect(stop).not.toContain('pnpm-lock.yaml');
        expect(stop).not.toContain('handlers.ts');
    });
});

/** Разметка одной остановки: от её `data-stop` до следующего. */
function section(html: string, stopId: string): string {
    const start = html.indexOf(`data-stop="${stopId}"`);
    const next = html.indexOf('data-stop="', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
