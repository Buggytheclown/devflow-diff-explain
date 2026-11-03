import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';
import type { Iteration, CodeReader } from '@sherpa/protocol';

export interface SelectHostOptions { sherpaDir?: string; repo?: string | null; base?: string | null; branch?: string | null }
export interface SelectedSource { readonly name: string; readonly host: CodeReader; readonly advanceIteration?: () => Iteration }
export type CodeReaderFactory = (prKey: string, options: SelectHostOptions) => SelectedSource | null;
/** Временная фикстурная совместимость тестов; провайдеров кода здесь нет. */
export function selectCodeReader(prKey: string, _options: SelectHostOptions = {}): SelectedSource | null {
    const name = prKey.startsWith('fixture-') ? prKey.slice(8) : '';
    if (!(FIXTURE_NAMES as readonly string[]).includes(name)) return null;
    const host = makeFixtureHost(name as FixtureName);
    return { name: 'fixture', host, advanceIteration: () => host.advanceIteration() };
}
