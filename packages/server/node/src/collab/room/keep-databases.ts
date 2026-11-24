import type { OutputData, OutputBlockData } from '../../../../../../types/data-formats/output-data.ts';

export function keepDatabases(live: OutputData, target: OutputData) {
  type Block = OutputBlockData & { id: string };
  const identified = (blocks: OutputBlockData[]): Block[] =>
    blocks.filter((b): b is Block => typeof b.id === 'string');
  const current = identified(live.blocks),
    historical = identified(target.blocks);
  const byParent = (blocks: Block[]) => {
    const children = new Map<string, string[]>();
    for (const block of blocks) {
      const key = block.parent ?? '';
      const group = children.get(key) ?? [];
      group.push(block.id);
      children.set(key, group);
    }
    return children;
  };
  const liveChildren = byParent(current),
    historicChildren = byParent(historical);
  const pinned = new Set<string>();
  const todo = current
    .concat(historical)
    .filter((b) => b.type === 'database')
    .map((b) => b.id);
  while (todo.length) {
    const id = todo.pop()!;
    if (pinned.has(id)) continue;
    pinned.add(id);
    for (const child of liveChildren.get(id) ?? []) todo.push(child);
    for (const child of historicChildren.get(id) ?? []) todo.push(child);
  }
  const old = new Map(historical.filter((b) => !pinned.has(b.id)).map((b) => [b.id, b]));
  const existing = new Map(current.map((b) => [b.id, b]));
  const roots = new Map<string, string[]>(),
    after = new Map<string, string[]>(),
    last = new Map<string, string>();
  const orphans = new Set<string>();
  const append = (map: Map<string, string[]>, key: string, id: string) => {
    const children = map.get(key) ?? [];
    children.push(id);
    map.set(key, children);
  };
  for (const b of current) {
    const key = b.parent ?? '';
    if (!pinned.has(b.id)) {
      const restored = old.get(b.id);
      if (restored && (restored.parent ?? '') === key) last.set(key, b.id);
      continue;
    }
    if (key && pinned.has(key) && existing.has(key)) continue;
    if (key && !old.has(key)) {
      orphans.add(b.id);
      continue;
    }
    const prior = last.get(key);
    if (prior) append(after, prior, b.id);
    else append(roots, key, b.id);
    last.set(key, b.id);
  }
  const placed = new Map<string, string[]>();
  const follow = (parent: string, ids: string[]) => {
    const stack = ids.slice().reverse();
    while (stack.length) {
      const id = stack.pop()!;
      append(placed, parent, id);
      const adjacent = after.get(id);
      if (adjacent) for (let index = adjacent.length - 1; index >= 0; index--) stack.push(adjacent[index]!);
    }
  };
  for (const [key, ids] of roots) follow(key, ids);
  for (const b of historical) if (old.has(b.id)) follow(b.parent ?? '', [b.id]);
  for (const id of orphans) append(placed, '', id);
  const stack = (placed.get('') ?? []).slice().reverse();
  const blocks: Block[] = [];
  while (stack.length) {
    const id = stack.pop()!;
    const b = pinned.has(id) ? existing.get(id) : old.get(id);
    if (!b) continue;
    if (orphans.has(id)) {
      const root = { ...b };
      delete root.parent;
      blocks.push(root);
    } else blocks.push(b);
    const children = (pinned.has(id) ? liveChildren : placed).get(id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return { blocks, orphans: [...orphans], pinned };
}
