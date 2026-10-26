/**
 * Детерминированные генераторы содержимого для объёмных фикстур (`large`, лок-файл `medium`).
 * Хранить мегабайты текста в репозитории незачем, но результат обязан быть стабильным между
 * запусками: всё считается из индекса строки, никакого состояния и никакой случайности.
 */

const IDENTIFIERS = [
    'orderId',
    'deliverySlot',
    'editWindow',
    'cutoffAt',
    'policy',
    'clock',
    'auditTrail',
    'paymentToken',
    'shipment',
    'reservation',
    'basket',
    'timeline',
];

const TS_STATEMENTS = [
    'const {name} = await this.repository.load(request.orderId);',
    'if ({name} === null) {',
    '    throw new OrderNotFound(request.orderId);',
    '}',
    'const deadline = this.clock.now().getTime() + EDIT_WINDOW_MS;',
    'this.logger.debug(`{name} resolved`, { orderId: request.orderId });',
    'if (!policy.allows({name})) {',
    '    return { allowed: false, reason: "edit-window-closed" } as const;',
    '}',
    'metrics.increment("checkout.edit_window.{name}");',
    'return { allowed: true, deadline } as const;',
];

/** Имя из банка по индексу — одинаковое при каждом прогоне. */
function identifierAt(index: number): string {
    const name = IDENTIFIERS[index % IDENTIFIERS.length];
    return name ?? 'value';
}

function statementAt(index: number): string {
    const statement = TS_STATEMENTS[index % TS_STATEMENTS.length];
    return (statement ?? 'return null;').replace('{name}', identifierAt(index));
}

/** `count` строк правдоподобного TS с заданным префиксом ханка (' ', '+' или '-'). */
export function tsLines(prefix: string, count: number, offset = 0): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
        lines.push(`${prefix}    ${statementAt(offset + i)}`);
    }
    return lines;
}

/**
 * Строка неизменённого контекста файла `path` под номером `line` — та, что лежит за пределами
 * ханков и достаётся только через «Expand context». Считается из номера строки, поэтому у
 * двух обращений результат один и тот же, а у двух версий файла неизменённые куски совпадают
 * (вызывающий передаёт номер строки одной стороны для обеих).
 */
export function contextLineAt(path: string, line: number): string {
    if (path.endsWith('.yaml') || path.endsWith('.yml')) {
        return lockLines(' ', 1, line)[0]?.slice(1) ?? '';
    }
    if (path.endsWith('.md')) {
        return line % 4 === 0 ? '' : `- ${identifierAt(line)}: see the checkout runbook.`;
    }
    if (path.endsWith('CODEOWNERS')) {
        return line % 4 === 0
            ? ''
            : `/services/orders/src/${identifierAt(line)}/ @quillmart/checkout-${identifierAt(line + 1).toLowerCase()}`;
    }
    return tsLines(' ', 1, line)[0]?.slice(1) ?? '';
}

/** Строки pnpm-лока: их всегда много, читать их никто не будет — важна только форма. */
export function lockLines(prefix: string, count: number, offset = 0): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
        const index = offset + i;
        if (index % 3 === 0) {
            lines.push(`${prefix}  /@checkout/${identifierAt(index)}@1.${String(index % 40)}.${String(index % 7)}:`);
        } else if (index % 3 === 1) {
            lines.push(`${prefix}    resolution: {integrity: sha512-${index.toString(16).padStart(8, '0')}}`);
        } else {
            lines.push(`${prefix}    dev: ${index % 2 === 0 ? 'true' : 'false'}`);
        }
    }
    return lines;
}
