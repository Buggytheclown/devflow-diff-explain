import { chatFixtures, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatExchange } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import type { PaletteChat } from '../../palette/command-palette.tsx';
import { CommandPalette } from '../../palette/command-palette.tsx';
import { PaletteDiffSourceProvider, usePaletteDiffSource } from '../../palette/diff-source.tsx';
import { PrStateProvider } from '../../pr-state/context.tsx';
import { createUiPrStateStore } from '../../pr-state/pr-state-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { asFetched } from './fetched.js';

export interface PaletteGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

const DATA = asFetched(fixtureIteration('medium'));
const CHAT = chatFixtures('medium');
/** Часы галереи стоят: относительное время в строках истории не должно плыть от прогона к прогону. */
const NOW = Date.parse('2026-08-20T10:00:00.000Z');
const LIVE_FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const EDIT_WINDOW_FILE_ID = DATA.diff.files.find((file) => file.path.endsWith('domain/edit-window.ts'))?.fileId ?? '';

function paletteChat(exchanges: readonly ChatExchange[], notes: readonly AgentNote[], live: ReadonlySet<string>): PaletteChat {
    return { exchanges, notes, liveFileIds: live, now: NOW, onSelect: () => undefined };
}

const CHAT_HISTORY = paletteChat(CHAT?.exchanges ?? [], CHAT?.notes ?? [], LIVE_FILE_IDS);
/**
 * Разные состояния якоря в одной выдаче: вопрос ко всему PR (2), живой якорь на
 * `edit-window.ts` (7) и обмен на `handlers.ts` (1) — его файла в этой итерации нет, а заметка
 * после пуша якорь потеряла.
 */
const CHAT_ANCHORS = paletteChat(
    (CHAT?.exchanges ?? []).filter((exchange) => [1, 2, 7].includes(exchange.id)),
    CHAT?.notesAfterPush ?? [],
    new Set([EDIT_WINDOW_FILE_ID]),
);

export const PALETTE_STATES: readonly PaletteGalleryState[] = [
    {
        id: 'palette-fuzzy',
        title: 'нечёткий поиск: файлы и команды',
        // key ремоунтит палитру при переключении состояний: query — её внутреннее состояние,
        // без ремоунта запрос предыдущего состояния переживал бы переход.
        // «re» ловит и пути файлов, и подпись Request changes — она одинакова на обоих языках.
        render: () => <PaletteState key="palette-fuzzy" query="re" />,
    },
    {
        id: 'palette-empty',
        title: 'пустой запрос: недавнее и предложения',
        render: () => <PaletteState key="palette-empty" query="" recent />,
    },
    {
        id: 'palette-no-results',
        title: 'ничего не найдено с действием поиска по диффу',
        render: () => <PaletteState key="palette-no-results" query="cachee" />,
    },
    {
        id: 'palette-diff-search',
        title: 'поиск по содержимому диффа',
        render: () => <PaletteState key="palette-diff-search" query="/orderId" />,
    },
    {
        id: 'palette-chat-recent',
        title: 'история чата: последние обмены',
        render: () => <PaletteState key="palette-chat-recent" query="@" chat={CHAT_HISTORY} />,
    },
    {
        id: 'palette-chat-query',
        title: 'история чата: попадания в вопросе и в ответе',
        render: () => <PaletteState key="palette-chat-query" query="@окно" chat={CHAT_HISTORY} />,
    },
    {
        id: 'palette-chat-anchors',
        title: 'история чата: вопрос ко всему PR, мёртвый якорь, потерянная заметка',
        render: () => <PaletteState key="palette-chat-anchors" query="@" chat={CHAT_ANCHORS} />,
    },
];

function PaletteState({
    query,
    recent = false,
    chat,
}: {
    query: string;
    recent?: boolean;
    chat?: PaletteChat;
}) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'diff', filter: 'all', paletteOpen: true } }),
        [],
    );
    const paletteOpen = useSyncExternalStore(session.subscribe, session.getSnapshot).paletteOpen;
    const registry = useMemo(() => {
        const created = createShortcutRegistry();
        created.register({
            id: 'view.diff',
            keys: ['3'],
            label: 'shortcut.view.diff',
            scope: 'global',
            section: 'navigation',
            action: () => undefined,
        });
        created.register({
            id: 'review.requestChanges',
            keys: ['mod+shift+enter'],
            label: 'shortcut.review.requestChanges',
            scope: 'global',
            section: 'ship',
            action: () => undefined,
        });
        created.register({
            id: 'gallery.toggleMode',
            keys: ['d'],
            label: 'shortcut.diff.toggleMode',
            scope: 'global',
            section: 'reading',
            action: () => undefined,
        });
        return created;
    }, []);
    // Состояние PR у галереи своё и в памяти: сервера здесь нет, а «недавнее» надо показать.
    const prState = useMemo(
        () => createUiPrStateStore(recent ? { initial: { paletteRecent: ['gallery.toggleMode'] } } : {}),
        [recent],
    );
    const source = useMemo(
        () => ({
            files: DATA.diff.files,
            activeFileId: DATA.diff.files[0]?.fileId ?? null,
            searchModels: () => new Map(),
            goToFile: () => undefined,
            goToLine: () => undefined,
            toggleDiffMode: () => undefined,
        }),
        [],
    );

    return (
        <ShortcutsProvider registry={registry}>
            <PrStateProvider store={prState}>
                <PaletteDiffSourceProvider value={source}>
                    <PaletteFromContext
                        open={paletteOpen}
                        query={query}
                        chat={chat}
                        onClose={() => {
                            session.setPaletteOpen(false);
                        }}
                    />
                </PaletteDiffSourceProvider>
            </PrStateProvider>
        </ShortcutsProvider>
    );
}

function PaletteFromContext({
    open,
    query,
    chat,
    onClose,
}: {
    open: boolean;
    query: string;
    chat?: PaletteChat | undefined;
    onClose: () => void;
}) {
    const source = usePaletteDiffSource();
    return (
        <CommandPalette
            open={open}
            source={source}
            chat={chat}
            initialQuery={query}
            onOpen={() => undefined}
            onClose={onClose}
        />
    );
}
