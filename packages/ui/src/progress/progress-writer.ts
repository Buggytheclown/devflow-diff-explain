import type {
    UiFileProgress,
    UiReviewProgressResponse,
    UiSeenRange,
    UiStopProgress,
    UiStopSeenRange,
} from '@sherpa/protocol';

import { changeSeenRanges } from './read-state.js';

/**
 * Координация отметок «просмотрено»: оптимистичная запись, единая очередь записей,
 * откат сорвавшейся и слияние перечитанного снимка с тем, что ручка могла не застать.
 * Чистый модуль — стор и сеть приходят колбэками, React здесь не участвует.
 *
 * Отметки файлов и остановок ведёт один writer: ревизия прогресса у них общая, и раздельные
 * счётчики «применённого» разъезжались бы между собой на первой же чужой записи.
 *
 * Ревизия прогресса общая на все вкладки, поэтому применённой считается та, что пришла ответом
 * ручки прогресса; своя запись двигает её, только когда следует за применённой без разрыва —
 * иначе между ними чужая отметка, и снимок надо перечитать. Ревизия монотонна лишь в пределах
 * одной жизни сервера: после перезапуска она начинается с нуля, и меньший номер — не устаревший
 * ответ, а новый сервер.
 */

/** Отметка остановки: серверная истина у неё та же, а оптимистичное состояние — один флаг. */
export interface StopWriterHooks {
    /** Текущая отметка остановки в сторе; `null` — записи нет (остановка не просмотрена). */
    readonly read: (stopId: string) => boolean | null;
    readonly apply: (stopId: string, viewed: boolean) => void;
    readonly restore: (stopId: string, viewed: boolean | null) => void;
    /** Запись в ручку вместе с посчитанными UI диапазонами; в ответе — ревизия прогресса. */
    readonly send: (stopId: string, viewed: boolean, ranges: readonly UiStopSeenRange[]) => Promise<number>;
}

/**
 * Отметка файла внутри остановки: диапазоны карточки вместо пина файла. Откат — через
 * `ProgressWriterOptions.restore` и `StopWriterHooks.restore`.
 */
export interface StopFileWriterHooks {
    readonly apply: (fileId: string, change: 'add' | 'remove', ranges: readonly UiSeenRange[]) => void;
    readonly send: (stopId: string, fileId: string, viewed: boolean, ranges: readonly UiSeenRange[]) => Promise<number>;
}

export interface ProgressWriterOptions {
    readonly initialRevision: number;
    /** Текущая запись файла в сторе: поверх неё переигрываются записи при откате. */
    readonly read: (fileId: string) => UiFileProgress | null;
    /** Оптимистичная отметка в сторе — отклик контрола не ждёт сети (docs/design/SPEC-elements.md §1.2). */
    readonly apply: (fileId: string, viewed: boolean) => void;
    readonly restore: (fileId: string, record: UiFileProgress | null) => void;
    /** Запись в ручку; в ответе — ревизия прогресса после неё. */
    readonly send: (fileId: string, viewed: boolean) => Promise<number>;
    readonly stops: StopWriterHooks;
    readonly stopFiles: StopFileWriterHooks;
    /** Запись завершилась: вью пересматривает отложенное решение о перечитке. */
    readonly onSettled: () => void;
}

/** Слитый снимок прогресса: то, что приехало с сервера, поверх незастанных им записей. */
export interface MergedProgress {
    readonly files: readonly UiFileProgress[];
    readonly stops: readonly UiStopProgress[];
}

export interface ProgressWriter {
    /** Отметка файла: в стор сразу, в ручку — в очереди писателя. `false` — запись сорвалась. */
    readonly write: (fileId: string, viewed: boolean) => Promise<boolean>;
    /** Отметка остановки вместе с её seen-диапазонами. `false` — запись сорвалась. */
    readonly writeStop: (
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => Promise<boolean>;
    /**
     * Отметка файла внутри остановки: строки карточки `ranges` сразу добавляются к записи файла
     * или вычитаются из неё, снятие ещё снимает отметку остановки в сторе. `false` — запись сорвалась.
     */
    readonly writeStopFile: (
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ) => Promise<boolean>;
    /**
     * Стоит ли перечитывать ручку по событию с этой ревизией. `null` — ревизии из канала ещё
     * не видели; перечитка всё равно нужна, если её просит своя запись с seen-диапазонами.
     */
    readonly shouldReload: (revision: number | null) => boolean;
    /** Метка начала перечитки: записи после неё ответ ручки уже мог не застать. */
    readonly beginReload: () => number;
    /**
     * Ответ ручки, дополненный незастанными записями. Про итерацию ответа писатель не знает:
     * сверяет её с нарисованным диффом вызывающий, до этого вызова.
     */
    readonly finishReload: (
        response: Pick<UiReviewProgressResponse, 'files' | 'stops' | 'progressRevision'>,
        mark: number,
    ) => MergedProgress;
}

/**
 * Отметка, которую снимок сервера ещё мог не застать: в полёте или уже принятая ручкой.
 * Одна запись может касаться и файла, и остановки — снятие в карточке снимает отметку остановки.
 */
interface Write {
    readonly seq: number;
    /** Ручка ответила успехом. */
    done: boolean;
    readonly file: { readonly id: string; readonly change: (record: UiFileProgress | null) => UiFileProgress } | null;
    readonly stop: { readonly id: string; readonly viewed: boolean } | null;
}

const noop = (): void => undefined;

export function createProgressWriter(options: ProgressWriterOptions): ProgressWriter {
    /**
     * Записи поверх последнего известного серверного состояния, по порядку постановки. На экране
     * у файла или остановки — база с переигранными записями, которые его касаются; сорвавшаяся
     * запись выпадает, и экран переигрывается без неё. Откат к снимку, снятому при постановке,
     * тут не годится: соседняя запись того же файла, сорвавшись позже, вернула бы чужие
     * неподтверждённые диапазоны.
     */
    let writes: Write[] = [];
    /** Серверное состояние под записями: снято при первой записи, коснувшейся id. */
    const fileBases = new Map<string, UiFileProgress | null>();
    const stopBases = new Map<string, boolean | null>();
    /**
     * Хвост очереди: запись уходит на сервер только после ответа предыдущей, любой. Ручки файла,
     * остановки и карточки на сервере пересекаются по диапазонам, а ручные клики редки — общий
     * порядок дешевле, чем разбор пересечений.
     */
    let queue: Promise<void> = Promise.resolve();
    let applied = options.initialRevision;
    let inFlight = 0;
    let seq = 0;
    /**
     * Сервер изменил seen-диапазоны (отметка остановки или карточки, снятие файла) так, как стор
     * сам не посчитает, — снимок надо перечитать.
     */
    let rangesPending = false;

    const replayFile = (fileId: string): UiFileProgress | null =>
        writes.reduce(
            (record, write) => (write.file?.id === fileId ? write.file.change(record) : record),
            fileBases.get(fileId) ?? null,
        );
    const replayStop = (stopId: string): boolean | null =>
        writes.reduce(
            (viewed, write) => (write.stop?.id === stopId ? write.stop.viewed : viewed),
            stopBases.get(stopId) ?? null,
        );

    /** База без записей поверх уходит: стор по этому id снова и есть серверное состояние. */
    const prune = (): void => {
        for (const fileId of fileBases.keys()) {
            if (!writes.some((write) => write.file?.id === fileId)) {
                fileBases.delete(fileId);
            }
        }
        for (const stopId of stopBases.keys()) {
            if (!writes.some((write) => write.stop?.id === stopId)) {
                stopBases.delete(stopId);
            }
        }
    };

    const enqueue = async (
        target: Pick<Write, 'file' | 'stop'>,
        apply: () => void,
        send: () => Promise<number>,
    ): Promise<boolean> => {
        const write: Write = { seq: (seq += 1), done: false, ...target };
        if (write.file !== null && !fileBases.has(write.file.id)) {
            fileBases.set(write.file.id, options.read(write.file.id));
        }
        if (write.stop !== null && !stopBases.has(write.stop.id)) {
            stopBases.set(write.stop.id, options.stops.read(write.stop.id));
        }
        writes.push(write);
        apply();
        inFlight += 1;

        const request = queue.then(async () => {
            const revision = await send();
            if (revision === applied + 1) {
                applied = revision;
            }
            write.done = true;
        });
        queue = request.then(noop, noop);

        try {
            await request;
            return true;
        } catch {
            writes = writes.filter((candidate) => candidate !== write);
            if (write.file !== null) {
                options.restore(write.file.id, replayFile(write.file.id));
            }
            if (write.stop !== null) {
                options.stops.restore(write.stop.id, replayStop(write.stop.id));
            }
            prune();
            return false;
        } finally {
            inFlight -= 1;
            options.onSettled();
        }
    };

    return {
        write: async (fileId, viewed) => {
            const written = await enqueue(
                {
                    file: { id: fileId, change: (record) => ({ ...(record ?? { fileId, seenRanges: [] }), viewed }) },
                    stop: null,
                },
                () => {
                    options.apply(fileId, viewed);
                },
                () => options.send(fileId, viewed),
            );
            if (written && !viewed) {
                rangesPending = true;
            }
            return written;
        },

        writeStop: async (stopId, viewed, ranges) => {
            const written = await enqueue(
                { file: null, stop: { id: stopId, viewed } },
                () => {
                    options.stops.apply(stopId, viewed);
                },
                () => options.stops.send(stopId, viewed, ranges),
            );
            if (written) {
                rangesPending = true;
            }
            return written;
        },

        writeStopFile: async (stopId, fileId, viewed, ranges) => {
            const unmarksStop = !viewed && options.stops.read(stopId) === true;
            const change = viewed ? 'add' : 'remove';
            const written = await enqueue(
                {
                    file: {
                        id: fileId,
                        change: (record) => {
                            const base = record ?? { fileId, viewed: null, seenRanges: [] };
                            return { ...base, seenRanges: changeSeenRanges(base.seenRanges, change, ranges) };
                        },
                    },
                    stop: unmarksStop ? { id: stopId, viewed: false } : null,
                },
                () => {
                    options.stopFiles.apply(fileId, change, ranges);
                    if (unmarksStop) {
                        options.stops.apply(stopId, false);
                    }
                },
                () => options.stopFiles.send(stopId, fileId, viewed, viewed ? ranges : []),
            );
            if (written) {
                rangesPending = true;
            }
            return written;
        },

        // Пока своя запись в полёте, событие о ней же ничего не сообщает: решение о перечитке
        // откладывается до её ответа — он и скажет, была ли между виденной и своей чужая.
        // Своя запись с диапазонами просит перечитку сама и события из канала не ждёт: без
        // перечитки коробки прочитанности остались бы в состоянии до отметки.
        // Ревизия сверяется на неравенство, а не на «больше»: после перезапуска сервера счётчик
        // начинается заново, и меньший номер — новый сервер, а не устаревшее событие. Со сверкой
        // «больше» вкладка игнорировала бы чужие отметки, пока новый счётчик не догонит старый.
        shouldReload: (revision) =>
            inFlight === 0 && (rangesPending || (revision !== null && revision !== applied)),

        beginReload: () => seq + 1,

        finishReload: (response, mark) => {
            // Ответ ручки принимается любой ревизией, в том числе меньшей виденной: ревизия
            // монотонна только в пределах одной жизни сервера, а после его перезапуска считается
            // заново. Сверка «ответ старше виденного» отбрасывала бы каждый снимок нового сервера,
            // и экран замирал бы до перезагрузки вкладки. Записи, которых ответ не застал,
            // накладываются ниже — за свежесть отвечают они, а не номер ревизии.
            applied = response.progressRevision;
            rangesPending = false;

            const files = new Map(response.files.map((record) => [record.fileId, record]));
            const stops = new Map(response.stops.map((record) => [record.stopId, record]));
            // Принятая до начала перечитки запись целиком отражена в ответе — дальше её состоянием
            // служит сам снимок. Остальные ложатся поверх: иначе свежая отметка визуально
            // откатилась бы, хотя на сервере она есть, а сорвавшаяся откатится к этому снимку.
            writes = writes.filter((write) => !(write.done && write.seq < mark));
            prune();
            for (const fileId of fileBases.keys()) {
                fileBases.set(fileId, files.get(fileId) ?? null);
                const record = replayFile(fileId);
                if (record !== null) {
                    files.set(fileId, record);
                }
            }
            for (const stopId of stopBases.keys()) {
                stopBases.set(stopId, stops.get(stopId)?.viewed ?? null);
                const viewed = replayStop(stopId);
                if (viewed !== null) {
                    stops.set(stopId, { stopId, viewed });
                }
            }
            return { files: [...files.values()], stops: [...stops.values()] };
        },
    };
}
