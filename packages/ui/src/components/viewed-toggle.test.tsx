import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ViewedToggle } from './viewed-toggle.tsx';

/**
 * Отметка «просмотрено» — один контрол на файл и на остановку (docs/design/SPEC-elements.md §2.10): состояний два,
 * тексты и коробка у обоих мест одинаковые, а место вызова добавляет только свой класс.
 */

function render(props: Partial<Parameters<typeof ViewedToggle>[0]> = {}): string {
    return renderToStaticMarkup(
        <ViewedToggle
            className={props.className ?? 'route-stop__viewed'}
            viewed={props.viewed ?? false}
            {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
            {...(props.title === undefined ? {} : { title: props.title })}
            onToggle={props.onToggle ?? (() => undefined)}
        />,
    );
}

describe('отметка «просмотрено»', () => {
    it('непросмотренное: пустая коробка и приглашение отметить', () => {
        const html = render();

        expect(html).toContain('aria-pressed="false"');
        expect(html).toContain('Отметить просмотренным');
        expect(html).toContain('ctl-checkbox__box');
        expect(html).not.toContain('is-on');
    });

    it('просмотренное: коробка залита, подпись без глифа в тексте', () => {
        const html = render({ viewed: true });

        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain('is-on');
        expect(html).toContain('data-icon="check"');
        expect(html).toContain('width="9"');
        expect(html).toContain('</span>Просмотрено</button>');
    });

    it('оба места зовут один контрол: разметка отличается только классом места', () => {
        const stop = render({ className: 'route-stop__viewed', viewed: true });
        const file = render({ className: 'file-card__viewed', viewed: true });

        expect(file).toBe(stop.replace('route-stop__viewed', 'file-card__viewed'));
    });

    it('выключенный тогл всегда объясняет причину (docs/design/SPEC-elements.md §1.1)', () => {
        const html = render({ disabled: true, title: 'Диапазоны остановки ещё считаются' });

        expect(html).toContain('disabled=""');
        expect(html).toContain('title="Диапазоны остановки ещё считаются"');
    });
});
