export interface BlockTreeState { open: boolean; directoriesOpen: boolean; toggled: ReadonlySet<string> }
export interface RouteTreeState { active: string | null; reveal: number; blocks: ReadonlyMap<string, BlockTreeState> }
export type RouteTreeAction =
    | { kind: 'activate'; id: string | null; reveal: number }
    | { kind: 'block'; id: string }
    | { kind: 'directory'; id: string; path: string }
    | { kind: 'all'; ids: string[]; open: boolean };

export const closedBlockTree: BlockTreeState = { open: false, directoriesOpen: false, toggled: new Set() };
export function createRouteTree(active: string | null, reveal: number): RouteTreeState {
    return { active, reveal, blocks: new Map(active === null ? [] : [[active, { open: true, directoriesOpen: true, toggled: new Set() }]]) };
}

/** Сворачивание вручную важнее слежения за файлом внутри того же блока. */
export function routeTreeReducer(state: RouteTreeState, action: RouteTreeAction): RouteTreeState {
    if (action.kind === 'activate') {
        if (state.active === action.id && state.reveal === action.reveal) return state;
        return { ...state, active: action.id, reveal: action.reveal, blocks: action.id === null ? state.blocks : new Map(state.blocks).set(action.id, { open: true, directoriesOpen: true, toggled: new Set() }) };
    }
    if (action.kind === 'all') return { ...state, blocks: new Map(action.ids.map((id) => [id, { open: action.open, directoriesOpen: action.open, toggled: new Set<string>() }])) };
    const block = state.blocks.get(action.id) ?? closedBlockTree;
    if (action.kind === 'block') return { ...state, blocks: new Map(state.blocks).set(action.id, { ...block, open: !block.open }) };
    const toggled = new Set(block.toggled);
    if (toggled.has(action.path)) toggled.delete(action.path); else toggled.add(action.path);
    return { ...state, blocks: new Map(state.blocks).set(action.id, { ...block, toggled }) };
}
