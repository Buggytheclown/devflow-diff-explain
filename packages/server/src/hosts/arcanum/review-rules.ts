import type { ArcanumClient } from './client.js';
import { GlobSyntaxError } from './rules/glob.js';
import type { PathRule, SubpathsFilter } from './rules/subpaths.js';
import { configDirOf, MATCH_ALL, parseSubpathsFilter, rulesCovering } from './rules/subpaths.js';
import type { ArcPreviewRuleValue, ArcReviewRule } from './schemas.js';
import { abcPathsSchema, previewAYamlSchema } from './schemas.js';

/**
 * Per-file матчинг правил ревью a.yaml: какие правила отвечают за конкретный файл и какие
 * файлы не покрыты правилами вовсе. Два выхода — точная линза «мои файлы» и `generated`.
 *
 * Данные собираются двумя ручками:
 * 1. `POST /v1/repos/{repo}/abc` — путь файла → владеющий a.yaml (батчем на весь дифф;
 *    порядок ответа не повторяет порядок запроса, сопоставление по `path`);
 * 2. `GET /v1/repos/preview/a-yaml` — уровни иерархии этого a.yaml с готовым `is_active`
 *    и резолвнутыми людьми. Наследование (`override_policy`) не воспроизводим: Арканум уже
 *    сказал, какие уровни живы. Ответ этой ручки приходит без конверта `{data}`, а `fields`
 *    она игнорирует (проверено живьём).
 *
 * Матчинг — чистые функции в `rules/`; здесь только сеть и сборка.
 *
 * **Битые шаблоны изолируются по конфигу.** Арканум помечает неразобравшееся правило
 * `invalid_paths_glob_pattern` и считает остальные; мы делаем то же — правило с непонятным глобом
 * выбрасывается, а файлы его a.yaml, которых не взяло ни одно уцелевшее правило, получают вердикт
 * `unknown` вместо `uncovered`: покрытие неизвестно, поэтому ни `generated`, ни ложного «ревью
 * не настроено». Соседние a.yaml считаются честно, весь PR из-за одной строки не глохнет.
 *
 * **Границы точности.** Preview отдаёт правила такими, как они записаны в a.yaml, и не применяет
 * ни `authors`/`branches`-фильтры правил, ни `skip_review_for` — про автора PR и его ветку она
 * не знает. Резолвнутых авторов взять неоткуда: `members_by_author` в ответе есть, но приходит
 * пустым (проверено живьём на PR 15138703). Поэтому вердикты и зоны считаются по надмножеству
 * боевых правил, а линза «мои» берёт только пересечение preview с фактически применёнными
 * `review.rules` PR. Если это пересечение недоступно, все preview-правила считаются применёнными:
 * лучше временное надмножество линзы, чем ложное обнуление.
 *
 * **Критерий призыва.** Из применённых правил линза берёт только те, которые призвали
 * лично меня: `assign > 0` и мой логин ∈ `reviewers_names` — ровно то, что Арканум показывает
 * в причинах призыва. Правило с `assign: 0` никого не назначает, оно только считает шипы
 * (`any-reviewer` на весь пакет), и причиной не считается; `ship: 0` не мешает — группы
 * `-without-duty` призывают, значит причина. Предохранитель: если моего логина нет ни в одном
 * `reviewers_names` PR (я не ревьюер — смотрю чужой PR; или Арканум этих полей не отдаёт),
 * поведение прежнее — линза по членству в ролях всех применённых правил. Если я ревьюер, но
 * ни одно призывающее правило меня не назвало, линза честно пуста — но не скрывается.
 * Preview-правило без ролей в режиме призыва считается применённым только тогда, когда без ролей
 * пришло и хотя бы одно призвавшее меня правило: правило a.yaml с явными `reviewers` ролей не
 * имеет и в пары «конфиг × роль» ничего не кладёт, так что иначе линза схлопнулась бы в ноль
 * ровно на том правиле, которое меня и позвало. Если все призвавшие правила ролевые, несверяемые
 * безролевые не считаются — они вернули бы в линзу тот самый шум.
 *
 * **Голден-сверка (PR 15138703, 75 файлов, 7 a.yaml, 2026-08-22).** Правила без `authors`-фильтра,
 * покрывшие хотя бы один файл, совпали с применёнными Аркануму `review.rules` без единого
 * расхождения: 13 = 13 пар «a.yaml × роли». Все наши 31 покрывающих правил — надмножество всех 17
 * применённых (ничего применённого не потеряно), а лишние 14 — ровно те, у которых непустой
 * `authors_filter`. Проверенная тем же прогоном модель «правило забирает файл, покрытый
 * вычёркивается» (первоначальная постановка задачи) со сверкой расходится: она находит только
 * 7 из 13 правил и на этом PR отдаёт 42 из 75 файлов правилу команды, к которой автор PR
 * не относится, — то есть режет линзу «мои» втрое против правды (28 файлов вместо 70).
 */

/** Фактически применённые `review.rules` PR, приведённые к сверке с preview-правилами. */
export interface AppliedReviewRules {
    /** Пары «нормализованный путь a.yaml × роль». */
    readonly pairs: ReadonlySet<string>;
    /**
     * Считать ли применённым preview-правило без ролей: сверить его с `review.rules` нечем.
     * В обычном режиме — да; в режиме призыва — только если безролевым пришло и правило,
     * призвавшее меня (см. «Критерий призыва» в шапке).
     */
    readonly matchRulesWithoutRoles: boolean;
}

/** Правило ревью a.yaml: к матчингу добавлены люди и подпись для диагностики. */
export interface ReviewRule extends PathRule {
    /** Путь a.yaml того уровня иерархии, которому правило принадлежит. */
    readonly configPath: string;
    /** Алиас правила из a.yaml; у правил без имени его нет. */
    readonly alias: string | null;
    /** Ролевые предикаты правила — ими правило сверяется с `review.rules` PR в голден-сверке. */
    readonly roles: readonly string[];
    /** Предикаты `authors`; непустой список — правило на боевом расчёте могло быть выключено. */
    readonly authors: readonly string[];
    readonly members: ReadonlySet<string>;
}

/**
 * Что матчинг знает о файле:
 * - `no_rules` — в иерархии a.yaml нет активных правил ревью («ревью не настроено»);
 * - `uncovered` — правила есть, но файл не покрыт ни одним (осознанное исключение вида
 *   `!pnpm-lock.yaml`) — это и есть `generated`;
 * - `unknown` — в иерархии есть правило с неразобравшимся глобом, и уцелевшие файл не взяли:
 *   отличить «исключён» от «взят битым правилом» нельзя, поэтому признака нет;
 * - `covered` — файл покрывают правила `rules` (в порядке объявления в a.yaml).
 */
export type FileRuleVerdict =
    | { readonly kind: 'no_rules' }
    | { readonly kind: 'uncovered' }
    | { readonly kind: 'unknown' }
    | { readonly kind: 'covered'; readonly rules: readonly ReviewRule[] };

/** Вердикт по каждому пути диффа. Путь, которого нет в карте, ручки не описали. */
export type FileRuleIndex = ReadonlyMap<string, FileRuleVerdict>;

export interface FileReviewRulesOptions {
    /** Репозиторий Арканума, он же тенант PR: `arcadia` или `cloudia`. */
    readonly repo: string;
    /** Ревьюируемая ревизия: и `abc`, и preview считают правила на конкретном коммите. */
    readonly commit: string;
    readonly paths: readonly string[];
}

/** Множество пар из ответа `review.rules`; путь нормализуется независимо от формы обеих ручек. */
export function appliedReviewRules(
    rules: readonly ArcReviewRule[],
    options: { readonly matchRulesWithoutRoles: boolean },
): AppliedReviewRules {
    const pairs = new Set<string>();
    for (const rule of rules) {
        for (const config of rule.configs ?? []) {
            for (const role of rule.roles ?? []) {
                pairs.add(reviewRulePair(config.path, role));
            }
        }
    }
    return { pairs, matchRulesWithoutRoles: options.matchRulesWithoutRoles };
}

/** Арканум назвал этот логин ревьюером хотя бы одного правила PR — значит поля призыва живые. */
export function isSummonedReviewer(
    rules: readonly ArcReviewRule[],
    login: string | null,
): boolean {
    return login !== null && rules.some((rule) => (rule.reviewers_names ?? []).includes(login));
}

/**
 * Правила, которые призвали меня: `assign > 0` и мой логин среди `reviewers_names`.
 * Предохранитель — если меня не призвало ни одно правило, возвращаются все (см. шапку модуля).
 */
export function summoningReviewRules(
    rules: readonly ArcReviewRule[],
    login: string | null,
): readonly ArcReviewRule[] {
    if (login === null || !isSummonedReviewer(rules, login)) {
        return rules;
    }
    return rules.filter(
        (rule) => (rule.assign ?? 0) > 0 && (rule.reviewers_names ?? []).includes(login),
    );
}

/** Сверка preview-правила с фактически применёнными `review.rules` PR. */
export function isAppliedReviewRule(rule: ReviewRule, applied: AppliedReviewRules | null): boolean {
    if (applied === null) {
        return true;
    }
    if (rule.roles.length === 0) {
        return applied.matchRulesWithoutRoles;
    }
    return rule.roles.some((role) => applied.pairs.has(reviewRulePair(rule.configPath, role)));
}

/**
 * Вердикты по всем путям диффа. Любая сорвавшаяся ручка бросает наружу — деградацию выбирает
 * принимает вызывающий (`ArcanumHost`), а не этот модуль.
 */
export async function loadFileReviewRules(
    client: ArcanumClient,
    options: FileReviewRulesOptions,
): Promise<FileRuleIndex> {
    const index = new Map<string, FileRuleVerdict>();
    if (options.paths.length === 0) {
        return index;
    }

    const owners = await resolveOwners(client, options);
    const byConfig = groupByConfig(options.paths, owners);

    const configs = [...byConfig.keys()];
    const ruleSets = await Promise.all(
        configs.map((configPath) => loadRules(client, configPath, options)),
    );

    for (const [position, configPath] of configs.entries()) {
        const ruleSet = ruleSets[position] ?? EMPTY_RULE_SET;
        for (const path of byConfig.get(configPath) ?? []) {
            index.set(path, verdictOf(path, ruleSet));
        }
    }

    // Путь без владеющего a.yaml: правил в иерархии нет — «ревью не настроено», не `generated`.
    for (const path of options.paths) {
        if (!index.has(path)) {
            index.set(path, { kind: 'no_rules' });
        }
    }
    return index;
}

function verdictOf(path: string, ruleSet: RuleSet): FileRuleVerdict {
    const { rules, dropped } = ruleSet;
    if (rules.length === 0) {
        return dropped ? { kind: 'unknown' } : { kind: 'no_rules' };
    }
    const covering = rulesCovering(path, rules);
    if (covering.length > 0) {
        return { kind: 'covered', rules: covering };
    }
    // Уцелевшие правила файл не взяли — но взяло бы выброшенное, знать нельзя.
    return dropped ? { kind: 'unknown' } : { kind: 'uncovered' };
}

/**
 * Путь файла → путь владеющего a.yaml.
 *
 * Ответ проверяется на полноту: элемент без `abc_project` — законный «владельца нет», а вот
 * пропавший элемент отличить от него нечем, и тихо он превратился бы в «ревью не настроено».
 * Поэтому недостача — ошибка: пусть лучше линза уедет на каталожный путь целиком.
 */
async function resolveOwners(
    client: ArcanumClient,
    options: FileReviewRulesOptions,
): Promise<Map<string, string>> {
    const response = await client.postJson(
        `/v1/repos/${options.repo}/abc`,
        { paths: options.paths.map((path) => ({ path, commit: options.commit })) },
        abcPathsSchema,
    );

    const owners = new Map<string, string>();
    const described = new Set<string>();
    for (const item of response) {
        described.add(item.path);
        const configPath = item.abc_project?.config?.path;
        if (configPath !== undefined) {
            owners.set(item.path, configPath);
        }
    }

    const missing = options.paths.filter((path) => !described.has(path));
    if (missing.length > 0) {
        throw new Error(
            `ответ abc не описал ${String(missing.length)} из ${String(options.paths.length)} путей (первый — ${String(missing[0])})`,
        );
    }
    return owners;
}

/** Файлы, сгруппированные по владеющему a.yaml; исходный порядок путей сохраняется. */
function groupByConfig(
    paths: readonly string[],
    owners: ReadonlyMap<string, string>,
): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const path of paths) {
        const configPath = owners.get(path);
        if (configPath === undefined) {
            continue;
        }
        const bucket = grouped.get(configPath);
        if (bucket === undefined) {
            grouped.set(configPath, [path]);
        } else {
            bucket.push(path);
        }
    }
    return grouped;
}

/** Правила одного a.yaml и признак того, что какое-то правило иерархии выброшено битым глобом. */
interface RuleSet {
    readonly rules: readonly ReviewRule[];
    readonly dropped: boolean;
}

const EMPTY_RULE_SET: RuleSet = { rules: [], dropped: false };

/**
 * Активные правила иерархии одного a.yaml, от корня иерархии к ближайшему конфигу (уровни
 * приходят в обратном порядке). Каталог берётся у каждого уровня свой (`config_path`): активным
 * бывает и не тот a.yaml, который вернул `abc`, — так выходит, когда ближайший конфиг ревью
 * не настраивает и живёт правилами предка.
 *
 * Активность Арканум проставляет пофилдово: наследование гасит не только уровень целиком
 * (`level.is_active`), но и отдельное поле — мёртвое `rule_assignees` на живом уровне значит,
 * что правило переопределено потомком и в боевом расчёте не участвует.
 */
async function loadRules(
    client: ArcanumClient,
    configPath: string,
    options: FileReviewRulesOptions,
): Promise<RuleSet> {
    const preview = await client.getJson(
        '/v1/repos/preview/a-yaml',
        { path: configPath, commit_id: options.commit, repo_name: options.repo },
        previewAYamlSchema,
        // Тело лежит в корне ответа: конверта `{data}` у preview нет.
        { envelope: 'optional' },
    );

    const levels = (preview.a_yaml.arcanum.review ?? []).filter((level) => level.is_active);
    const rules: ReviewRule[] = [];
    let dropped = false;
    for (const level of levels.reverse()) {
        const levelPath = level.config_path.path;
        for (const rule of level.rules ?? []) {
            const assignees = rule.rule_assignees;
            if (assignees?.is_active !== true || assignees.value === undefined) {
                continue;
            }
            const subpaths = compileSubpaths(assignees.value, levelPath);
            if (subpaths === null) {
                dropped = true;
                continue;
            }
            rules.push({
                configPath: levelPath,
                baseDir: configDirOf(levelPath),
                alias: assignees.value.alias ?? null,
                roles: assignees.value.rules ?? [],
                authors: assignees.value.authors_filter ?? [],
                members: membersOf(assignees.value),
                subpaths,
            });
        }
    }
    return { rules, dropped };
}

/** Фильтр правила; `null` — глоб не разобрался, правило выбрасывается (см. шапку модуля). */
function compileSubpaths(value: ArcPreviewRuleValue, levelPath: string): SubpathsFilter | null {
    const raw = value.subpaths_filter ?? [];
    if (raw.length === 0) {
        return MATCH_ALL;
    }
    try {
        return parseSubpathsFilter(raw);
    } catch (error) {
        if (!(error instanceof GlobSyntaxError)) {
            throw error;
        }
        const alias = value.alias ?? '(без алиаса)';
        process.stderr.write(
            `sherpa-server: правило ревью ${alias} в ${levelPath} не разобралось и не применяется: ${error.message}\n`,
        );
        return null;
    }
}

/** Ключ пары устойчив к ведущим слэшам в путях обеих ручек. */
function reviewRulePair(configPath: string, role: string): string {
    return JSON.stringify([configPath.replace(/^\/+/, ''), role]);
}

/** Люди правила: `reviewers` — уже плоский резолвнутый список, `members_by_rule` — тот же по ролям. */
function membersOf(value: ArcPreviewRuleValue): ReadonlySet<string> {
    const members = new Set<string>();
    for (const reviewer of value.reviewers ?? []) {
        members.add(reviewer.login);
    }
    for (const logins of Object.values(value.members_by_rule ?? {})) {
        for (const login of logins) {
            members.add(login);
        }
    }
    return members;
}
