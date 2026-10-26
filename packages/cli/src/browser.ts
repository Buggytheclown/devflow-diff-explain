import { spawn } from 'node:child_process';

interface SpawnedBrowser {
    once(event: 'error', listener: (error: Error) => void): unknown;
    unref(): void;
}

type SpawnBrowser = (
    command: string,
    args: readonly string[],
    options: { readonly detached: true; readonly stdio: 'ignore' },
) => SpawnedBrowser;

export interface OpenBrowserOptions {
    readonly uiUrl: string;
    readonly platform?: NodeJS.Platform;
    readonly spawnBrowser?: SpawnBrowser;
}

export interface BrowserCommand {
    readonly command: string;
    readonly args: readonly string[];
}

/** Системный opener для поддержанных платформ. */
export function browserCommand(platform: NodeJS.Platform, uiUrl: string): BrowserCommand | null {
    switch (platform) {
        case 'darwin':
            return { command: 'open', args: [uiUrl] };
        case 'linux':
            return { command: 'xdg-open', args: [uiUrl] };
        case 'win32':
            return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', uiUrl] };
        default:
            return null;
    }
}

/**
 * Открывает UI напрямую: URL кратко виден в argv opener-процесса, но не попадает в историю shell.
 * Сервер loopback, процесс короткоживущий, а та же ссылка всегда печатается в stdout.
 */
export function openBrowser(options: OpenBrowserOptions): void {
    const opener = browserCommand(options.platform ?? process.platform, options.uiUrl);
    if (opener === null) {
        return;
    }

    try {
        const spawnBrowser =
            options.spawnBrowser ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
        const child = spawnBrowser(opener.command, opener.args, { detached: true, stdio: 'ignore' });
        child.once('error', () => undefined);
        child.unref();
    } catch {
        // Печать ссылки остаётся запасным путём для headless/ssh и отсутствующего системного opener.
    }
}
