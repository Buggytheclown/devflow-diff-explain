/**
 * Состояние адресной строки живёт во фрагменте URL в формате `URLSearchParams`:
 * `#t=<токен>&view=route`. Старый `token` читается для совместимости с живыми серверами.
 * Фрагмент не уходит на сервер, не попадает в логи и переживает
 * перезагрузку — поэтому в нём и токен доступа (docs/protocol.md §8), и то, что должно вернуться
 * после F5: активная вью, дальше — фильтр (docs/design/SPEC-elements.md §2.7) и прочие параметры вью.
 *
 * Разбор общий: новые параметры кладутся в тот же формат, механизм не меняется.
 */

export function parseFragment(hash: string): URLSearchParams {
    return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** `null` — параметра нет или он пустой; пустая строка значением не считается. */
export function readFragmentParam(hash: string, name: string): string | null {
    const value = parseFragment(hash).get(name);
    return value === null || value === '' ? null : value;
}

export function readToken(hash: string): string | null {
    return readFragmentParam(hash, 't') ?? readFragmentParam(hash, 'token');
}

/**
 * Новый фрагмент с применённой правкой: `null` в значении убирает параметр.
 * Порядок остальных параметров сохраняется — токен как был первым, так и остаётся.
 */
export function updateFragment(hash: string, patch: Readonly<Record<string, string | null>>): string {
    let params = parseFragment(hash);

    if (Object.hasOwn(patch, 't')) {
        params.delete('token');
    } else if (Object.hasOwn(patch, 'token')) {
        params.delete('t');
    } else if (params.has('t')) {
        params.delete('token');
    }

    for (const [name, value] of Object.entries(patch)) {
        if (value === null) {
            params.delete(name);
        } else {
            params.set(name, value);
        }
    }
    if (params.has('t')) {
        params.delete('token');
    }

    const tokenName = params.has('t') ? 't' : params.has('token') ? 'token' : null;
    if (tokenName !== null) {
        const ordered = new URLSearchParams([[tokenName, params.get(tokenName) ?? '']]);
        for (const [name, value] of params) {
            if (name !== tokenName) {
                ordered.append(name, value);
            }
        }
        params = ordered;
    }

    const next = params.toString();
    return next === '' ? '' : `#${next}`;
}
