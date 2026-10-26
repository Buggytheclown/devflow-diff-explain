import type { Locale } from '@sherpa/protocol';

/**
 * Серверные строки, которые попадают в снапшот и читаются ревьюером: заголовок
 * синтетического стопа, пометки валидатора и причины провала генерации. Они часть маршрута,
 * поэтому говорят на языке генерации, а не на языке вкладки: снапшот целиком одноязычен.
 *
 * Таблица маленькая и живёт здесь целиком — библиотека локализации ради двух десятков строк
 * не заводится — словарь UI тоже свой. Логи и stderr сюда не входят:
 * их читаем мы, а не ревьюер.
 */
export interface RouteStrings {
    /** Заголовок синтетического стопа: его добавляет сервер, модель про него не знает. */
    readonly otherStopTitle: string;
    /** Якорь ведёт в файл, которого нет в диффе. */
    anchorFileMissing(path: string): string;
    /** Якорь стоит на строках, которых правка не касалась. */
    anchorNotChanged(path: string, span: string): string;
    /** Диапазон целиком забрал стоп, сдавшийся раньше. */
    rangeTaken(path: string, span: string, stopLabel: string): string;
    /** Часть диапазона забрал стоп, сдавшийся раньше. */
    rangeTrimmed(path: string, span: string, stopLabel: string): string;
    /** Утверждения дайджеста, чьи якоря ведут в файлы вне диффа. */
    claimsMissingFiles(paths: readonly string[]): string;
    /** Утверждения дайджеста без якоря на тест. */
    claimsAnchorless(count: number): string;
    /** Причина изменения у стопа, которого пуш не касался. */
    readonly changeReasonDropped: string;
    /** Ссылка на тред, которого сервер не добывал. */
    unknownThread(id: string): string;
    /** Заполнение остановки отменено вместе с задачей. */
    readonly stopFillCancelled: string;
    /** Задача заполнения провалилась; `reason` — то, что назвал агент. */
    stopFillFailed(reason: string | null): string;
    /** Задача закрыта успешно, а слот остался пустым. */
    readonly stopMissingInResult: string;
    /** Скелет не построен; `reason` — то, что назвал агент. */
    skeletonFailed(reason: string): string;
    /** Скелет принимался, но применить его результат не вышло ни разу. */
    skeletonNotApplied(attempts: number): string;
    /** Патча итерации, на которой построен маршрут, больше нет. */
    lostDiff(diffId: string): string;
}

const RU: RouteStrings = {
    otherStopTitle: 'Прочее — модель не разместила эти строки',
    anchorFileMissing: (path) => `Якорь на \`${path}\` отброшен: файла нет в этом диффе.`,
    anchorNotChanged: (path, span) =>
        `Якорь на \`${path}\` (строки ${span}) отброшен: в этом диапазоне ничего не менялось.`,
    rangeTaken: (path, span, stopLabel) => `Диапазон \`${path}\` ${span} уже объяснён в стопе ${stopLabel}.`,
    rangeTrimmed: (path, span, stopLabel) =>
        `Часть диапазона \`${path}\` ${span} уже объяснена в стопе ${stopLabel} — якорь урезан.`,
    claimsMissingFiles: (paths) => {
        const unique = [...new Set(paths)];
        const list = unique.map((path) => `\`${path}\``).join(', ');
        const lead = unique.length === 1 ? 'якорь вёл в' : 'якоря вели в';
        const tail = unique.length === 1 ? 'которого нет в этом диффе' : 'этих файлов нет в этом диффе';
        return `${droppedClaimsPrefixRu(paths.length)}: ${lead} ${list}, ${tail}.`;
    },
    claimsAnchorless: (count) => `${droppedClaimsPrefixRu(count)}: якорь на тест не указан.`,
    changeReasonDropped: 'Причина изменения отброшена: остановка не менялась с прошлого захода.',
    unknownThread: (id) => `Ссылка на неизвестный тред ${id} удалена.`,
    stopFillCancelled: 'Заполнение этой остановки отменено.',
    stopFillFailed: (reason) =>
        `Остановка осталась незаполненной: ${reason ?? 'агент не назвал причину'}`,
    stopMissingInResult: 'Агент сдал результат без этой остановки — слот остался незаполненным.',
    skeletonFailed: (reason) =>
        reason === ''
            ? 'Агент не построил план маршрута и не назвал причину.'
            : `Агент не построил план маршрута: ${reason}`,
    skeletonNotApplied: (attempts) =>
        `Маршрут не собрался: сервер ${String(attempts)} раза ставил задачу на план и ни разу не смог ` +
        'применить её результат.',
    lostDiff: (diffId) =>
        `Дифф итерации ${diffId}, на которой построен этот маршрут, недоступен: хост её больше ` +
        'не отдаёт, а локальной копии нет. Постройте маршрут заново.',
};

const EN: RouteStrings = {
    otherStopTitle: 'Other — lines the model did not place',
    anchorFileMissing: (path) => `Anchor on \`${path}\` dropped: the file is not in this diff.`,
    anchorNotChanged: (path, span) =>
        `Anchor on \`${path}\` (lines ${span}) dropped: nothing changed in that range.`,
    rangeTaken: (path, span, stopLabel) => `Range \`${path}\` ${span} is already explained by stop ${stopLabel}.`,
    rangeTrimmed: (path, span, stopLabel) =>
        `Part of range \`${path}\` ${span} is already explained by stop ${stopLabel} — the anchor was trimmed.`,
    claimsMissingFiles: (paths) => {
        const unique = [...new Set(paths)];
        const list = unique.map((path) => `\`${path}\``).join(', ');
        const tail =
            unique.length === 1
                ? `the anchor pointed at ${list}, which is not in this diff`
                : `the anchors pointed at ${list}, and those files are not in this diff`;
        return `${droppedClaimsPrefixEn(paths.length)}: ${tail}.`;
    },
    claimsAnchorless: (count) => `${droppedClaimsPrefixEn(count)}: no test anchor given.`,
    changeReasonDropped: 'Change reason dropped: this stop did not move since the previous route.',
    unknownThread: (id) => `Link to unknown thread ${id} removed.`,
    stopFillCancelled: 'Filling of this stop was cancelled.',
    stopFillFailed: (reason) => `The stop was left unfilled: ${reason ?? 'the agent named no reason'}`,
    stopMissingInResult: 'The agent returned a result without this stop — the slot stayed empty.',
    skeletonFailed: (reason) =>
        reason === ''
            ? 'The agent did not plan the route and named no reason.'
            : `The agent did not plan the route: ${reason}`,
    skeletonNotApplied: (attempts) =>
        `The route did not come together: the server queued the plan ${String(attempts)} times and never ` +
        'managed to apply the result.',
    lostDiff: (diffId) =>
        `The diff of iteration ${diffId}, the one this route was built on, is gone: the host no longer ` +
        'serves it and there is no local copy left. Build the route again.',
};

const TABLE: Record<Locale, RouteStrings> = { ru: RU, en: EN };

export function routeStrings(locale: Locale): RouteStrings {
    return TABLE[locale];
}

/** Русское числительное для пометки ревьюеру: «Два утверждения отброшены», «7 утверждений отброшено». */
function droppedClaimsPrefixRu(count: number): string {
    const words = ['', 'Одно', 'Два', 'Три', 'Четыре'];
    const head = words[count] ?? String(count);
    const teen = count % 100 >= 11 && count % 100 <= 14;
    const last = count % 10;
    if (!teen && last === 1) {
        return `${head} утверждение отброшено`;
    }
    if (!teen && last >= 2 && last <= 4) {
        return `${head} утверждения отброшены`;
    }
    return `${head} утверждений отброшено`;
}

function droppedClaimsPrefixEn(count: number): string {
    return count === 1 ? 'One claim dropped' : `${String(count)} claims dropped`;
}
