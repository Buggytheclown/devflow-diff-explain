/**
 * Форматы ключа PR (`docs/protocol.md §8`). Ключ — часть пути в `~/.sherpa`, поэтому пишется
 * алфавитом `prKeySchema`; префикс ключа выбирает хост-адаптер. CLI ключи строит, сервер
 * по ним выбирает хост. Функции чистые: побочных эффектов в протоколе нет.
 */

/** `arcanum-<id PR>`. */
export const ARCANUM_PR_KEY_PREFIX = 'arcanum-';

/**
 * Системы контроля версий локального ревью. Вид входит в ключ (`local-arc-…`, `local-git-…`):
 * по нему сервер выбирает бэкенд, а CLI и UI узнают локальное ревью, не спрашивая сервер.
 */
export const LOCAL_VCS_KINDS = ['arc', 'git'] as const;
export type LocalVcsKind = (typeof LOCAL_VCS_KINDS)[number];

/** `local-<vcs>-<каталог>-<хеш>`: рабочее дерево локального чекаута. */
export function localPrKeyPrefix(kind: LocalVcsKind): string {
    return `local-${kind}-`;
}

/** Имя локального адаптера (`SelectedHost.name`, он же `uiState.reviewHost`): `local-arc`, `local-git`. */
export function localHostName(kind: LocalVcsKind): string {
    return `local-${kind}`;
}

/** Вид VCS локального ключа; null — ключ не локального ревью. */
export function localVcsOfPrKey(prKey: string): LocalVcsKind | null {
    return LOCAL_VCS_KINDS.find((kind) => prKey.startsWith(localPrKeyPrefix(kind))) ?? null;
}

/**
 * `github-<владелец>--<репозиторий>--<номер>`. Разделитель — удвоенный дефис: у владельца
 * GitHub его не бывает, а у репозитория — бывает.
 */
export const GITHUB_PR_KEY_PREFIX = 'github-';

/** Адрес PR на github.com: владелец, репозиторий и номер. */
export interface GithubPrRef {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
}

const SEPARATOR = '--';

/** Владелец GitHub: буквы, цифры и одиночные дефисы — удвоенного дефиса в нём не бывает. */
const OWNER_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** Репозиторий GitHub: буквы, цифры, точка, дефис и подчёркивание; дефисы бывают и подряд. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

const NUMBER_PATTERN = /^[1-9][0-9]*$/;

/** `https://github.com/<owner>/<repo>/pull/<number>` с любым хвостом; схема и `www.` необязательны. */
const URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function githubPrKey(ref: GithubPrRef): string {
    return `${GITHUB_PR_KEY_PREFIX}${ref.owner}${SEPARATOR}${ref.repo}${SEPARATOR}${String(ref.number)}`;
}

/**
 * Разбор ключа: владелец — до первого `--`, номер — после последнего, репозиторий — всё между.
 * null — это не ключ GitHub-PR (в том числе когда части не похожи на имена GitHub).
 */
export function parseGithubPrKey(key: string): GithubPrRef | null {
    if (!key.startsWith(GITHUB_PR_KEY_PREFIX)) {
        return null;
    }

    const rest = key.slice(GITHUB_PR_KEY_PREFIX.length);
    const first = rest.indexOf(SEPARATOR);
    const last = rest.lastIndexOf(SEPARATOR);
    if (first === -1 || last === first) {
        return null;
    }

    return refOf(rest.slice(0, first), rest.slice(first + SEPARATOR.length, last), rest.slice(last + SEPARATOR.length));
}

/** Адрес PR из ссылки на github.com; null — ссылка не про PR github.com. */
export function parseGithubPrUrl(url: string): GithubPrRef | null {
    const found = URL_PATTERN.exec(url.trim());
    if (found === null) {
        return null;
    }
    return refOf(found[1] ?? '', found[2] ?? '', found[3] ?? '');
}

function refOf(owner: string, repo: string, number: string): GithubPrRef | null {
    if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || !NUMBER_PATTERN.test(number)) {
        return null;
    }
    return { owner, repo, number: Number(number) };
}
