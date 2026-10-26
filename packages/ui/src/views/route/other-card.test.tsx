// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RouteOtherView } from '../../route/route-model.js';
import { OtherCard, RegenerateBanner } from './other-card.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

describe('баннер недообъяснённого маршрута', () => {
    it('без доступной генерации оставляет совет без мёртвой кнопки', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(<RegenerateBanner />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).toContain('стоит перегенерировать');
        expect(host.querySelector('button')).toBeNull();
    });

    it('даёт доступную кнопку перегенерации и зовёт ту же точку входа', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const onGenerate = vi.fn();
        const root = createRoot(host);
        act(() => {
            root.render(<RegenerateBanner onGenerate={onGenerate} />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        const button = host.querySelector('button');
        expect(button?.textContent).toBe('Перегенерировать');
        expect(button?.getAttribute('type')).toBe('button');
        act(() => {
            button?.click();
        });
        expect(onGenerate).toHaveBeenCalledOnce();
    });
});

const OTHER_VIEW: RouteOtherView = {
    stop: {
        id: 'other',
        planIndex: 6,
        tier: 'other',
        title: 'Прочее — модель не разместила эти строки',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        validationNotes: [],
        droppedClaims: 0,
        status: 'ready',
        provenance: null,
        change: null,
    },
    planLabel: '07',
    files: [],
    lines: 34,
    conflictFiles: 0,
};

function renderCard(patch: Partial<Parameters<typeof OtherCard>[0]> = {}): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <OtherCard
                view={OTHER_VIEW}
                stopCount={7}
                opened={false}
                onOpen={() => undefined}
                diff={null}
                pending={false}
                {...patch}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function askButton(host: HTMLElement): HTMLButtonElement | null {
    return (
        [...host.querySelectorAll<HTMLButtonElement>('.route-other__action')].find((button) =>
            button.textContent.startsWith('Попросить агента'),
        ) ?? null
    );
}

describe('точка входа «попросить агента разложить» у «Прочего»', () => {
    it('без обработчика кнопки нет вовсе', () => {
        const host = renderCard();

        expect(askButton(host)).toBeNull();
        expect(host.textContent).not.toContain('ответ придёт в чат');
    });

    it('с подключённым агентом зовёт обработчик и предупреждает, что маршрут не изменится', () => {
        const onAskToPlace = vi.fn();
        const host = renderCard({ onAskToPlace, agentConnected: true });

        const button = askButton(host);
        expect(button?.disabled).toBe(false);
        expect(host.textContent).toContain('ответ придёт в чат, маршрут не изменится');
        act(() => {
            button?.click();
        });

        expect(onAskToPlace).toHaveBeenCalledOnce();
    });

    it('при отключённом агенте гаснет с той же формулировкой, что у поповера', () => {
        const host = renderCard({ onAskToPlace: () => undefined, agentConnected: false });

        const button = askButton(host);
        expect(button?.disabled).toBe(true);
        expect(button?.title).toBe('Переподключите агента, чтобы спросить об этих строках');
    });

    it('пока диапазоны считаются, перечислять в вопросе нечего', () => {
        const pending = renderCard({ onAskToPlace: () => undefined, agentConnected: true, pending: true });
        expect(askButton(pending)?.disabled).toBe(true);
        expect(askButton(pending)?.title).toBe('Считаю непокрытые строки…');

        const filling = renderCard({ onAskToPlace: () => undefined, agentConnected: true, filling: true });
        expect(askButton(filling)?.disabled).toBe(true);
        expect(askButton(filling)?.title).toBe('Жду, пока маршрут заполнится');
    });
});

describe('строка конфликтов в «Прочем»', () => {
    it('молчит, пока конфликтов нет', () => {
        expect(renderCard().querySelector('.route-other__conflicts')).toBeNull();
    });

    it('называет число файлов и отправляет разрешать их в хост (docs/design/SPEC-elements.md §4.1)', () => {
        const host = renderCard({ view: { ...OTHER_VIEW, conflictFiles: 2 } });
        const line = host.querySelector('.route-other__conflicts');

        expect(line?.textContent).toContain('2 файла с конфликтами');
        expect(line?.textContent).toContain('в покрытие они не входят');
    });

    it('слот держат одни конфликты: ни «0 строк в 0 файлах», ни кнопок на пустоте', () => {
        const host = renderCard({
            view: { ...OTHER_VIEW, files: [], lines: 0, conflictFiles: 2 },
            onAskToPlace: () => undefined,
            agentConnected: true,
        });

        expect(host.textContent).not.toContain('остались без остановки');
        expect(host.textContent).not.toContain('Открыть 0');
        expect(host.querySelector('.route-other__actions')).toBeNull();
        expect(askButton(host)).toBeNull();
        expect(host.textContent).toContain('Без остановки не осталось ни одной изменённой строки');
        expect(host.querySelector('.route-other__conflicts')?.textContent).toContain('2 файла с конфликтами');
    });
});
