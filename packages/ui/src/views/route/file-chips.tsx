import { useState } from 'react';

import { useFormat, useT } from '../../i18n/index.js';
import { readStateTooltip } from '../../progress/read-state.js';
import { Icon } from '../../icons/icon.tsx';
import type { FileReadState } from '../../progress/read-state.js';
import type { RouteFileGroup } from '../../route/route-model.js';

/**
 * Чипы файлов остановки (docs/design/README.md §1): имя, путь, счётчики этой остановки и коробка
 * прочитанности. Клик ведёт к карточке файла в правой колонке (docs/design/SPEC-elements.md §2.11).
 *
 * Больше 12 файлов — показываем 8 и раскрывашку «ещё N файлов» (docs/design/SPEC-elements.md §2.9): узкая колонка
 * не должна превращаться в список файлов на два экрана.
 */

const CHIPS_LIMIT = 12;
const CHIPS_SHOWN = 8;

export interface FileChipsProps {
    readonly files: readonly RouteFileGroup[];
    readonly readStateOf: (fileId: string) => FileReadState;
    readonly onOpen: (fileId: string) => void;
}

export function FileChips({ files, readStateOf, onOpen }: FileChipsProps) {
    const t = useT();
    const [expanded, setExpanded] = useState(false);
    const clamped = files.length > CHIPS_LIMIT && !expanded;
    const shown = clamped ? files.slice(0, CHIPS_SHOWN) : files;
    const hidden = files.length - shown.length;

    return (
        <div className="route-chips">
            {shown.map((group) => (
                <FileChip key={group.fileId} group={group} read={readStateOf(group.fileId)} onOpen={onOpen} />
            ))}
            {hidden === 0 ? null : (
                <button
                    type="button"
                    className="ctl ctl--link route-chips__more"
                    onClick={() => {
                        setExpanded(true);
                    }}
                >
                    {t('route.fileChips.more', hidden)}
                </button>
            )}
        </div>
    );
}

function FileChip({
    group,
    read,
    onOpen,
}: {
    group: RouteFileGroup;
    read: FileReadState;
    onOpen: (fileId: string) => void;
}) {
    const t = useT();
    const { count } = useFormat();
    return (
        <button
            type="button"
            className={`route-chip${read.state === 'read' ? ' is-read' : ''}`}
            title={t('route.fileChips.jump')}
            onClick={() => {
                onOpen(group.fileId);
            }}
        >
            <span className="route-chip__file">
                <span className="route-chip__name">{group.name}</span>
                {/*
                 * Полный путь — в тултипе: в чипе от него остаётся только хвост
                 * (docs/design/SPEC-elements.md §1.2). `bdi` изолирует каталоги от rtl-обрезки,
                 * как в дереве файлов, иначе порядок символов переворачивается.
                 */}
                <span className="route-chip__path" title={group.path}>
                    <bdi>{group.dir}</bdi>
                </span>
            </span>
            <span className="route-chip__add">+{count(group.additions)}</span>
            <span className="route-chip__del">−{count(group.deletions)}</span>
            {/* Тристейт коробки — общий `readStateOf`: тултип всегда несёт числа (docs/design/SPEC-elements.md §2.12). */}
            <span className={`route-chip__read route-chip__read--${read.state}`} title={readStateTooltip(t, read)}>
                {read.state === 'read' ? <Icon name="check" size={9} /> : null}
            </span>
        </button>
    );
}
