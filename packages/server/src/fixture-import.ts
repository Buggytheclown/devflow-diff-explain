import fs from 'node:fs/promises';
import path from 'node:path';
import { fixtureData, fileContentOf, fixtureBlob } from '@sherpa/fixtures';
import type { FixtureName } from '@sherpa/fixtures';
import type { CodeSnapshotInput } from '@sherpa/protocol';

/** Только dev/тесты: детерминированные байты идут через обычный импорт. В бандл не входит. */
export async function exportFixture(name: FixtureName, project: string, root: string, index = 0): Promise<string> {
    const data = fixtureData(name);
    const iteration = data.iterations[index];
    if (iteration === undefined) throw new Error('No further fixture snapshot.');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const files: CodeSnapshotInput['files'] = [];
    for (const [number, file] of iteration.diff.files.entries()) {
        const content = fileContentOf(file);
        const side = async (old: boolean) => {
            if (file.changeType === (old ? 'add' : 'delete')) return null;
            const text = old ? content?.oldText : content?.newText;
            const image = old ? file.image?.before : file.image?.after;
            const bytes = image == null ? null : fixtureBlob(image.blobId);
            const artifact = `${String(number)}-${old ? 'old' : 'new'}`;
            await fs.writeFile(path.join(root, artifact), bytes ?? (text ?? new Uint8Array([0, 1, 2])));
            return { file: artifact, kind: file.binary ? 'binary' as const : 'text' as const };
        };
        files.push({ fileId: file.fileId, path: file.path, oldPath: file.oldPath, changeType: file.changeType,
            before: await side(true), after: await side(false), patch: null, generated: file.generated, hostFileUrl: file.hostFileUrl });
    }
    await fs.writeFile(path.join(root, 'caller'), 'export function caller() {\n  return validate();\n}\n');
    const manifest: CodeSnapshotInput = { format: 'code-snapshot/1', project,
        diffId: iteration.diff.diffId, baseCommit: iteration.diff.baseCommit, headCommit: iteration.diff.headCommit,
        capturedAt: iteration.iteration.createdAt, pr: data.pr, files, activate: true,
        sources: [{ path: 'context/caller.ts', revision: iteration.diff.headCommit, artifact: { file: 'caller', kind: 'text' } }] };
    const file = path.join(root, 'snapshot.json');
    await fs.writeFile(file, JSON.stringify(manifest));
    return file;
}
