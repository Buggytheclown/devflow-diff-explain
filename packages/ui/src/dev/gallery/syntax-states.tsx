import type { FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createDiffViewStore, fileCollapseReason } from '../../diff-view/store.js';
import { readStateOf } from '../../progress/read-state.js';
import { galleryActions } from './diff-states.tsx';
import '../../diff-view/diff-view.css';

/**
 * Подсветка синтаксиса на языках, которых нет в фикстурах: по карточке на язык из рукописного
 * ханка. Строки с `-`/`+` — удалённые и добавленные, остальные — контекст. Приёмка — глазами:
 * семантические категории и палитра Arcanum — docs/design/arcanum.md.
 */

interface Sample {
    readonly path: string;
    readonly lines: readonly string[];
}

const SAMPLES: readonly Sample[] = [
    {
        path: 'services/orders/src/domain/edit_policy.h',
        lines: [
            '#include <memory>',
            '#include "order/policy.h"',
            '',
            'namespace quillmart::orders {',
            '',
            '/**',
            ' * Edit window policy: an order stays editable for 30 minutes',
            '-* after checkout.',
            '+* after checkout unless the courier has been dispatched.',
            ' */',
            'class EditPolicy final {',
            'public:',
            '    explicit EditPolicy(std::chrono::minutes window = std::chrono::minutes{30}) : window_(window) {}',
            '',
            '    [[nodiscard]] bool Editable(const Order& order, TimePoint now) const noexcept {',
            '+        if (order.dispatched_at.has_value()) {',
            '+            return false;  // dispatch wins',
            '+        }',
            '        return now - order.checkout_at < window_;',
            '    }',
            '',
            'private:',
            '    std::chrono::minutes window_;',
            '-    static constexpr auto kReason = "edit_window";',
            '+    static constexpr auto kReason = "edit-window";',
            '+    inline static const std::string kLabel = R"(raw "string")";',
            '};',
            '',
            '}  // namespace quillmart::orders',
        ],
    },
    {
        path: 'services/orders/src/domain/EditPolicy.kt',
        lines: [
            'package quillmart.orders.domain',
            '',
            'import kotlin.time.Duration.Companion.minutes',
            '',
            '/** Edit window policy. */',
            '@Serializable',
            'data class EditPolicy(val window: Duration = 30.minutes) {',
            '',
            '    fun editable(order: Order, now: Instant): Boolean {',
            '+        if (order.dispatchedAt != null) return false // dispatch wins',
            '        return now - order.checkoutAt < window',
            '    }',
            '',
            '-    fun reason(order: Order): String? = null',
            '+    suspend fun reason(order: Order): String? = when {',
            '+        order.dispatchedAt != null -> "dispatched at ${order.dispatchedAt}"',
            '+        else -> null',
            '+    }',
            '',
            '    companion object {',
            '        const val LABEL = "edit-window"',
            '        private val log = LoggerFactory.getLogger(EditPolicy::class.java)',
            '    }',
            '}',
        ],
    },
    {
        path: 'services/orders/src/domain/edit_policy.py',
        lines: [
            'from dataclasses import dataclass',
            'from datetime import datetime, timedelta',
            '',
            '',
            '@dataclass(frozen=True)',
            'class EditPolicy:',
            '    """Single source of truth for "can this order still be edited"."""',
            '',
            '    window: timedelta = timedelta(minutes=30)',
            '',
            '    def editable(self, order: Order, now: datetime) -> bool:',
            '+        if order.dispatched_at is not None:',
            '+            return False  # dispatch wins',
            '-        return now - order.checkout_at < self.window',
            '+        return now - order.checkout_at < self.window * 1.0',
            '',
            '    @property',
            '    def label(self) -> str:',
            '        return f"edit-window:{self.window.seconds}s"',
        ],
    },
    {
        path: 'services/orders/internal/policy/edit_policy.go',
        lines: [
            'package policy',
            '',
            'import (',
            '\t"fmt"',
            '\t"time"',
            ')',
            '',
            '// EditPolicy is the single source of truth for "can this order still be edited".',
            'type EditPolicy struct {',
            '\tWindow time.Duration',
            '}',
            '',
            'func (p EditPolicy) Editable(order Order, now time.Time) (bool, error) {',
            '+\tif order.DispatchedAt != nil {',
            '+\t\treturn false, nil // dispatch wins',
            '+\t}',
            '\tif order.CheckoutAt.IsZero() {',
            '-\t\treturn false, fmt.Errorf("order %s has no checkout time", order.ID)',
            '+\t\treturn false, fmt.Errorf("order %q has no checkout time", order.ID)',
            '\t}',
            '\treturn now.Sub(order.CheckoutAt) < p.Window, nil',
            '}',
        ],
    },
    {
        path: 'services/orders/src/domain/edit_policy.rs',
        lines: [
            'use std::time::Duration;',
            '',
            '/// Edit window policy.',
            '#[derive(Debug, Clone)]',
            'pub struct EditPolicy {',
            '    pub window: Duration,',
            '}',
            '',
            'impl EditPolicy {',
            '    pub fn editable(&self, order: &Order, now: Instant) -> bool {',
            '+        if order.dispatched_at.is_some() {',
            '+            return false; // dispatch wins',
            '+        }',
            '-        now - order.checkout_at < self.window',
            '+        now.duration_since(order.checkout_at) < self.window',
            '    }',
            '',
            "    pub const LABEL: &'static str = \"edit-window\";",
            '}',
        ],
    },
    {
        path: 'services/orders/src/main/java/EditPolicy.java',
        lines: [
            'package quillmart.orders.domain;',
            '',
            'import java.time.Duration;',
            '',
            '/** Edit window policy. */',
            'public final class EditPolicy {',
            '    private static final Duration WINDOW = Duration.ofMinutes(30);',
            '',
            '    @Override',
            '    public boolean editable(Order order, Instant now) {',
            '+        if (order.dispatchedAt() != null) {',
            '+            return false; // dispatch wins',
            '+        }',
            '-        return Duration.between(order.checkoutAt(), now).compareTo(WINDOW) < 0;',
            '+        return Duration.between(order.checkoutAt(), now).compareTo(WINDOW) <= 0;',
            '    }',
            '}',
        ],
    },
    {
        path: 'services/orders/scripts/rollout.sh',
        lines: [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            '',
            '# Roll the edit-window policy out to one region at a time.',
            'for dc in eu-west us-east; do',
            '-    echo "rolling $dc"',
            '+    echo "rolling ${dc} at $(date +%s)" # log',
            '    ./scripts/deploy.sh --region "$dc" --service orders',
            'done',
        ],
    },
    {
        path: 'services/orders/deploy/service.yaml',
        lines: [
            '# checkout service',
            'name: checkout',
            '-replicas: 3',
            '+replicas: 4',
            'enabled: true',
            'args:',
            '  - "--edit-window=30m"',
            '+  - --log-level=info',
        ],
    },
    {
        path: 'services/orders/package.json',
        lines: [
            '{',
            '  "name": "@quillmart/orders",',
            '  "private": true,',
            '-  "editWindowMs": 1800000,',
            '+  "editWindowMs": 1800000,',
            '+  "dispatchWins": true,',
            '  "port": 8080',
            '}',
        ],
    },
    {
        path: 'services/orders/api/order.proto',
        lines: [
            'syntax = "proto3";',
            '',
            'package quillmart.orders;',
            '',
            'message Order {',
            '  int64 id = 1; // primary key',
            '  google.protobuf.Timestamp checkout_at = 2;',
            '+  optional google.protobuf.Timestamp dispatched_at = 3;',
            '}',
        ],
    },
];

/** Ханк из рукописных строк: `-`/`+` — стороны, остальное — контекст. */
function patchOf(lines: readonly string[]): string {
    let oldCount = 0;
    let newCount = 0;
    const body = lines.map((line) => {
        if (line.startsWith('-')) {
            oldCount += 1;
            return line;
        }
        if (line.startsWith('+')) {
            newCount += 1;
            return line;
        }
        oldCount += 1;
        newCount += 1;
        return ` ${line}`;
    });
    return [`@@ -1,${String(oldCount)} +1,${String(newCount)} @@`, ...body, ''].join('\n');
}

function fileOf(sample: Sample, index: number): FileDiff {
    return {
        fileId: `syntax-${String(index)}`,
        path: sample.path,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: sample.lines.filter((line) => line.startsWith('+')).length,
        deletions: sample.lines.filter((line) => line.startsWith('-')).length,
        patch: patchOf(sample.lines),
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
    };
}

function SampleCard({ file }: { file: FileDiff }) {
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: [file] });
        created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        return created;
    }, [file]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const actions = useMemo(() => galleryActions(store), [store]);

    return (
        <FileCard
            file={file}
            model={snapshot.models.get(file.fileId) ?? null}
            mode={snapshot.effectiveMode}
            content={snapshot.content.get(file.fileId)}
            contentAvailable={false}
            expansion={snapshot.expansion.get(file.fileId) ?? new Map()}
            read={readStateOf({ file, record: null })}
            collapseReason={fileCollapseReason(snapshot, file)}
            onToggleCollapse={() => {
                store.toggleFileCollapse(file.fileId);
            }}
            opened={snapshot.opened.has(file.fileId)}
            showWhitespace={false}
            markdown={false}
            keptInView={false}
            initialHint={null}
            initialGapError={false}
            selection={snapshot.selection}
            actions={actions}
        />
    );
}

const FILES = SAMPLES.map(fileOf);

export interface SyntaxGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const SYNTAX_STATES: readonly SyntaxGalleryState[] = [
    {
        id: 'syntax-all',
        title: 'все образцы подряд',
        render: () => (
            <>
                {FILES.map((file) => (
                    <SampleCard key={file.fileId} file={file} />
                ))}
            </>
        ),
    },
    ...FILES.map((file) => ({
        id: `syntax-${file.path.slice(file.path.lastIndexOf('.') + 1)}`,
        title: file.path.slice(file.path.lastIndexOf('/') + 1),
        render: () => <SampleCard file={file} />,
    })),
];
