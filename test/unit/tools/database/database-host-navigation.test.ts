import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { API, BlockAPI, BlockToolConstructorOptions } from '../../../../types';
import type { DatabaseConfig, DatabaseData, DatabaseRowData } from '../../../../src/tools/database/types';
import { DatabaseTool } from '../../../../src/tools/database';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const createMockRowBlock = (options: {
  id: string;
  properties: Record<string, unknown>;
  position: string;
  pageId?: string;
}): BlockAPI => ({
  id: options.id,
  name: 'database-row',
  holder: document.createElement('div'),
  preservedData: {
    properties: options.properties,
    position: options.position,
    ...(options.pageId !== undefined ? { pageId: options.pageId } : {}),
  } as DatabaseRowData,
  call: vi.fn(),
  dispatchChange: vi.fn(),
} as unknown as BlockAPI);

const createMockAPI = (childBlocks: BlockAPI[] = []): API => ({
  styles: {
    block: 'blok-block',
    inlineToolbar: 'blok-inline-toolbar',
    inlineToolButton: 'blok-inline-tool-button',
    inlineToolButtonActive: 'blok-inline-tool-button--active',
    input: 'blok-input',
    loader: 'blok-loader',
    button: 'blok-button',
    settingsButton: 'blok-settings-button',
    settingsButtonActive: 'blok-settings-button--active',
  },
  i18n: {
    t: (key: string) =>
      key === 'tools.database.titlePlaceholder' ? 'New database' : key,
  },
  events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  blocks: {
    getCurrentBlockIndex: vi.fn().mockReturnValue(0),
    getBlocksCount: vi.fn().mockReturnValue(1),
    getBlockByIndex: vi.fn(),
    getChildren: vi.fn().mockReturnValue(childBlocks),
    insert: vi.fn().mockReturnValue({ id: 'new-row-id' }),
    insertAt: vi.fn().mockReturnValue({ id: 'new-row-id' }),
    delete: vi.fn(),
    setBlockParent: vi.fn(),
    getBlockIndex: vi.fn().mockReturnValue(0),
    getById: vi.fn(),
  },
  notifier: { show: vi.fn() },
  tools: { getBlockTools: vi.fn(() => []), getToolsConfig: vi.fn(() => ({ tools: undefined })) },
} as unknown as API);

const makeDefaultData = (overrides: Partial<DatabaseData> = {}): DatabaseData => ({
  schema: [
    { id: 'prop-title', name: 'Title', type: 'title', position: 'a0' },
    { id: 'prop-status', name: 'Status', type: 'select', position: 'a1', config: {
      options: [
        { id: 'opt-todo', label: 'Todo', color: 'gray', position: 'a0' },
        { id: 'opt-doing', label: 'Doing', color: 'blue', position: 'a1' },
        { id: 'opt-done', label: 'Done', color: 'green', position: 'a2' },
      ],
    }},
  ],
  views: [{ id: 'view-1', name: 'Board', type: 'board', position: 'a0', groupBy: 'prop-status', sorts: [], filters: [], visibleProperties: [] }],
  activeViewId: 'view-1',
  ...overrides,
});

const createDatabaseOptions = (
  dataOverrides: Partial<DatabaseData> = {},
  config: DatabaseConfig = {},
  overrides: { readOnly?: boolean; childBlocks?: BlockAPI[] } = {},
): BlockToolConstructorOptions<DatabaseData, DatabaseConfig> => ({
  data: makeDefaultData(dataOverrides),
  config,
  api: createMockAPI(overrides.childBlocks ?? []),
  readOnly: overrides.readOnly ?? false,
  block: { id: 'test-block-id', dispatchChange: vi.fn() } as never,
});

  it('passes the source database and body identity to host navigation, then renders that route without navigating again', () => {
    const navigate = vi.fn();
    const back=vi.fn();
    let current: {rowId:string;databaseId:string} | null = null;
    const row=createMockRowBlock({id:'row-1',properties:{'prop-title':'Task'},position:'a0',pageId:'body-1'});
    const second=createMockRowBlock({id:'row-2',properties:{'prop-title':'Second'},position:'a1',pageId:'body-2'});
    const options=createDatabaseOptions({}, {rowPages: {
      lookup: async () => null, copyFromLegacy: vi.fn(), reconcileLegacy: vi.fn(), mount: () => ({destroy:vi.fn()}), navigate,
      navigation: {current: () => current, back},
    }}, {childBlocks:[row,second]});
    const tool=new DatabaseTool(options);
    const wrapper=tool.render(); document.body.append(wrapper);
    tool.rendered();
    try {
      tool.openRow({rowId:row.id,mode:'full',explicit:true});
      expect(navigate).toHaveBeenCalledExactlyOnceWith(row.id,{databaseId:'test-block-id',pageId:'body-1'});
      current={rowId:row.id,databaseId:'test-block-id'};
      tool.openRow({rowId:row.id,mode:'full',explicit:true});
      expect(navigate).toHaveBeenCalledOnce();
      expect(wrapper.querySelector('[data-blok-database-drawer]')?.getAttribute('data-peek-mode')).toBe('full');
      tool.openRow({rowId:second.id,mode:'full',explicit:true});
      expect(back).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenLastCalledWith(second.id,{databaseId:'test-block-id',pageId:'body-2'});
    } finally { tool.destroy(); wrapper.remove(); }
  });
