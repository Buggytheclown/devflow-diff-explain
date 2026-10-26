import './styles/base.css';
import type { Locale } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { fetchUiSettings, patchUiSettings } from './api.js';
import { MessageScreen } from './components/message-screen.tsx';
import { App } from './story/app.tsx';
import { createStorySession } from './story/session.js';
import { readFragmentParam, readToken, updateFragment } from './fragment.js';
import { IconSprite } from './icons/icon.tsx';
import { LocaleProvider, useT } from './i18n/index.js';
import { SettingsProvider } from './settings/context.tsx';
import { DocumentSettingsSync, readDocumentAppearance } from './settings/document-settings.tsx';
import { createUiSettingsStore, loadUiSettings } from './settings/settings-store.js';
import type { Store } from './store.js';
import { createStore } from './store.js';

const container = document.getElementById('root');
if (!container) throw new Error('Devflow Diff Explain UI: root element #root is missing');
const root = createRoot(container);
const token = readToken(window.location.hash);
if (token === null) {
    root.render(<StrictMode><LocaleProvider><NoTokenScreen /></LocaleProvider></StrictMode>);
} else {
    const store = createStore({ token });
    const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement), send: (patch) => patchUiSettings(token, patch) });
    const session = createStorySession(readFragmentParam(window.location.hash, 'view') === 'diff' ? 'diff' : 'route', (view) => {
        history.replaceState(null, '', updateFragment(window.location.hash, { view }));
    });
    // Навигация не перехватывает ввод в полях, модификаторы браузера и выделение текста.
    window.addEventListener('keydown', (event) => {
        if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]') !== null) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.key === '1' || event.key === '2') { event.preventDefault(); session.setView(event.key === '1' ? 'route' : 'diff'); }
        if (event.key === 'Escape') session.setChatOpen(false);
    });
    void Promise.race([loadUiSettings(settings, () => fetchUiSettings(token)), delay(1500)]).then(() => {
        root.render(<StrictMode><IconSprite /><SettingsProvider store={settings}><DocumentSettingsSync /><AgentLocaleProvider store={store}><App store={store} session={session} token={token} /></AgentLocaleProvider></SettingsProvider></StrictMode>);
    });
}

function AgentLocaleProvider({ store, children }: { store: Store; children: ReactNode }) {
    const agentLang = useSyncExternalStore(store.subscribe, () => agentLangOf(store));
    return <LocaleProvider agentLang={agentLang}>{children}</LocaleProvider>;
}

function agentLangOf(store: Store): Locale | undefined {
    const worker = store.getSnapshot().state?.worker;
    return worker === undefined || worker.kind === 'never' ? undefined : worker.lang;
}

/** Экран без токена: единственное место, где UI живёт вообще без серверного состояния. */
function NoTokenScreen() {
    const t = useT();
    return (
        <MessageScreen title={t('app.name')}>
            <p>{t('app.noToken.text')}</p>
            <p className="message-screen__hint">{t('app.noToken.hint')}</p>
        </MessageScreen>
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
