import type { Locale } from '@sherpa/protocol';
import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { sectionGuide, sectionInstructions, skeletonGuide, skeletonInstructions } from './route-prompts.js';

/**
 * Регрессия поведенческих правил воркера: короткая инструкция задачи обязана говорить,
 * что валидирует сервер, и запрещать самопроверку с установкой пакетов — иначе воркер молча
 * не сдаёт готовый результат.
 *
 * Плюс язык генерации: методичка обязана требовать ровно один язык ответа и называть
 * ровно те стоп-фразы, за которые сервер отказывает.
 */
const instructions = [skeletonInstructions('ru'), sectionInstructions('ru', [2, 3])];

const LOCALES: readonly Locale[] = ['ru', 'en'];

function guides(locale: Locale): string[] {
    return [skeletonGuide(locale), sectionGuide(locale)];
}

describe('инструкции задач маршрута', () => {
    it('говорят, что схему проверяет сервер, и запрещают самопроверку с установкой', () => {
        for (const text of instructions) {
            expect(text).toContain('checked by the server');
            expect(text).toContain('do not validate the result yourself');
            expect(text).toContain('do not\ninstall anything');
            expect(text).toContain('always submit what you produced');
        }
    });
});

describe('инструкции перегенерации', () => {
    const files = { interdiff: true, previousRoute: true, threadsSince: true };

    it('перечисляют контекст второго захода по факту', () => {
        for (const text of [skeletonInstructions('ru', files), sectionInstructions('ru', [2], files)]) {
            expect(text).toContain('interdiff.md');
            expect(text).toContain('previous-route.md');
            expect(text).toContain('threads-since.md');
        }
    });

    it('первая генерация о втором заходе не знает и среза не поминает', () => {
        for (const text of instructions) {
            expect(text).not.toContain('previous-route.md');
            expect(text).not.toContain('rebuild');
            expect(text).not.toContain('interdiff');
            expect(text).not.toContain('pushed since');
        }
    });

    it('перегенерация на той же итерации: срез не назван, пуш не объявлен', () => {
        const text = sectionInstructions('ru', [2], { ...files, interdiff: false });

        expect(text).not.toContain('interdiff');
        expect(text).not.toContain('pushed since');
        expect(text).toContain('previous-route.md');
        expect(text).toContain('the code has not\nmoved since');
    });
});

describe('методички маршрута', () => {
    it('отказ валидатора — нормальный ход цикла, молча не сдать нельзя', () => {
        for (const locale of LOCALES) {
            for (const guide of guides(locale)) {
                expect(guide).toContain('The server is the only validator.');
                expect(guide).toContain('Never end the task silently');
                expect(guide).toContain('devflow-diff-explain task fail <id> --reason <text>');
                expect(guide).toContain('do\nnot install validators or packages');
            }
        }
    });

    it('правило общего контекста: файлы под `shared/` читаются один раз за сессию', () => {
        for (const text of [...instructions, ...guides('ru'), ...guides('en')]) {
            expect(text).toContain('shared/');
            expect(text).toContain('once');
        }
    });

    it('второй заход описан обеим ролям: план сохраняется, причина — только у затронутых стопов', () => {
        for (const locale of LOCALES) {
            const [skeleton, section] = guides(locale);
            expect(skeleton).toContain('## Rebuilding an existing route');
            expect(skeleton).toContain('Keep the plan, its order and its titles wherever the code did not change');
            // Оба случая описаны: пуш был и пуша не было — методичка общая на все задачи.
            expect(skeleton).toContain('**With `interdiff.md`**');
            expect(skeleton).toContain('**Without `interdiff.md`** — the code has not moved');
            expect(section).toContain('## Why this stop changed');
            expect(section).toContain('changeReason');
            expect(section).toContain('[thread:<id>]');
            expect(section).toContain('you never declare the kind, only the reason');
        }
    });

    it('словарь разметки описания: разрешённое, запреты и бюджет названы числом валидатора', () => {
        for (const locale of LOCALES) {
            const [, section] = guides(locale);
            expect(section).toContain('## The stop description: markup and budget');
            expect(section).toContain('`- ` for a bullet, `1. ` for a numbered one — **at most 4 items**');
            expect(section).toContain(
                'Never: headings, nested list items, several paragraphs in one list item, code blocks (fenced or\nindented), tables, images, block quotes, italics, strikethrough, horizontal rules, reference-style\nlinks (`[label]: url`).',
            );
            expect(section).toContain('After a list a closing paragraph is mandatory');
            expect(section).toContain(`**Budget: ${String(STOP_PARAGRAPH_MAX_CHARS)} characters of visible text`);
            expect(section).toContain('Link addresses and markup');
            expect(section).toContain('`#stop-<planIndex>`');
            expect(section).toContain('`#file-<path>`');
            expect(section).toContain('Only these addresses\n  are accepted');
        }
    });

    it('summary пишется тем же словарём, что описание остановки, но без бюджета длины', () => {
        for (const locale of LOCALES) {
            const [skeleton] = guides(locale);
            expect(skeleton).toContain('## The summary: markup');
            expect(skeleton).toContain('`- ` for a bullet, `1. ` for a numbered one — **at most 4 items**');
            expect(skeleton).toContain(
                'Never: headings, nested list items, several paragraphs in one list item, code blocks (fenced or\nindented), tables, images, block quotes, italics, strikethrough, horizontal rules, reference-style\nlinks (`[label]: url`).',
            );
            expect(skeleton).toContain('Only these addresses\n  are accepted');
            expect(skeleton).toContain('`#stop-<planIndex>` is a plan number of this very plan');
            expect(skeleton).not.toContain('**Budget:');
            expect(skeleton).not.toContain(String(STOP_PARAGRAPH_MAX_CHARS));
        }
    });

    it('голос: стоп-лист фраз назван и помечен как отклоняемый сервером', () => {
        for (const guide of guides('ru')) {
            expect(guide).toContain('«важно отметить»');
            expect(guide).toContain('The server rejects texts containing these.');
            expect(guide).toContain('No emoji (the server rejects them)');
        }
        for (const guide of guides('en')) {
            expect(guide).toContain('"it is worth noting"');
            expect(guide).toContain('The server rejects texts containing these.');
            expect(guide).toContain('No emoji (the server rejects them)');
        }
    });
});

describe('язык генерации в промптах', () => {
    it('русская методичка требует русский ответ во всех полях результата', () => {
        const [skeleton, section] = guides('ru');
        expect(skeleton).toContain('**Write in Russian.**');
        expect(skeleton).toContain('a short overview of the whole pull request in Russian');
        expect(skeleton).toContain('conceptual, in Russian');
        expect(skeleton).toContain('one or two sentences in Russian');
        expect(section).toContain('2 to 4 sentences in Russian');
        expect(section).toContain('one sentence in Russian');
        expect(section).toContain('1 to 3 sentences in Russian');
        expect(section).toContain('behaviour, in Russian');
    });

    it('английская методичка требует английский ответ и русского не поминает', () => {
        const [skeleton, section] = guides('en');
        expect(skeleton).toContain('**Write in English.**');
        expect(skeleton).toContain('a short overview of the whole pull request in English');
        expect(section).toContain('2 to 4 sentences in English');
        expect(section).toContain('behaviour, in English');
        for (const guide of [skeleton, section]) {
            expect(guide).not.toContain('in Russian');
        }
    });

    it('правило против транслита — только у русской методички', () => {
        for (const guide of guides('ru')) {
            expect(guide).toContain('jargon transliterated into Russian');
            expect(guide).toContain('коалесинг');
        }
        for (const guide of guides('en')) {
            expect(guide).not.toContain('transliterated');
        }
    });

    it('стоп-фразы методички — на локали генерации и без чужих', () => {
        for (const guide of guides('ru')) {
            expect(guide).not.toContain('it is worth noting');
        }
        for (const guide of guides('en')) {
            expect(guide).not.toContain('важно отметить');
        }
    });

    it('короткие инструкции называют язык ответа', () => {
        expect(skeletonInstructions('en')).toContain('in English');
        expect(sectionInstructions('en', [1])).toContain('in English');
        expect(skeletonInstructions('ru')).toContain('in Russian');
        expect(sectionInstructions('ru', [1])).toContain('in Russian');
    });
});
