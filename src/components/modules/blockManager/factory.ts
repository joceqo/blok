/**
 * @class BlockFactory
 * @classdesc Creates Block instances with proper configuration
 * @module BlockFactory
 */
import type { BlokModules } from '../../../types-internal/blok-modules';
import { Block } from '../../block';
import { ToolNotFoundError } from '../../errors/tool-not-found';
import type { BlokEventMap } from '../../events';
import type { BlockToolAdapter } from '../../tools/block';
import type { ToolsCollection } from '../../tools/collection';
import type { EventsDispatcher } from '../../utils/events';
import { log } from '../../utils';
import { applyBlockMigration } from '../../migration/block-migrations';
import type { BlockMigrations } from '../../migration/block-migrations';
import { richTextInputToHtml } from '../../utils/rich-text-input';
import type { API } from '../api';

import type { BlockOrigin } from '../../../../types';
import type { ComposeBlockOptions } from './types';
import { claimEagerRoot, countViewport, isAsleep, OFFSCREEN_ATTRIBUTE, sleepBlock } from '../../utils/viewport-render';

/**
 * Dependencies needed by BlockFactory
 */
export interface BlockFactoryDependencies {
  /** Blok API instance */
  API: API;
  /** Events dispatcher */
  eventsDispatcher: EventsDispatcher<BlokEventMap>;
  /** Map of available block tools */
  tools: ToolsCollection<BlockToolAdapter>;
  /** All module instances */
  moduleInstances: BlokModules;
  /**
   * Host-supplied per-type block-migration rules from editor config
   * (`config.migrations`). Applied at load, after each Tool's own `upgradeData`.
   */
  migrations?: BlockMigrations;
  /** Called with every Block built here, before it joins the document. */
  onComposed?: (block: Block, origin: BlockOrigin) => void;
  getBlockById?: (id: string) => Block | undefined;
}

/**
 * BlockFactory creates Block instances with proper configuration
 */
export class BlockFactory {
  private readonly dependencies: BlockFactoryDependencies;
  private readonly bindBlockEvents: (block: Block) => void;
  private readonly bindBlockChanges: (block: Block) => void;

  /**
   * Get the current read-only state from ReadOnly module
   */
  private get readOnlyState(): boolean {
    return this.dependencies.moduleInstances.ReadOnly.isEnabled;
  }

  /** Row metadata stays live; only content below a closed row defers its tool DOM. */
  private isClosedRowBody(parentId: string | null | undefined): boolean {
    const modules = this.dependencies.moduleInstances;
    const seen = new Set<string>();
    const cursor = { id: parentId };

    while (typeof cursor.id === 'string' && !seen.has(cursor.id)) {
      const id = cursor.id;
      seen.add(id);
      const live = this.dependencies.getBlockById?.(id) ?? modules.BlockManager?.getBlockById?.(id);
      const record = live === undefined ? modules.YjsManager?.getBlockById?.(id) : undefined;
      const name = live?.name ?? record?.get('type');

      if (name === 'database-row' && (live === undefined || live.holder.classList.contains('hidden'))) return true;
      const parent: unknown = live?.parentId ?? record?.get('parentId');

      cursor.id = typeof parent === 'string' ? parent : undefined;
    }

    return false;
  }

  /**
   * A block whose ancestor has no DOM yet must not draw either: its holder
   * would be moved into the sleeping parent's placeholder and rendered for
   * nobody. Walks parents exactly like `isClosedRowBody`, through live blocks
   * first and the Yjs record when the block is not built yet.
   * @param parentId - the block's parent, if it has one
   * @returns whether some ancestor is still asleep
   */
  private hasSleepingAncestor(parentId: string | null | undefined): boolean {
    const modules = this.dependencies.moduleInstances;
    const seen = new Set<string>();
    const cursor = { id: parentId };

    while (typeof cursor.id === 'string' && !seen.has(cursor.id)) {
      const id = cursor.id;

      seen.add(id);
      if (isAsleep(id)) return true;
      const live = this.dependencies.getBlockById?.(id) ?? modules.BlockManager?.getBlockById?.(id);
      const record = live === undefined ? modules.YjsManager?.getBlockById?.(id) : undefined;
      const parent: unknown = live?.parentId ?? record?.get('parentId');

      cursor.id = typeof parent === 'string' ? parent : undefined;
    }

    return false;
  }

  /**
   * Whether this block may skip its first render because nobody can see it.
   *
   * A root past the first few screens sleeps; so does anything under a
   * sleeper. A database row never does — its metadata stays live — and neither
   * does pasted content, which the person is waiting to see.
   * @param name - the tool's name
   * @param parentId - the block's parent, if it has one
   * @param origin - what produced the block
   * @returns whether to leave the tool without DOM for now
   */
  private sleepsForViewport(name: string, parentId: string | null | undefined, origin: BlockOrigin | undefined): boolean {
    if (name === 'database-row' || origin === 'paste') {
      return false;
    }

    // Asked for EVERY block, and `claimEagerRoot` spends the budget, so it is
    // asked once per root and never for a child.
    if (parentId !== undefined && parentId !== null) {
      countViewport('withParent');

      return this.hasSleepingAncestor(parentId);
    }

    return !claimEagerRoot();
  }

  /**
   * @param dependencies - Required dependencies
   * @param bindBlockEvents - Function to bind events to a block
   * @param bindBlockChanges - Function to subscribe to a block's changes; runs at once
   */
  constructor(
    dependencies: BlockFactoryDependencies,
    bindBlockEvents: (block: Block) => void,
    bindBlockChanges: (block: Block) => void
  ) {
    this.dependencies = dependencies;
    this.bindBlockEvents = bindBlockEvents;
    this.bindBlockChanges = bindBlockChanges;
  }

  /**
   * Creates Block instance by tool name
   * @param options - block creation options
   * @returns {Block}
   */
  public composeBlock(options: ComposeBlockOptions): Block {
    // Temporary boot diagnostic: the 849 blocks of a load go through neither
    // Renderer.render nor handleYjsBatchAdd — this says which path builds them.
    const probe = (globalThis as { __blokComposeProbe?: { count: number; stacks: Record<string, number> } }).__blokComposeProbe;

    if (probe !== undefined) {
      probe.count++;
      if (probe.count <= 400) {
        const key = (new Error().stack ?? '').split('\n').slice(2, 9).map(line => line.trim()).join(' <- ').slice(0, 500);

        probe.stacks[key] = (probe.stacks[key] ?? 0) + 1;
      }
    }

    const {
      tool: name,
      data = {},
      id,
      tunes: tunesData = {},
      parentId,
      contentIds,
      bindEventsImmediately = false,
      lastEditedAt,
      lastEditedBy,
      lastEditedWith,
      createdAt,
      createdBy,
      createdWith,
      origin = 'api',
      replaySource,
      deferRender,
      renderedBarrier,
    } = options;

    const tool = this.dependencies.tools.get(name);

    if (tool === undefined) {
      throw new ToolNotFoundError(name, `Could not compose Block. Tool «${name}» not found.`);
    }

    // Give the Tool a chance to upgrade a legacy data shape it once wrote into
    // the shape it reads today — the per-tool migration core's global grammar
    // cannot know about (columns, custom media). No-op unless the Tool declares
    // a static `upgradeData`; a throwing hook falls back to the stored data.
    const resolveTool = (toolName: string): BlockToolAdapter | undefined => this.dependencies.tools.get(toolName);
    const upgradedData = tool.upgradeData(richTextInputToHtml(tool, data ?? {}, resolveTool));

    // Apply the host's own config-level migration for this type on top of the
    // Tool's `upgradeData` — the rules a host declares from the OUTSIDE for a
    // tool it doesn't own (or its own tool without editing the class). A
    // throwing rule falls back to the pre-migration data, never a blank editor.
    // Converted again: a host migration may itself return segments.
    const migratedData = richTextInputToHtml(tool, applyBlockMigration(
      name,
      upgradedData,
      this.dependencies.migrations,
      (migratedType, error) => log(`Migration for block «${migratedType}» threw; loading the block with its stored data instead.`, 'warn', error)
    ), resolveTool);

    // Spends the eager-root budget, so it must run once per block, before the
    // block exists — `shouldDeferRender` re-reads the answer from the set.
    const viewportSleep = deferRender === undefined && this.sleepsForViewport(name, parentId, origin);

    if (viewportSleep) {
      sleepBlock(id);
    }

    const block: Block = new Block({
      id,
      // Wire DTOs (e.g. Editor.js backends) may carry `data: null`; the
      // destructuring default above only covers `undefined`.
      data: migratedData,
      tool,
      api: this.dependencies.API,
      readOnly: this.readOnlyState,
      tunesData,
      parentId,
      contentIds,
      bindMutationWatchersImmediately: bindEventsImmediately,
      lastEditedAt,
      lastEditedBy,
      lastEditedWith,
      createdAt,
      createdBy,
      createdWith,
      origin,
      replaySource,
      // Paste waits for ready before onPaste can import its DOM; it must not
      // wait indefinitely behind a closed row.
      deferRender: name !== 'database-row' && origin !== 'paste'
        && (deferRender ?? (this.isClosedRowBody(parentId) || viewportSleep)),
      shouldDeferRender: () => this.isClosedRowBody(block.parentId)
        || isAsleep(block.id) || this.hasSleepingAncestor(block.parentId),
      renderDeferredWithoutCapture: (render) => this.dependencies.moduleInstances.YjsManager.transactWithoutCapture(() => {
        render();
        this.dependencies.moduleInstances.Renderer?.normalizeRenderedDom?.(block.holder);
      }),
      renderedBarrier,
    }, this.dependencies.eventsDispatcher);

    // Stands in for the block's height until something scrolls near it.
    if (viewportSleep) block.holder.setAttribute(OFFSCREEN_ATTRIBUTE, '');

    // Closed until its database explicitly opens it. This must already hold
    // while a large load is between composition and the database's hooks.
    if (name === 'database-row' && parentId !== undefined) block.holder.classList.add('hidden');

    this.dependencies.onComposed?.(block, origin);

    if (this.readOnlyState) {
      return block;
    }

    // Only the DOM listeners wait for idle (one scan of the listener list per
    // block). A change the tool dispatches meanwhile would be lost.
    this.bindBlockChanges(block);

    if (bindEventsImmediately) {
      this.bindBlockEvents(block);
    } else {
      window.requestIdleCallback(() => {
        this.bindBlockEvents(block);
      }, { timeout: 2000 });
    }

    return block;
  }

  /**
   * Check if a tool exists
   * @param name - tool name
   * @returns true if tool exists
   */
  public hasTool(name: string): boolean {
    return this.dependencies.tools.has(name);
  }

  /**
   * Get a tool by name
   * @param name - tool name
   * @returns tool or undefined
   */
  public getTool(name: string): ReturnType<BlockFactoryDependencies['tools']['get']> {
    return this.dependencies.tools.get(name);
  }
}
