import type { HostId, Iteration, Lens, PrDiff, PrMeta, ReviewUser, Thread } from '@sherpa/protocol';

/** Итерация фикстуры без статуса: статус считает хост от своего указателя активной итерации. */
export type FixtureIterationMeta = Omit<Iteration, 'status'>;

/** Одна итерация PR: дифф и треды, которые хост отдаёт, пока она активна. */
export interface FixtureIteration {
    iteration: FixtureIterationMeta;
    diff: PrDiff;
    threads: Thread[];
    /** Итерация, которую этот пуш переписал (force-push); заменённую хост больше не перечисляет. */
    replaces: HostId | null;
}

/**
 * Срез между двумя итерациями (интердифф) — объявлен данными, а не вычисляется:
 * ханки согласованы с патчами итераций вручную и проверяются тест-гвардией.
 */
export interface FixtureInterdiff {
    base: HostId;
    head: HostId;
    diff: PrDiff;
}

/** Один фикстурный PR целиком: всё, что `FixtureHost` отдаёт наружу и мутирует в памяти. */
export interface FixtureData {
    pr: PrMeta;
    /** В порядке появления; первая — та, с которой начинается ревью. Пустой список невозможен. */
    iterations: FixtureIteration[];
    interdiffs: FixtureInterdiff[];
    /** null — у хоста нет понятия ownership (контракт `ReviewHost.ownershipLens`). */
    ownership: Lens | null;
    extraLenses: Lens[];
    /** «Я» в этой фикстуре: автор создаваемых черновиков и тот, кто резолвит треды. */
    currentUser: ReviewUser;
    /** Момент первой мутации; шаг между мутациями фиксирован, поэтому таймштампы предсказуемы. */
    mutationEpoch: string;
}

/**
 * Фикстура такой, какой её пишет билдер: `PrMeta.viewer` не объявляется руками — сборка
 * ставит туда `currentUser`, чтобы «я» фикстуры оставалось одно на все её стороны.
 */
export type FixtureDataInput = Omit<FixtureData, 'pr'> & { pr: Omit<PrMeta, 'viewer'> };

/**
 * Плоский срез фикстуры на одной итерации — форма, которой жил `FixtureData` до итераций.
 * Ею пользуются потребители, которым итерации не нужны: UI-тесты, галерея, e2e.
 */
export interface FixtureIterationView {
    pr: PrMeta;
    iteration: FixtureIterationMeta;
    diff: PrDiff;
    threads: Thread[];
    ownership: Lens | null;
    extraLenses: Lens[];
    currentUser: ReviewUser;
    mutationEpoch: string;
}
