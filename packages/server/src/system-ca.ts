import * as tls from 'node:tls';

type TrustStore = Partial<Pick<typeof tls, 'getCACertificates' | 'setDefaultCACertificates'>>;
let configured = false;

/** Системные доверенные CA дополняют стандартные Node roots; проверка TLS остаётся включённой. */
export function useSystemCertificateAuthorities(runtime: TrustStore = tls): void {
    if (runtime === tls && configured) return;
    const get = runtime.getCACertificates; const set = runtime.setDefaultCACertificates;
    // Старые поддерживаемые Node используют свой обычный NODE_EXTRA_CA_CERTS.
    if (get === undefined || set === undefined) return;
    set([...new Set([...get('default'), ...get('system')])]);
    if (runtime === tls) configured = true;
}
