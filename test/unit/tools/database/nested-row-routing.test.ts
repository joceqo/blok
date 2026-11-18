import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { API, BlockAPI, BlockToolConstructorOptions } from '../../../../types';
import type { DatabaseConfig, DatabaseData, DatabaseRowData } from '../../../../src/tools/database/types';
import { DatabaseTool } from '../../../../src/tools/database';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const rowBlock = (id: string, title: string, position: string, parentId: string): BlockAPI => ({
  id, name: 'database-row', parentId, holder: document.createElement('div'),
  preservedData: { properties: { 'prop-title': title }, position } as unknown as DatabaseRowData,
  call: vi.fn(), dispatchChange: vi.fn(),
} as unknown as BlockAPI);

const nestedDatabase = (id: string, parentId: string): BlockAPI => ({
  id, name: 'database', parentId, holder: document.createElement('div'),
  preservedData: { title: 'Tâches' } as never, call: vi.fn(), dispatchChange: vi.fn(),
} as unknown as BlockAPI);

const api = (blocks: BlockAPI[], children: BlockAPI[]): API => ({
  styles: { block: '', inlineToolbar: '', inlineToolButton: '', inlineToolButtonActive: '', input: '', loader: '', button: '', settingsButton: '', settingsButtonActive: '' },
  i18n: { t: (key: string) => key },
  events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  blocks: {
    getCurrentBlockIndex: vi.fn().mockReturnValue(0), getBlocksCount: vi.fn().mockReturnValue(1),
    getBlockByIndex: vi.fn(), getChildren: vi.fn().mockReturnValue(children),
    insert: vi.fn(), insertAt: vi.fn(), delete: vi.fn(), setBlockParent: vi.fn(),
    getBlockIndex: vi.fn().mockReturnValue(0),
    getById: vi.fn((id: string) => blocks.find(b => b.id === id) ?? null),
  },
  notifier: { show: vi.fn() },
  tools: { getBlockTools: vi.fn(() => []), getToolsConfig: vi.fn(() => ({ tools: undefined })) },
} as unknown as API);

const data = (): DatabaseData => ({
  schema: [{ id: 'prop-title', name: 'Title', type: 'title', position: 'a0' }],
  views: [{ id: 'view-1', name: 'Table', type: 'table', position: 'a0', sorts: [], filters: [], visibleProperties: [] }],
  activeViewId: 'view-1',
});

/**
 * A task lives in a database nested inside a sprint row's body, so the route
 * names a database this one does not own. Closing the drawer here strands the
 * task for good: the drawer is what would mount the database able to open it.
 * The sprint row must open instead, and the nested database finishes the trip.
 */
it('opens the row hosting a nested database instead of closing on its route', () => {
  const sprint = rowBlock('sprint-1', 'Sprint #1', 'a0', 'test-block-id');
  const tasks = nestedDatabase('tasks-db', 'sprint-1');
  let current: { rowId: string; databaseId: string } | null = null;
  const options: BlockToolConstructorOptions<DatabaseData, DatabaseConfig> = {
    data: data(), readOnly: false,
    block: { id: 'test-block-id', dispatchChange: vi.fn() } as never,
    api: api([sprint, tasks], [sprint]),
    config: { rowPages: {
      lookup: async () => null, copyFromLegacy: vi.fn(), reconcileLegacy: vi.fn(),
      mount: () => ({ destroy: vi.fn() }), navigate: vi.fn(),
      navigation: { current: () => current, back: vi.fn() },
    } },
  };
  const tool = new DatabaseTool(options);
  const wrapper = tool.render(); document.body.append(wrapper);
  tool.rendered();
  try {
    current = { rowId: 'task-1', databaseId: 'tasks-db' };
    window.dispatchEvent(new PopStateEvent('popstate'));

    const drawer = wrapper.querySelector('[data-blok-database-drawer]');

    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute('data-peek-mode')).toBe('full');
  } finally { tool.destroy(); wrapper.remove(); }
});

/** A route naming a database that is nowhere under this one still closes. */
it('still closes for a route that belongs to no row of this database', () => {
  const sprint = rowBlock('sprint-1', 'Sprint #1', 'a0', 'test-block-id');
  const elsewhere = nestedDatabase('other-db', 'some-other-block');
  let current: { rowId: string; databaseId: string } | null = { rowId: 'sprint-1', databaseId: 'test-block-id' };
  const options: BlockToolConstructorOptions<DatabaseData, DatabaseConfig> = {
    data: data(), readOnly: false,
    block: { id: 'test-block-id', dispatchChange: vi.fn() } as never,
    api: api([sprint, elsewhere], [sprint]),
    config: { rowPages: {
      lookup: async () => null, copyFromLegacy: vi.fn(), reconcileLegacy: vi.fn(),
      mount: () => ({ destroy: vi.fn() }), navigate: vi.fn(),
      navigation: { current: () => current, back: vi.fn() },
    } },
  };
  const tool = new DatabaseTool(options);
  const wrapper = tool.render(); document.body.append(wrapper);
  tool.rendered();
  try {
    tool.openRow({ rowId: 'sprint-1', mode: 'full', explicit: true });
    expect(wrapper.querySelector('[data-blok-database-drawer]')?.getAttribute('data-peek-mode')).toBe('full');
    current = { rowId: 'stranger', databaseId: 'other-db' };
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(wrapper.querySelector('[data-blok-database-drawer][data-peek-mode="full"]')).toBeNull();
  } finally { tool.destroy(); wrapper.remove(); }
});
