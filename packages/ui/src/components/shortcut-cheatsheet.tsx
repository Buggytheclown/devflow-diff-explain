import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { MessageKey } from '../i18n/index.js';
import { translateKey, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useEscapeLayer, useShortcutList, useShortcutRegistry } from '../shortcuts/context.tsx';
import type { Shortcut, ShortcutSection } from '../shortcuts/registry.js';
import { formatKeys, SHORTCUT_SECTIONS } from '../shortcuts/registry.js';
import { useFocusTrap } from './use-focus-trap.js';
import './shortcut-cheatsheet.css';

/**
 * Читшит `?` (docs/design/SPEC-elements.md §5). Единственный источник — реестр: показываются команды активной области
 * и глобальные, разложенные по разделам. `when()` здесь не учитывается — это справочник, а не
 * список доступного прямо сейчас; команды без сочетаний в справочник не попадают.
 */
export interface ShortcutCheatsheetProps {
    readonly onClose: () => void;
}

/** `⌘K` стоит первой строкой раздела «Навигация»: это вход во всё остальное (docs/design/SPEC-elements.md §2.3). */
const FIRST_ID = 'palette.open';

export function ShortcutCheatsheet({ onClose }: ShortcutCheatsheetProps) {
    const t = useT();
    const registry = useShortcutRegistry();
    const shortcuts = useShortcutList();
    const dialogRef = useRef<HTMLElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        registry?.setModalOpen(true);
        return () => {
            registry?.setModalOpen(false);
        };
    }, [registry]);
    useEffect(() => {
        closeRef.current?.focus();
    }, []);
    useFocusTrap(dialogRef);
    useEscapeLayer('modal', onClose);

    const sections = useMemo(() => cheatsheetSections(shortcuts), [shortcuts]);

    const content = (
        <div
            className="shortcut-cheatsheet__overlay"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                ref={dialogRef}
                className="shortcut-cheatsheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="shortcut-cheatsheet-title"
                tabIndex={-1}
            >
                <header className="shortcut-cheatsheet__header">
                    <h2 id="shortcut-cheatsheet-title">{t('help.cheatsheet.title')}</h2>
                    <span className="shortcut-cheatsheet__spacer" />
                    <button
                        ref={closeRef}
                        type="button"
                        className="ctl ctl--icon shortcut-cheatsheet__icon-button"
                        aria-label={t('help.cheatsheet.close')}
                        title={t('help.cheatsheet.close.title')}
                        onClick={onClose}
                    >
                        <Icon name="cross" size={14} />
                    </button>
                </header>

                <div className="shortcut-cheatsheet__columns">
                    {sections.map((section) => (
                        <section className="shortcut-cheatsheet__section" key={section.id}>
                            <h3>{t(section.label)}</h3>
                            <dl>
                                {section.items.map((item) => (
                                    <div className="shortcut-cheatsheet__row" key={item.id}>
                                        <dt>
                                            <kbd className="shortcut-cheatsheet__keys">
                                                {formatKeys(item.keys, t)}
                                            </kbd>
                                        </dt>
                                        <dd>{translateKey(t, item.label, item.labelArg)}</dd>
                                    </div>
                                ))}
                            </dl>
                        </section>
                    ))}
                </div>
            </section>
        </div>
    );

    return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export interface CheatsheetSection {
    readonly id: ShortcutSection;
    readonly label: MessageKey;
    readonly items: readonly Shortcut[];
}

/** Разделы читшита в порядке `SHORTCUT_SECTIONS`; пустые не показываются. */
export function cheatsheetSections(shortcuts: readonly Shortcut[]): readonly CheatsheetSection[] {
    const withKeys = shortcuts.filter((shortcut) => shortcut.keys.length > 0);
    return SHORTCUT_SECTIONS.map((section) => ({
        id: section.id,
        label: section.label,
        items: withKeys
            .filter((shortcut) => shortcut.section === section.id)
            .sort((first, second) => rank(first) - rank(second)),
    })).filter((section) => section.items.length > 0);
}

function rank(shortcut: Shortcut): number {
    return shortcut.id === FIRST_ID ? 0 : 1;
}
