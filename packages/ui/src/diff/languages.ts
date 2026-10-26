import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import nginx from 'highlight.js/lib/languages/nginx';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import type { LanguageFn } from 'highlight.js';
import { common, createLowlight } from 'lowlight';

/**
 * Реестр грамматик highlight.js: набор `common` lowlight (37 языков) плюс те, что часто
 * встречаются в наших диффах, но в `common` не входят.
 *
 * Реестр статический: грамматики попадают в бандл целиком. Ленивая подгрузка невозможна без
 * асинхронной инициализации, а `parseFileDiff` синхронный (его зовёт галерея прямо в рендере).
 */
export const lowlight = createLowlight(common);

const EXTRA: Readonly<Record<string, LanguageFn>> = {
    clojure,
    cmake,
    dart,
    dockerfile,
    elixir,
    erlang,
    groovy,
    haskell,
    nginx,
    properties,
    protobuf,
    scala,
};

for (const [name, language] of Object.entries(EXTRA)) {
    lowlight.register(name, language);
}
