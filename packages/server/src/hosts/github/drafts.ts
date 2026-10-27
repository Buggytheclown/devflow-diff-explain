/**
 * Тело pending-ревью GitHub как набор абзацев — черновики уровня PR (`docs/architecture.md`,
 * «Хост-адаптеры», 2026-09-21). Своих черновиков уровня PR у GitHub нет: единственное место,
 * которое живёт до сабмита, — тело самого ревью, поэтому абзацы помечаются строкой-маркером
 * `<!-- devflow-diff-explain:draft <n> -->` (HTML-комментарий на GitHub не рендерится).
 *
 * Маркер даёт абзацу постоянный номер: удаление соседа не переименовывает остальных, и id
 * комментария переживает и правку, и публикацию. Функции чистые — состояния у них нет.
 */

const MARKER = /^<!--\s*devflow-diff-explain:draft\s+(\d+)\s*-->$/;

const SEPARATOR = '\n\n';

/**
 * Тело ревью, в котором нет ни одного абзаца. Пустым тело оставлять нельзя: ревью без тела
 * GitHub больше не даёт править («Could not edit a review with a missing body»), и дописать в
 * него черновик уже не выйдет. Тело из одной заглушки абзацев не даёт и наружу не выходит;
 * рядом с абзацами заглушка не пишется, поэтому внутри текста это обычная строка.
 */
export const BODY_PLACEHOLDER = '<!-- devflow-diff-explain:body -->';

export interface ReviewParagraph {
    /** Номер абзаца: монотонный внутри одного ревью, при удалении не переиспользуется. */
    readonly n: number;
    readonly body: string;
}

export interface ReviewBody {
    /** В теле есть маркеры Шерпы; `false` — тело писали на вебе GitHub. */
    readonly marked: boolean;
    readonly paragraphs: readonly ReviewParagraph[];
}

/**
 * Разбор тела ревью. Тело без маркеров — один абзац с номером 0: так его и правят, и показывают,
 * а маркер он получит при первой перезаписи.
 */
export function parseReviewBody(body: string): ReviewBody {
    if (body.trim() === BODY_PLACEHOLDER) {
        // Заглушка опознаётся только целым телом: рядом с абзацами её никто не пишет, а вырезать
        // такую же строку из текста ревьюера нельзя — текст пропал бы молча при первой же перезаписи.
        return { marked: false, paragraphs: [] };
    }

    const lines = body.split('\n');
    const paragraphs: ReviewParagraph[] = [];
    let marked = false;
    let current: { n: number; lines: string[] } | null = null;
    const leading: string[] = [];

    for (const line of lines) {
        const found = MARKER.exec(line.trim());
        if (found?.[1] === undefined) {
            (current?.lines ?? leading).push(line);
            continue;
        }

        marked = true;
        if (current !== null) {
            paragraphs.push({ n: current.n, body: current.lines.join('\n').trim() });
        }
        current = { n: Number(found[1]), lines: [] };
    }
    if (current !== null) {
        paragraphs.push({ n: current.n, body: current.lines.join('\n').trim() });
    }

    const head = leading.join('\n').trim();
    if (head !== '') {
        // Текст до первого маркера (или тело целиком, если маркеров нет) — абзац с номером 0.
        paragraphs.unshift({ n: 0, body: head });
    }
    return { marked, paragraphs: paragraphs.filter((paragraph) => paragraph.body !== '') };
}

/** Тело ревью из абзацев: маркер, текст, пустая строка между абзацами. Абзацев нет — заглушка. */
export function renderReviewBody(paragraphs: readonly ReviewParagraph[]): string {
    if (paragraphs.length === 0) {
        return BODY_PLACEHOLDER;
    }
    return paragraphs.map((paragraph) => `<!-- devflow-diff-explain:draft ${String(paragraph.n)} -->\n${paragraph.body}`).join(SEPARATOR);
}

/** Новый абзац в конец: номер — `максимум + 1`, чтобы не столкнуться с удалёнными. */
export function appendParagraph(body: string, text: string): { body: string; n: number } {
    const { paragraphs } = parseReviewBody(body);
    const n = paragraphs.reduce((max, paragraph) => Math.max(max, paragraph.n), 0) + 1;
    return { body: renderReviewBody([...paragraphs, { n, body: text }]), n };
}

/** Перезапись абзаца; null — такого номера в теле нет. */
export function replaceParagraph(body: string, n: number, text: string): string | null {
    const { paragraphs } = parseReviewBody(body);
    if (!paragraphs.some((paragraph) => paragraph.n === n)) {
        return null;
    }
    return renderReviewBody(
        paragraphs.map((paragraph) => (paragraph.n === n ? { n, body: text } : paragraph)),
    );
}

/** Удаление абзаца; null — такого номера в теле нет. После последнего в теле остаётся заглушка. */
export function removeParagraph(body: string, n: number): string | null {
    const { paragraphs } = parseReviewBody(body);
    if (!paragraphs.some((paragraph) => paragraph.n === n)) {
        return null;
    }
    return renderReviewBody(paragraphs.filter((paragraph) => paragraph.n !== n));
}
