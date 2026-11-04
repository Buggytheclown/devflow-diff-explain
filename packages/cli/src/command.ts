import path from 'node:path';

/** Команда standalone CLI с shell quoting, без зависимости от алиаса в PATH. */
export function formatCommand(entry: string | undefined, ...args: readonly string[]): string {
    if (entry === undefined || entry.trim() === '') {
        throw new Error('The Devflow Diff Explain CLI entry path is unavailable.');
    }
    return `node ${[path.resolve(entry), ...args].map(shellQuote).join(' ')}`;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
