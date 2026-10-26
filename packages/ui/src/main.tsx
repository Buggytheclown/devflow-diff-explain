/* Базовый слой идёт первым: правила состояний контролов обязаны стоять в каскаде
   до компонентных стилей — те доопределяют раскладку поверх них. */
import './styles/base.css';

import type { Locale } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { fetchUiPrState, fetchUiSettings, patchUiPrState, patchUiSettings } from './api.js';
import { MessageScreen } from './app.tsx';
import { App } from './story/app.tsx';
import { ALL_FILTER_ID } from './filters/lens-filters.js';
import { readFragmentParam, readToken, updateFragment } from './fragment.js';
import { IconSprite } from './icons/icon.tsx';
import { LocaleProvider, useT } from './i18n/index.js';
import { PrStateProvider } from './pr-state/context.tsx';
import { createUiPrStateStore } from './pr-state/pr-state-store.js';
import type { Viewing } from './iterations/viewing.js';
import { parseViewing } from './iterations/viewing.js';
import { sessionFragmentPatch } from './session/session-fragment.js';
import type { SessionState, SessionStore } from './session/session-store.js';
import {
    createSessionStore,
    DEFAULT_PRESET,
    DEFAULT_ROUTE_FILTER,
    parsePreset,
    parseRouteFilter,
} from './session/session-store.js';
import type { ViewId } from './session/views.js';
import { parseViewId, VIEWS } from './session/views.js';
import { SettingsProvider } from './settings/context.tsx';
import { DocumentSettingsSync, readDocumentAppearance } from './settings/document-settings.tsx';
import { createUiSettingsStore, loadUiSettings } from './settings/settings-store.js';
import { ShortcutsProvider } from './shortcuts/context.tsx';
import { createPointerTarget } from './shortcuts/pointer-target.js';
import { attachShortcuts, createShortcutRegistry } from './shortcuts/registry.js';
import type { Store } from './store.js';
import { createStore } from './store.js';

/** Вторая клавиша аккорда перехода к вью: `g o` — Обзор, `g r` — Маршрут, `g d` — Полный дифф. */
const VIEW_CHORD: Readonly<Record<ViewId, string>> = { overview: 'o', route: 'r', diff: 'd' };

/** Потолок ожидания серверного состояния (настройки и состояние PR) перед первым рендером. */
const SETTINGS_BOOT_TIMEOUT_MS = 1500;

const container = document.getElementById('root');
if (!container) {
    throw new Error('Devflow Diff Explain UI: root element #root is missing');
}

const token = readToken(window.location.hash);
const root = createRoot(container);

if (token === null) {
    // Без токена не делаем ни одного запроса: ссылку с токеном печатает запуск скилла/сервера.
    // Настроек здесь нет — язык берётся из браузера: провайдер без стора читает запасной.
    root.render(
        <StrictMode>
            <IconSprite />
            <LocaleProvider>
                <NoTokenScreen />
            </LocaleProvider>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });
    // Глобальные настройки живут на сервере, и первый рендер их ждёт: режим диффа и раскладка
    // композера должны быть известны до создания сторов, иначе тумблер перещёлкивается на
    // глазах, а редактор пересоздаётся под уже печатающим ревьюером.
    const settings = createUiSettingsStore({
        initial: readDocumentAppearance(document.documentElement),
        send: (patch) => patchUiSettings(token, patch),
    });
    const settingsReady = loadUiSettings(settings, () => fetchUiSettings(token));
    // Свёрнутые каталоги и карточки этого PR грузятся в той же гонке. Опоздавший ответ стор
    // дифф-вью не пересоздаёт: карта доливается в него отдельно (см. App).
    const prState = createUiPrStateStore({ send: (patch, options) => patchUiPrState(token, patch, options) });
    const prStateReady = prState.load(() => fetchUiPrState(token));
    // Уходящая вкладка забирает с собой отложенную запись: задержка до затишья не должна съесть последний клик.
    const flushPrState = (): void => {
        prState.flush();
    };
    window.addEventListener('pagehide', flushPrState);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushPrState();
        }
    });

    const viewFromUrl = parseViewId(readFragmentParam(window.location.hash, 'view'));
    // Что смотрит вкладка: `snapshot=` главнее среза `base=&head=`, срез главнее `diff=`,
    // «текущее» в адрес не пишется.
    let persistedViewing: Viewing = parseViewing(
        readFragmentParam(window.location.hash, 'snapshot'),
        readFragmentParam(window.location.hash, 'diff'),
        readFragmentParam(window.location.hash, 'base'),
        readFragmentParam(window.location.hash, 'head'),
    );
    // Единственный слушатель клавиатуры на странице; команды объявлены только здесь (docs/architecture.md §7.3).
    const shortcuts = createShortcutRegistry();
    attachShortcuts(window, shortcuts);
    // Цель команд «под курсором» (docs/design/SPEC-elements.md §5): трекер один на страницу, как и слушатель клавиш.
    const pointer = createPointerTarget(window, document);

    /**
     * Сессионный стор и его команды заводятся после серверного состояния: стартовый вид
     * зависит от того, пройден ли тур первого захода, а это поле глобальных настроек.
     */
    const startSession = (defaultView: ViewId): SessionStore => {
        const session = createSessionStore({
            // Вью из адреса — выбор ревьюера: малый PR его не переопределит (docs/design/SPEC-elements.md §4.1).
            viewPinned: viewFromUrl !== null,
            initial: {
                view: viewFromUrl ?? defaultView,
                // Валидность id проверит модель фильтров: она одна знает, какие линзы есть у хоста.
                filter: readFragmentParam(window.location.hash, 'filter') ?? ALL_FILTER_ID,
                preset: parsePreset(readFragmentParam(window.location.hash, 'preset')) ?? DEFAULT_PRESET,
                routeFilter:
                    parseRouteFilter(readFragmentParam(window.location.hash, 'routeFilter')) ??
                    DEFAULT_ROUTE_FILTER,
                viewing: persistedViewing,
                paletteOpen: false,
            },
            persist: (state: SessionState, fragment?: Readonly<Record<string, string | null>>) => {
                const patch = sessionFragmentPatch(state, persistedViewing, fragment);
                persistedViewing = state.viewing;
                // replaceState, а не присваивание hash: перебор табов не должен забивать историю.
                history.replaceState(null, '', updateFragment(window.location.hash, patch));
            },
        });

        VIEWS.filter((view) => view.id !== 'overview').forEach((view, index) => {
            shortcuts.register({
                id: `view.${view.id}`,
                // Аккорд `g o`/`g r`/`g d` — второе сочетание той же команды (docs/design/SPEC-elements.md §5), а не новая.
                keys: [String(index + 1), `g ${VIEW_CHORD[view.id]}`],
                label: view.command,
                scope: 'global',
                section: 'navigation',
                action: () => {
                    session.setView(view.id);
                },
            });
        });
        return session;
    };

    // Ждём серверное состояние, но не дольше таймаута: зависшая ручка не должна держать ревьюера
    // перед пустой страницей — тогда рисуем на умолчаниях, ответ доедет в сторы позже.
    void Promise.race([Promise.all([settingsReady, prStateReady]), delay(SETTINGS_BOOT_TIMEOUT_MS)]).then(() => {
        /*
         * Непройденный тур открывает вкладку на Маршруте: первые три его шага говорят про
         * маршрут, и начинать их с Обзора незачем. Это правка умолчания на этапе загрузки —
         * вид из адреса главнее, и по ходу тур ничего не переключает (docs/design/SPEC-onboarding-2026-09-02.md §2).
         * Настройки, не доехавшие до таймаута, права голоса тут не имеют: тур по ним и не
         * стартует — на умолчаниях он выглядел бы непройденным у кого угодно.
         */
        const session = startSession('route');
        root.render(
            <StrictMode>
                <IconSprite />
                <ShortcutsProvider registry={shortcuts} pointer={pointer}>
                    <SettingsProvider store={settings}>
                        <DocumentSettingsSync />
                        <AgentLocaleProvider store={store}>
                            <PrStateProvider store={prState}>
                                <App store={store} session={session} token={token} />
                            </PrStateProvider>
                        </AgentLocaleProvider>
                    </SettingsProvider>
                </ShortcutsProvider>
            </StrictMode>,
        );
    });
}

/**
 * Провайдер локали с подсказкой агента из серверного состояния: подписка живёт здесь, чтобы
 * `LocaleProvider` не знал про стор — в галерее и тестах компонентов его нет.
 * Новый `lang` приезжает по SSE и перерисовывает дерево без перезагрузки.
 */
function AgentLocaleProvider({ store, children }: { store: Store; children: ReactNode }) {
    const agentLang = useSyncExternalStore(store.subscribe, () => agentLangOf(store));
    return <LocaleProvider agentLang={agentLang}>{children}</LocaleProvider>;
}

function agentLangOf(store: Store): Locale | undefined {
    const worker = store.getSnapshot().state?.worker;
    return worker === undefined || worker.kind === 'never' ? undefined : worker.lang;
}

/** Экран без токена: единственное место, где UI живёт вообще без серверного состояния. */
function NoTokenScreen() {
    const t = useT();
    return (
        <MessageScreen title={t('app.name')}>
            <p>{t('app.noToken.text')}</p>
            <p className="message-screen__hint">{t('app.noToken.hint')}</p>
        </MessageScreen>
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
