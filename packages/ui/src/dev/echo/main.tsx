/* Базовый слой идёт первым: правила состояний контролов обязаны стоять в каскаде
   до компонентных стилей — те доопределяют раскладку поверх них. */
import '../../styles/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readToken } from '../../fragment.js';
import { createStore } from '../../store.js';
import { EchoApp } from './echo-app.tsx';
import './echo.css';

/**
 * Дев-страница `dev.html`: демо петли агента против живого сервера. Токен — как на главной,
 * фрагментом URL. Через vite dev запросы к `/api` проксируются на запущенный сервер Шерпы
 * (см. `vite.config.ts`).
 */
const container = document.getElementById('root');
if (!container) {
    throw new Error('Не найден корневой элемент #root');
}

const token = readToken(window.location.hash);
const root = createRoot(container);

if (token === null) {
    root.render(
        <StrictMode>
            <main className="screen screen--message">
                <h1>Демо echo-петли</h1>
                <p>Нужен токен доступа: открой эту страницу с тем же фрагментом, что печатает запуск Шерпы.</p>
                <p className="muted">http://localhost:5173/dev.html#t=&lt;токен&gt;</p>
            </main>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });
    root.render(
        <StrictMode>
            <EchoApp store={store} token={token} />
        </StrictMode>,
    );
}
