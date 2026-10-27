import { storyRu, guidedRu, flowRu } from './ru.js';
import { storyEn, guidedEn, flowEn } from './en.js';
import { preparationRu, overviewRu } from './ru.js';
import { preparationEn, overviewEn } from './en.js';

export const preparationCopy = { ru: { ...preparationRu, ...overviewRu }, en: { ...preparationEn, ...overviewEn } };

export const storyCopy = { ru: storyRu, en: storyEn };

export const guidedCopy = { ru: guidedRu, en: guidedEn };

export const flowCopy = { ru: flowRu, en: flowEn };
