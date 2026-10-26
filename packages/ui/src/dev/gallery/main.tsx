/* Базовый слой идёт первым: правила состояний контролов обязаны стоять в каскаде
   до компонентных стилей — те доопределяют раскладку поверх них. */
import '../../styles/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readFragmentParam } from '../../fragment.js';
import { IconSprite } from '../../icons/icon.tsx';
import { Gallery, parseGalleryArcanum, parseGalleryLocale, parseGalleryTextSize, parseGalleryTheme } from './gallery.tsx';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Не найден корневой элемент #root');
}

createRoot(container).render(
    <StrictMode>
        <IconSprite />
        <Gallery
            initialTheme={parseGalleryTheme(readFragmentParam(window.location.hash, 'theme'))}
            initialArcanum={parseGalleryArcanum(readFragmentParam(window.location.hash, 'arcanum'))}
            initialTextSize={parseGalleryTextSize(readFragmentParam(window.location.hash, 'textsize'))}
            initialId={readFragmentParam(window.location.hash, 'state')}
            initialLocale={parseGalleryLocale(readFragmentParam(window.location.hash, 'locale'))}
        />
    </StrictMode>,
);
