/** Порядковая подпоследовательность без учёта регистра. */
export function fuzzyMatch(text: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
        return true;
    }

    let index = 0;
    for (const char of text.toLowerCase()) {
        if (char === needle[index]) {
            index += 1;
            if (index === needle.length) {
                return true;
            }
        }
    }
    return false;
}
