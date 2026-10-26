import type { ReactNode } from 'react';
import { Fragment } from 'react';

import { Icon } from '../../icons/icon.tsx';
import './control-states.css';

/**
 * Матрица базовых контролов: строки — варианты таблицы §5
 * (docs/design/SPEC-changes-2026-09-20.md), столбцы — покой, hover, нажатие, disabled, focus.
 *
 * Состояния принудительные: `data-state` на контроле включает те же правила `controls.css`,
 * что и живые `:hover` / `:active` / `:focus-visible`. Иначе половину таблицы нельзя увидеть
 * одновременно и не с чем сверять макет.
 */

type ControlState = 'rest' | 'hover' | 'active' | 'disabled' | 'focus';

const COLUMNS: readonly { state: ControlState; label: string }[] = [
    { state: 'rest', label: 'покой' },
    { state: 'hover', label: 'hover' },
    { state: 'active', label: 'нажатие' },
    { state: 'disabled', label: 'disabled' },
    { state: 'focus', label: 'focus' },
];

/** Атрибуты состояния для самого контрола. */
function stateProps(state: ControlState): { 'data-state'?: string; disabled?: boolean } {
    if (state === 'rest') {
        return {};
    }
    if (state === 'disabled') {
        return { disabled: true };
    }
    return { 'data-state': state };
}

interface Row {
    readonly name: string;
    readonly where: string;
    readonly render: (state: ControlState) => ReactNode;
}

interface Section {
    readonly title: string;
    readonly rows: readonly Row[];
}

/** Кнопка одного варианта: класс варианта плюс принудительное состояние. */
function ctl(variant: string, label: ReactNode, state: ControlState, extra?: string): ReactNode {
    return (
        <button type="button" className={`ctl ${variant}${extra === undefined ? '' : ` ${extra}`}`} {...stateProps(state)}>
            {label}
        </button>
    );
}

/** Сегмент: активный пункт не реагирует, состояние принуждается на соседнем. */
function segment(state: ControlState, small: boolean): ReactNode {
    const [active, idle] = small ? ['Визуально', 'Markdown'] : ['Маршрут', 'Полный дифф'];
    return (
        <div className={`ctl-tabs${small ? ' ctl-tabs--small' : ''}`}>
            <button type="button" className="ctl ctl--tab is-active">
                {active}
            </button>
            <button type="button" className="ctl ctl--tab" {...stateProps(state)}>
                {idle}
            </button>
        </div>
    );
}

function switcher(state: ControlState, on: boolean): ReactNode {
    return (
        <button
            type="button"
            className={`ctl-switch${on ? ' is-on' : ''}`}
            aria-pressed={on}
            {...stateProps(state)}
        >
            <span className="ctl-switch__track" aria-hidden="true">
                <span className="ctl-switch__knob" />
            </span>
            Открыть issue
        </button>
    );
}

function checkbox(state: ControlState, on: boolean): ReactNode {
    return (
        <button type="button" className={`ctl-checkbox${on ? ' is-on' : ''}`} aria-pressed={on} {...stateProps(state)}>
            <span className="ctl-checkbox__box" aria-hidden="true">
                <Icon name="check" size={9} />
            </span>
            Отметить просмотренным
        </button>
    );
}

const SECTIONS: readonly Section[] = [
    {
        title: 'Кнопки · заливка: ховер = фон на ступень, нажатие = ещё ступень',
        rows: [
            {
                name: 'Primary',
                where: 'Ship, Ask the agent, Next',
                render: (state) => ctl('ctl--primary', 'Ship · 2', state),
            },
            {
                name: 'Attention',
                where: 'Что изменилось…',
                render: (state) => ctl('ctl--attention', 'Что изменилось…', state),
            },
            {
                name: 'Secondary solid',
                where: 'Сохранить черновик, Retry, Regenerate, Скопировать команду',
                render: (state) => ctl('ctl--secondary', 'Сохранить черновик', state),
            },
            {
                name: 'Danger solid',
                where: 'Удалить',
                render: (state) => ctl('ctl--danger', 'Удалить', state),
            },
            {
                name: 'Viewed toggle · off',
                where: 'отметка остановки',
                render: (state) => ctl('ctl--toggle', 'Отметить просмотренным', state),
            },
            {
                name: 'Viewed toggle · on',
                where: 'отметка остановки',
                render: (state) =>
                    ctl(
                        'ctl--toggle',
                        <>
                            <Icon name="check" size={13} />
                            Просмотрено
                        </>,
                        state,
                        'is-on',
                    ),
            },
            {
                name: 'Resolve toggle · off',
                where: 'шапка комментария с issue',
                render: (state) =>
                    ctl(
                        'ctl--toggle ctl--toggle-compact',
                        <>
                            <Icon name="dot" size={11} className="ctl__dot" />
                            Resolve
                        </>,
                        state,
                    ),
            },
            {
                name: 'Resolve toggle · on',
                where: 'шапка комментария с issue',
                render: (state) =>
                    ctl(
                        'ctl--toggle ctl--toggle-compact',
                        <>
                            <Icon name="check" size={11} />
                            Resolved
                        </>,
                        state,
                        'is-on',
                    ),
            },
        ],
    },
    {
        title: 'Кнопки с рамкой и без неё',
        rows: [
            {
                name: 'Ghost',
                where: 'Отмена, Feedback, Поиск, Агент',
                render: (state) => ctl('ctl--ghost', 'Отмена', state),
            },
            {
                name: 'Danger ghost',
                where: 'Request changes',
                render: (state) => ctl('ctl--danger-ghost', 'Request changes', state),
            },
            {
                name: 'Quiet mono',
                where: '⇄ unified, свернуть все',
                render: (state) => ctl('ctl--quiet', '⇄ unified', state),
            },
            {
                name: 'Link',
                where: 'читать полный дифф',
                render: (state) => ctl('ctl--link', 'Читать полный дифф →', state),
            },
            {
                name: 'Link · muted',
                where: 'Resolve, повторить, отменить',
                render: (state) => ctl('ctl--link-muted', 'повторить', state),
            },
            {
                name: 'Link · danger',
                where: 'Удалить под комментарием и заметкой',
                render: (state) => ctl('ctl--link-danger', 'Удалить', state),
            },
        ],
    },
    {
        title: 'Свитчер, табы, чипы · активный сегмент на ховер не реагирует',
        rows: [
            { name: 'Switch · off', where: 'Открыть issue', render: (state) => switcher(state, false) },
            { name: 'Switch · on', where: 'Открыть issue', render: (state) => switcher(state, true) },
            {
                name: 'Tabs / segment',
                where: 'вью, пресет, зона',
                render: (state) => segment(state, false),
            },
            {
                name: 'Segment · small',
                where: 'Визуально | Markdown',
                render: (state) => segment(state, true),
            },
            {
                name: 'Filter chip · off',
                where: 'People · Bots · Resolved',
                render: (state) => ctl('ctl--chip', 'Боты 2', state),
            },
            {
                name: 'Filter chip · on',
                where: 'People · Bots · Resolved',
                render: (state) => ctl('ctl--chip', 'Люди 3', state, 'is-on'),
            },
        ],
    },
    {
        title: 'Иконочные кнопки и чекбокс',
        rows: [
            {
                name: 'Icon ghost 25×25',
                where: 'карандаш, ✕',
                render: (state) => ctl('ctl--icon', <Icon name="pencil" size={14} />, state),
            },
            {
                name: 'Icon danger 25×25',
                where: 'корзина',
                render: (state) => ctl('ctl--icon-danger', <Icon name="trash" size={14} />, state),
            },
            {
                name: 'Toolbar icon 26×24',
                where: 'тулбар композера',
                render: (state) => ctl('ctl--toolbar-icon', <Icon name="bold" size={14} />, state),
            },
            {
                name: 'Chevron 20×20',
                where: 'раскрытие треда, «⋯» в дереве',
                render: (state) => ctl('ctl--chevron', <Icon name="chev-down" size={13} />, state),
            },
            {
                name: 'Checkbox 12px · off',
                where: 'отметка в шапке файла',
                render: (state) => checkbox(state, false),
            },
            {
                name: 'Checkbox 12px · on',
                where: 'отметка в шапке файла',
                render: (state) => checkbox(state, true),
            },
        ],
    },
];

function ControlMatrix() {
    return (
        <div className="control-matrix">
            <div className="control-matrix__head">контрол · где</div>
            {COLUMNS.map((column) => (
                <div key={column.state} className="control-matrix__head">
                    {column.label}
                </div>
            ))}
            {SECTIONS.map((section) => (
                <Fragment key={section.title}>
                    <div className="control-matrix__group">{section.title}</div>
                    {section.rows.map((row) => (
                        <Fragment key={row.name}>
                            <div className="control-matrix__label">
                                <span className="control-matrix__name">{row.name}</span>
                                <span className="control-matrix__where">{row.where}</span>
                            </div>
                            {COLUMNS.map((column) => (
                                <div key={column.state} className="control-matrix__cell">
                                    {row.render(column.state)}
                                </div>
                            ))}
                        </Fragment>
                    ))}
                </Fragment>
            ))}
        </div>
    );
}

export const CONTROL_STATES = [
    {
        id: 'controls-matrix',
        group: 'Контролы',
        title: 'состояния, тёмная тема',
        render: () => <ControlMatrix />,
    },
    {
        id: 'controls-matrix-light',
        group: 'Контролы',
        title: 'состояния, светлая тема',
        render: () => (
            <div data-theme="light" className="gallery-themed">
                <ControlMatrix />
            </div>
        ),
    },
];
