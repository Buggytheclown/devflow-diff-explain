import { fixtureData, FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';

import { describeReviewHostContract } from './review-host-contract.js';

// Контрактный набор живёт в сервере (он тянет vitest), фикстуры — в отдельном пакете:
// здесь они встречаются. Арканумный прогон того же набора живёт рядом с адаптером.
for (const name of FIXTURE_NAMES) {
    // Итерации объявлены только у `medium`: остальным фикстурам двигать нечего.
    describeReviewHostContract(`FixtureHost(${name})`, () => makeFixtureHost(name), {
        viewer: fixtureData(name).currentUser.login,
        ...(name === 'medium'
            ? {
                  advance: (host): void => {
                      host.advanceIteration();
                  },
              }
            : {}),
    });
}
