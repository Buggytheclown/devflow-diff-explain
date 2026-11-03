/** Прежние синтетические данные остаются для галереи/истории; новая сессия сдаёт текущий вход. */
export function checkpointFixture(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const root = value as Record<string, unknown>;
    const onlyFlow = Object.keys(root).length === 1 && 'flow' in root;
    if (root.contractVersion !== 6 && !onlyFlow) return value;
    const evidence = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(evidence);
        if (item === null || typeof item !== 'object') return item;
        return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => {
            if (key === 'evidence' && child !== null && typeof child === 'object' && !Array.isArray(child) && 'claims' in child && Array.isArray(child.claims)) {
                const claims = child.claims as { sources: unknown[]; limitation: string | null }[];
                return [key, { sources: claims.flatMap((claim) => claim.sources), limitation: claims.map((claim) => claim.limitation ?? '').filter(Boolean).join('; ') || null }];
            }
            return [key, evidence(child)];
        }));
    };
    if (onlyFlow) return evidence({ contractVersion: 6, update: value });
    if ('summary' in root) return evidence({ contractVersion: 6, overview: value });
    if ('stops' in root && Array.isArray(root.stops)) {
        const { stops, ...rest } = root;
        return evidence({ ...rest, files: (stops as { files: unknown[] }[]).flatMap((block) => block.files) });
    }
    return evidence(value);
}

export function checkpointJson(value: unknown, _replacer?: unknown, space?: string | number): string {
    return JSON.stringify(checkpointFixture(value), null, space);
}
