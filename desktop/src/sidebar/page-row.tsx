import {shellText} from '../shell-i18n';
import { useRef, useState } from 'react';
import type { ShellPage } from '@blok/sidebar';
import { isImageIcon } from '../../../src/shell/page-icon';
import { Button, TextField } from '../components';
import { SidebarIcon } from './sidebar-icon';
import { SidebarPageMenu } from './sidebar-page-menu';
import { useTree } from './tree-context';

const PageIcon = ({ icon }: { icon?: string }) => {
  if (!icon) return <SidebarIcon name="page" />;
  if (!isImageIcon(icon)) return <>{icon}</>;
  return (
    <img
      src={icon}
      alt=""
      draggable={false}
      referrerPolicy="no-referrer"
      style={{ width: '1em', height: '1em', objectFit: 'contain' }}
    />
  );
};

interface RenameFieldProps {
  page: ShellPage;
  finish(title?: string): void;
}

const RenameField = ({ page, finish }: RenameFieldProps) => {
  const done = useRef(false);
  function commit(title?: string) {
    if (done.current) return;
    done.current = true;
    finish(title?.trim());
  }
  return (
    <TextField
      appearance="inline"
      data-blok-sidebar-rename=""
      aria-label={shellText("Renommer {v0}", {v0: page.title})}
      defaultValue={page.title}
      ref={(node) => {
        if (node) {
          node.focus();
          node.select();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        e.preventDefault();
        commit(e.key === 'Enter' ? e.currentTarget.value : undefined);
      }}
    />
  );
};

interface PageRowProps {
  page: ShellPage;
  depth?: number;
  shortcut?: boolean;
}

export const PageRow = ({ page, depth = 0, shortcut = false }: PageRowProps) => {
  const tree = useTree();
  const { options } = tree;
  const children = shortcut ? [] : (tree.children.get(page.id) ?? []);
  const open =
    children.length > 0 &&
    (!!tree.query || (tree.expanded.get(page.id) ?? !options.collapsedByDefault));
  const active = tree.activeId === page.id;
  const [renaming, setRenaming] = useState(false);
  const glyph = (
    <span
      data-blok-sidebar-glyph=""
      aria-hidden="true"
    >
      <PageIcon icon={page.icon} />
    </span>
  );
  return (
    <>
      <div
        data-blok-sidebar-row=""
        data-active={active ? '' : undefined}
        style={{ paddingInlineStart: 8 + depth * 8 }}
      >
        {children.length ? (
          <Button
            variant="plain"
            type="button"
            data-blok-sidebar-toggle=""
            aria-label={open ? shellText("Replier") : shellText("Déplier")}
            aria-expanded={open}
            onClick={() => tree.onExpand(page.id, !open)}
          >
            {glyph}
            <span
              data-blok-sidebar-chevron=""
              data-open={open ? '' : undefined}
              aria-hidden="true"
            >
              <SidebarIcon name="chevron" />
            </span>
          </Button>
        ) : (
          <span
            data-blok-sidebar-leaf=""
            aria-hidden="true"
          >
            {glyph}
          </span>
        )}
        {renaming ? (
          <RenameField
            page={page}
            finish={(title) => {
              setRenaming(false);
              if (title && title !== page.title)
                options.onAction?.({ type: 'rename', id: page.id, title });
            }}
          />
        ) : (
          <Button
            variant="plain"
            type="button"
            data-blok-sidebar-link=""
            title={page.title}
            aria-current={active ? 'page' : undefined}
            onClick={() => options.onOpen(page.id)}
          >
            <span data-blok-sidebar-label="">{page.title}</span>
          </Button>
        )}
        <SidebarPageMenu
          page={page}
          options={options}
          offline={tree.offline.has(page.id)}
          toggleOffline={() => tree.toggleOffline(page.id)}
          onFavorite={() => tree.onFavorite(page.id)}
          onRename={() => setRenaming(true)}
        />
        <Button
          variant="plain"
          type="button"
          data-blok-sidebar-add=""
          hidden={options.canCreate?.(page.id) === false}
          aria-label={shellText("Ajouter une sous-page")}
          title={shellText("Ajouter une sous-page")}
          onClick={() => {
            tree.onExpand(page.id, true);
            options.onCreate(page.id);
          }}
        >
          <SidebarIcon name="plus" />
        </Button>
      </div>
      {open &&
        children.map((child) => (
          <PageRow
            key={child.id}
            page={child}
            depth={depth + 1}
          />
        ))}
    </>
  );
};
