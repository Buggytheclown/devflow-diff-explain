/**
 * Копирование в буфер обмена одной функцией: `navigator.clipboard` есть не везде (в небезопасном
 * контексте его нет вовсе), а запись отклоняется, если вкладка потеряла фокус или ревьюер
 * отказал в разрешении. Оба случая — деградация с человеческой подсказкой, а не исключение.
 */

export type CopyOutcome = 'copied' | 'failed' | 'unavailable';

export async function copyText(text: string): Promise<CopyOutcome> {
    const clipboard = (navigator as unknown as { readonly clipboard?: Pick<Clipboard, 'writeText'> }).clipboard;
    if (clipboard === undefined) {
        return 'unavailable';
    }
    try {
        await clipboard.writeText(text);
        return 'copied';
    } catch {
        return 'failed';
    }
}
