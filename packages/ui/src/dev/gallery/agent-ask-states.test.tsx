import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_ASK_DIFF_STATES, AGENT_ASK_ROUTE_STATES } from './agent-ask-states.tsx';

describe('галерея точек входа Ask AI', () => {
    it('рисует точку входа «Прочего» в обоих состояниях агента', () => {
        expect(AGENT_ASK_ROUTE_STATES.map((state) => state.id)).toEqual(['route-other-ask', 'route-other-ask-offline']);

        const [connected, offline] = AGENT_ASK_ROUTE_STATES.map((state) => renderToStaticMarkup(<>{state.render()}</>));
        expect(connected).toContain('Попросить агента разложить их');
        expect(connected).toContain('ответ придёт в чат, маршрут не изменится');
        expect(connected).not.toContain('Переподключите агента');
        expect(offline).toContain('Переподключите агента, чтобы спросить об этих строках');
        expect(offline).toContain('disabled');
    });

    it('рисует полосу с кнопкой, чипом «спрошено» и погашенной кнопкой', () => {
        expect(AGENT_ASK_DIFF_STATES.map((state) => state.id)).toEqual([
            'full-diff-strip-ask',
            'full-diff-strip-asked',
            'full-diff-strip-offline',
        ]);

        const [ask, asked, offline] = AGENT_ASK_DIFF_STATES.map((state) => renderToStaticMarkup(<>{state.render()}</>));
        expect(ask).toContain('Попросить агента разложить');
        expect(ask).not.toContain('disabled');
        expect(asked).toContain('спрошено · ответ появится здесь');
        expect(asked).not.toContain('<button');
        expect(offline).toContain('Переподключите агента, чтобы спросить об этих строках');
        expect(offline).toContain('disabled');
    });
});
