import type { ChatExchange } from '@sherpa/protocol';

/** Старые вопросы без версии остаются видимыми, но не приписываются открытому коду. */
export function exchangesForReading(exchanges: readonly ChatExchange[], diffId: string | null, codeSnapshotId: string | null, pinned: boolean): ChatExchange[] {
    return exchanges.filter((exchange) => {
        const explanation = exchange.explanation;
        if (explanation != null) return explanation.diffId === diffId && (!pinned || explanation.codeSnapshotId === codeSnapshotId);
        return exchange.anchor === null || exchange.anchor.diffId === diffId;
    });
}
