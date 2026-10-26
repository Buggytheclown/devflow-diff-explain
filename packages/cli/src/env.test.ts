import { afterEach, expect, it, vi } from 'vitest';
import { loadSherpaEnv } from './env.js';
afterEach(() => { vi.restoreAllMocks(); });
it('loads the configured file using the Node dotenv parser', () => {
    const read = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
    loadSherpaEnv('/tmp/sherpa-config.env');
    expect(read).toHaveBeenCalledWith('/tmp/sherpa-config.env');
});
it('allows a missing file but propagates access and read errors', () => {
    const read = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    expect(() => { loadSherpaEnv('/tmp/missing'); }).not.toThrow();
    read.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(() => { loadSherpaEnv('/tmp/denied'); }).toThrow('denied');
});
