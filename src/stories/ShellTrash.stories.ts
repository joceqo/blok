import type {Meta, StoryObj} from '@storybook/html-vite';
import {expect, userEvent, within} from 'storybook/test';
import {openRemoteTrash} from '../../desktop/src/cloud/trash';
import {PreviewClient, shellPreview, type ShellTheme} from './shell-story-fixtures';
import '../../desktop/src/navigation-dialogs.css';

type Args = {theme: ShellTheme};
const meta = {
  title:'Shell/Corbeille', id:'shell-corbeille', parameters:{layout:'fullscreen'}, args:{theme:'dark'},
  argTypes:{theme:{name:'Thème',control:'inline-radio',options:['light','dark']}},
  render: ({theme}, {abortSignal}) => {
    const host = shellPreview(theme);
    const ref = {kind:'remote',id:'atelier',workspaceId:'atelier',name:'Atelier',role:'admin',server:'https://blok.example.test',accountId:'lou'} as const;
    const entries = [
      {id:'brief',title:'Brief de lancement',parentId:null},
      {id:'decisions',title:'Décisions',parentId:'brief'},
    ];
    const trash = new Set(entries.map(page=>page.id));
    let revision = 4;
    const base = '/api/workspaces/atelier';
    const client = new PreviewClient((path, init) => {
      if (path === base + '/index') return {
        revision, trash:entries.filter(page=>trash.has(page.id)), pages:entries.filter(page=>!trash.has(page.id)),
        access:Object.fromEntries(entries.map(page=>[page.id,{level:'full'}])),
      };
      const page = entries.find(entry=>path===base+'/pages/'+entry.id+'/restore-from-trash');
      if (page && init?.method === 'POST' && JSON.parse(String(init.body)).revision === revision && !trash.has(page.parentId ?? '') && trash.delete(page.id)) {
        return {restored:page.id,revision:++revision};
      }
      const purged = entries.find(entry=>path===base+'/pages/'+entry.id+'/purge');
      if (purged && init?.method === 'DELETE' && !entries.some(entry=>entry.parentId===purged.id) && trash.delete(purged.id)) {
        entries.splice(entries.indexOf(purged),1); revision++; return {purged:purged.id};
      }
      throw new Error('Cette action est indisponible.');
    });
    queueMicrotask(() => {
      if (abortSignal.aborted) return;
      const close = openRemoteTrash(ref, async()=>{}, async()=>{}, client);
      abortSignal.addEventListener('abort',close,{once:true});
    });
    return host;
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

export const PagesSupprimees: Story = {
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole('button',{name:'Restaurer « Brief de lancement »'})).toBeEnabled();
    await expect(page.getByRole('button',{name:'Restaurer « Décisions »'})).toBeDisabled();
  },
};
export const Restauration: Story = {
  play: async ({canvasElement}) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button',{name:'Restaurer « Brief de lancement »'}));
    await expect(await page.findByText('« Brief de lancement » a été restaurée.')).toBeVisible();
    await expect(page.getByRole('button',{name:'Restaurer « Décisions »'})).toBeEnabled();
  },
};
