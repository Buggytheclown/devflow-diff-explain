import { fixtureIteration, routeFixtures, guidedStoryFixture, readableStoryFixture, architectureStoryFixture } from '@sherpa/fixtures';
import type { RouteSnapshot, StorySource } from '@sherpa/protocol';

import { createStoryData } from '../../story/data.js';
import { EvidenceSource } from '../../story/evidence.tsx';
import { parseFileDiff } from '../../diff/parse.js';
import { toParseRequest } from '../../diff/model.js';
import { FlowDiagram, ExplanationExample } from '../../story/flow-diagram.tsx';
import { OverviewSkeleton, Preparation } from '../../story/preparation.tsx';
import { GuidedDocument } from '../../story/guided-document.tsx';
import { ReadFile } from '../../story/read-file.tsx';
import { StoryDocument } from '../../story/app.tsx';
import { ChatPanel, ChatSelectionContext } from '../../components/chat-panel.tsx';
import type { GalleryState } from './states.tsx';

const source = routeFixtures('medium')?.states.ready?.snapshot;
if (source == null) throw new Error('Нужна фикстура рассказа');
const snapshot: RouteSnapshot = { ...source, presentation: 'story',
    stops: source.stops.filter((stop) => stop.tier !== 'other'),
    tourOrder: source.tourOrder.filter((id) => id !== 'other'),
};
const diff = fixtureIteration('medium').diff;
const firstAnchor = snapshot.stops.flatMap((stop) => stop.anchors)[0];
if (firstAnchor === undefined) throw new Error('Нужен источник рассказа');
const sourceRef = { ...firstAnchor, kind: 'lines' as const, end: Math.min(firstAnchor.end, firstAnchor.start + 8) };
const evidence = (quote: string) => ({ claims: [{ quote, sources: [sourceRef], limitation: null }] });
const firstStop = snapshot.stops[0];
if (firstStop === undefined) throw new Error('Нужен раздел рассказа');
const summary = 'Для редактирования доставки задано окно по умолчанию 30 минут.';
const paragraph = 'Длительность задаёт `EDIT_WINDOW_MS`. Для категории `fresh-food` видимый код задаёт более короткое окно — 10 минут.';
const modern: RouteSnapshot = { ...snapshot, summary, storyContractVersion: 2, summaryEvidence: evidence(summary),
    stops: [{ ...firstStop, title: 'Правило окна', paragraph, anchors: [], storyEvidence: evidence(paragraph) }], tourOrder: [firstStop.id] };

const data = { ...createStoryData('gallery'), diff: () => Promise.resolve(diff), parse: (_id: string, file: typeof diff.files[number]) => Promise.resolve(parseFileDiff(toParseRequest(file))) };
const noop = (): void => undefined;

const renderSource = (source: StorySource, section: string, index: number) => <EvidenceSource key={`${section}:${String(index)}`} source={source} diffId={diff.diffId} data={data} token="gallery" focusId={`${section}:${String(index)}`} onOpen={noop} onSelect={noop} onLayout={noop} />;

function QuietChatGallery({ attached = false, offline = false }: { attached?: boolean; offline?: boolean }) {
    return <div style={{ height: 560, maxWidth: 550 }}><ChatPanel
        worker={offline ? { kind: 'never' } : { kind: 'connected', workerId: 'gallery', harness: 'codex', model: 'gpt', registeredAt: '2026-10-28T10:00:00Z', lastSeenAt: '2026-10-28T10:00:00Z' }}
        tasks={[]} exchanges={[]} notes={[]} loading={false} error={null} reconnectCommand="devflow-diff-explain worker next --pr fixture-medium"
        anchor={null} fileAttachment={attached ? { fileId: sourceRef.fileId, path: sourceRef.path } : undefined} contextCommit={snapshot.commit}
        focusRequest={0} scrollRequest={null} onScrollRequestHandled={noop} onClose={noop} onRemoveAnchor={noop}
        onAsk={() => Promise.reject(new Error('Gallery only'))} onCancel={() => Promise.resolve()} onRetry={() => Promise.resolve()} onNavigate={noop} onNavigateToNote={noop}
    /></div>;
}

export const STORY_STATES: readonly GalleryState[] = [
    { id: 'chat-quiet-empty', group: 'Чат', title: 'Пустой чат · вопрос по всему PR', render: () => <QuietChatGallery /> },
    { id: 'chat-explicit-file', group: 'Чат', title: 'Явно прикреплённый файл возле ввода', render: () => <QuietChatGallery attached /> },
    { id: 'chat-quiet-offline', group: 'Чат', title: 'Отключение · команда скрыта до запроса', render: () => <QuietChatGallery offline /> },
    { id: 'story-legacy', group: 'Рассказ', title: 'Прежний рассказ без связей тезисов с кодом',
        render: () => <main className="story-main"><p className="story-notice">Этот рассказ создан без связей тезисов с источниками. Можно обновить его вручную.</p><StoryDocument snapshot={snapshot} onAsk={noop} renderSource={renderSource} /></main> },
    { id: 'story-v2-collapsed', group: 'Рассказ', title: 'Новый рассказ · основания свёрнуты',
        render: () => <main className="story-main"><StoryDocument snapshot={modern} onAsk={noop} renderSource={renderSource} /></main> },
    { id: 'story-v2-expanded', group: 'Рассказ', title: 'Тезис и строки сохранённой стороны',
        render: () => <main className="story-main"><StoryDocument snapshot={modern} expanded={new Set(['intro'])} onAsk={noop} renderSource={renderSource} /></main> },
    { id: 'story-source-limit', group: 'Рассказ', title: 'Известное ограничение без фиктивного источника',
        render: () => <main className="story-main"><StoryDocument snapshot={{ ...modern, stops: [], summaryEvidence: { claims: [{ quote: modern.summary, sources: [], limitation: 'Единицы поля не определены в доступном фрагменте.' }] } }} onAsk={noop} /></main> },
    { id: 'story-source-error', group: 'Рассказ', title: 'Ошибка одного источника и локальный повтор',
        render: () => <main className="story-main"><div className="story-code"><header><code>src/service.ts · После · 12–18</code></header><p role="alert">Не удалось загрузить источник. <button className="ctl">Повторить загрузку</button></p></div></main> },
    { id: 'story-return', group: 'Рассказ', title: 'Возврат к разделу из полного диффа',
        render: () => <main className="story-main"><button className="ctl story-return">К рассказу · Порядок записи</button><p className="story-provenance">сохранённая версия · codex</p></main> },
    { id: 'story-selection', group: 'Рассказ', title: 'Выделенный код в контексте чата',
        render: () => <ChatSelectionContext anchor={{ ...sourceRef, diffId: diff.diffId }} text={'if (order.isEditable) {\n    return updateOrder(order);\n}'} onRemove={noop} /> },
    { id: 'story-selection-unavailable', group: 'Рассказ', title: 'Строки контекста недоступны',
        render: () => <ChatSelectionContext anchor={{ ...sourceRef, diffId: diff.diffId }} text={null} onRemove={noop} /> },
    { id: 'story-selection-long', group: 'Рассказ', title: 'Большой диапазон · раскрытие полного кода',
        render: () => <ChatSelectionContext anchor={{ ...sourceRef, diffId: diff.diffId, end: sourceRef.start + 39 }} text={'const result = updateOrder(order);\n'.repeat(40)} onRemove={noop} /> },
    { id: 'story-reading', group: 'Рассказ', title: 'Подготовка объяснения',
        render: () => <main className="story-main"><p className="story-notice" role="status">Готовлю короткое объяснение…</p></main> },
    { id: 'story-intro', group: 'Рассказ', title: 'Введение готово, основной текст строится',
        render: () => <main className="story-main"><p className="story-notice">Дописываю рассказ. Введение уже можно читать.</p><StoryDocument snapshot={{ ...modern, stops: [] }} onAsk={noop} /></main> },
    { id: 'story-ready', group: 'Рассказ', title: 'Готовый рассказ',
        render: () => <main className="story-main"><StoryDocument snapshot={modern} onAsk={noop} renderSource={renderSource} /></main> },
    { id: 'story-failed', group: 'Рассказ', title: 'Основной текст не достроен',
        render: () => <main className="story-main"><p className="story-notice" role="alert">Рассказ не завершён. Повторите построение.</p><StoryDocument snapshot={{ ...modern, stops: [] }} onAsk={noop} /></main> },
    { id: 'story-stale', group: 'Рассказ', title: 'Рассказ предыдущей версии',
        render: () => <main className="story-main"><p className="story-notice">В ПР появились новые изменения. Этот рассказ относится к предыдущей версии.</p><StoryDocument snapshot={modern} onAsk={noop} renderSource={renderSource} /></main> },
];

const guided = guidedStoryFixture();
function GuidedGallery({ page, pending = false, readableView = false }: { page: string; pending?: boolean; readableView?: boolean }) {
    const base = readableView ? readable.snapshot : guided.snapshot;
    const view = pending ? { ...base, stops: base.stops.map((stop) => ({ ...stop, status: 'filling' as const, paragraph: null, guidedFiles: stop.guidedFiles?.map((file) => ({ ...file, explanation: null, annotations: [] })) })) } : base;
    return <main className="story-main story-main--diff"><GuidedDocument snapshot={view} page={page} onVisit={noop} onAsk={noop} renderFile={(id, description) => {
        const file = guided.diff.files.find((entry) => entry.fileId === id);
        const notes = view.stops.flatMap((stop) => stop.guidedFiles ?? []).find((entry) => entry.fileId === id)?.annotations;
        return file === undefined ? null : <ReadFile description={description} file={file} diffId={guided.diff.diffId} data={data} token="gallery" current={false} annotations={notes} onSelect={noop} onLayout={noop} />;
    }} /></main>;
}
const readable = readableStoryFixture();
const architecture = architectureStoryFixture();
export const GUIDED_STORY_STATES: readonly GalleryState[] = [
    { id: 'overview-compact-ready', group: 'По диффу', title: 'Готовность · компактная строка с подробностями', render: () => <Preparation route={{ phase: 'ready', smallPr: false, snapshot: architecture.snapshot, failure: null, stale: null }} connected /> },
    { id: 'architecture-contrast', group: 'По диффу', title: 'Архитектура · контраст при конфликтующих цветах модели', render: () => <main className="story-main"><FlowDiagram flow={{ status: 'ready', contexts: [], diagram: { ...architecture.diagram, mermaid: architecture.diagram.mermaid + '\nclassDef faint fill:#ffffff,color:#eeeeee,stroke:#ffffff\nclass request,handler,rule,saved,rejected faint' } }} /></main> },
    { id: 'architecture-overview', group: 'По диффу', title: 'Архитектура · развилки, группы и связь с блоками', render: () => <main className="story-main"><GuidedDocument snapshot={architecture.snapshot} page="intro" onVisit={noop} onAsk={noop} renderFile={() => null} /></main> },
    { id: 'architecture-files-pending', group: 'По диффу', title: 'Два этапа · обзор готов, файлы ещё разбираются', render: () => <main className="story-main"><Preparation route={{ phase: 'filling', smallPr: false, snapshot: { ...architecture.snapshot, stops: architecture.snapshot.stops.map((block) => ({ ...block, status: 'queued', guidedFiles: block.guidedFiles?.map((file) => ({ ...file, explanation: null, status: 'queued' })) })) }, failure: null, stale: null }} connected /><FlowDiagram flow={architecture.snapshot.flow} blocks={architecture.snapshot.stops} /></main> },
    { id: 'overview-scaffold', group: 'По диффу', title: 'Первый кадр · постоянный каркас обзора', render: () => <main className="story-main"><Preparation route={{ phase: 'reading', smallPr: false, snapshot: null, failure: null, stale: null }} connected /><OverviewSkeleton /></main> },
    { id: 'overview-progress', group: 'По диффу', title: 'Общий прогресс · файлы готовы, схема недоступна', render: () => <main className="story-main"><Preparation route={{ phase: 'ready', smallPr: false, snapshot: { ...readable.snapshot, storyContractVersion: 5, flow: { status: 'unavailable', reason: 'Не удалось получить контекст.' } }, failure: null, stale: null }} connected /><FlowDiagram flow={{ status: 'unavailable', reason: 'Не удалось получить контекст.' }} onRetry={noop} connected /></main> },
    { id: 'overview-previous', group: 'По диффу', title: 'Перестройка · предыдущий разбор остаётся открыт', render: () => <main className="story-main"><Preparation route={{ phase: 'reading', smallPr: false, snapshot: readable.snapshot, generation: { id: 'new', commit: 'next', snapshotId: null, previousSnapshotId: readable.snapshot.snapshotId, status: 'running' }, failure: null, stale: null }} displayedId={readable.snapshot.snapshotId} connected={false} /><GuidedGallery page="intro" readableView /></main> },
    { id: 'overview-diagram-offline', group: 'По диффу', title: 'Локальный повтор схемы · агент отключён', render: () => <main className="story-main"><FlowDiagram flow={{ status: 'unavailable', reason: 'Схема не подготовлена. Описание и файлы доступны.' }} onRetry={noop} /></main> },
    { id: 'readable-description-route', group: 'По диффу', title: 'Описание · общий поток и маршрут справа', render: () => <GuidedGallery page="intro" readableView /> },
    { id: 'readable-file-cards', group: 'По диффу', title: 'Блок · назначения файлов до перехода в дифф', render: () => <GuidedGallery page="guided-1" readableView /> },
    { id: 'readable-flow', group: 'По диффу', title: 'Общий поток · изменения и неполный контекст', render: () => <main className="story-main"><FlowDiagram flow={readable.snapshot.flow} /></main> },
    { id: 'readable-flow-cycle', group: 'По диффу', title: 'Поток · повторный узел и скрытые ограничения', render: () => <main className="story-main"><FlowDiagram flow={{ status: 'ready', contexts: [], diagram: { ...readable.diagram, edges: [...readable.diagram.edges, { from: readable.diagram.nodes.at(-1)?.id ?? '', to: readable.diagram.nodes[0]?.id ?? '', label: 'Обратная связь', kind: 'data', change: 'unknown', sources: [], limitation: 'Связь не подтверждена сохранённым кодом. Подробности доступны в основании схемы.' }] } }} /></main> },
    { id: 'readable-example', group: 'По диффу', title: 'Краткое пояснение и пример', render: () => <main className="story-main"><p>Правило определяет, можно ли изменить заказ.</p><ExplanationExample example={readable.example} /></main> },
    { id: 'readable-flow-pending', group: 'По диффу', title: 'Схема готовится независимо от текста', render: () => <FlowDiagram flow={{ status: 'pending', taskId: null, round: 0, requests: [], contexts: [], missing: [] }} /> },
    { id: 'readable-flow-unavailable', group: 'По диффу', title: 'Схема недоступна', render: () => <FlowDiagram flow={{ status: 'unavailable', reason: 'Не удалось подтвердить общий поток. Рассказ и дифф доступны.' }} /> },
    { id: 'guided-description', group: 'По диффу', title: 'Описание ПРа и маршрут', render: () => <GuidedGallery page="intro" /> },
    { id: 'guided-block', group: 'По диффу', title: 'Смысловой блок · порядок файлов', render: () => <GuidedGallery page="guided-2" /> },
    { id: 'guided-continuous', group: 'По диффу', title: 'Непрерывный разбор · блоки и все полные диффы', render: () => <GuidedGallery page="guided-1" /> },
    { id: 'guided-file', group: 'По диффу', title: 'Файл · полный дифф и пояснение важных строк', render: () => <GuidedGallery page={`file:${guided.first.fileId}`} /> },
    { id: 'guided-pending', group: 'По диффу', title: 'Дифф доступен до готовности пояснений', render: () => <GuidedGallery page={`file:${guided.first.fileId}`} pending /> },
];
