import type { Meta, StoryObj } from '@storybook/html-vite';
import { expect, userEvent, within } from 'storybook/test';
import { mountShareSheet, type PageAccessSheet } from '../../desktop/src/cloud/share-sheet';
import '../../desktop/src/cloud/share-sheet.css';
import { PreviewClient, shellPreview, type ShellTheme } from './shell-story-fixtures';

const meta = {
  title:'Shell/Partage', id:'shell-partage', parameters:{layout:'fullscreen'},
  args:{theme:'dark', manage:true},
  argTypes:{theme:{name:'Thème',control:'inline-radio',options:['light','dark']}, manage:{table:{disable:true}}},
  render: ({theme,manage},{abortSignal}) => {
    const host = shellPreview(theme);
    const panel = document.createElement('section');
    panel.setAttribute('data-cloud-share-dialog',''); panel.setAttribute('aria-label','Partager la feuille de route');
    panel.style.margin = '12px 8px 12px auto'; panel.style.maxWidth = 'calc(100% - 16px)';
    const heading = document.createElement('h2'); heading.textContent = 'Partager';
    panel.append(heading); host.append(panel);
    const members = [{id:'lou',name:'Lou',email:'lou@example.test',role:'admin'},
      {id:'camille',name:'Camille Martin',email:'cm@example.test',role:'viewer'},
      {id:'alex',name:'Alex',email:'alex@example.test',role:'member'}];
    const access: PageAccessSheet = {visibility:'private',effectiveVisibility:'private',myLevel:manage?'full':'view',
      shares:[{userId:'lou',email:'lou@example.test',level:'full'}],inherited:[]};
    const base = '/api/workspaces/atelier/pages/route';
    const client = new PreviewClient((path,init) => {
      if (path === base + '/access' && !init?.method) return {...access,shares:[...access.shares]};
      if (path === '/api/workspaces/atelier/members' && manage) return {members};
      if (manage && init?.method === 'PUT' && path === base + '/access') {
        const visibility = JSON.parse(String(init.body)).visibility;
        access.visibility = visibility; access.effectiveVisibility = visibility === 'inherit' ? 'private' : visibility;
        return {ok:true};
      }
      const target = members.find(member => path === base + '/shares/' + member.id);
      if (manage && target && (init?.method === 'PUT' || init?.method === 'DELETE')) {
        access.shares = access.shares.filter(entry => entry.userId !== target.id);
        if (init.method === 'PUT') access.shares.push({userId:target.id,email:target.email,level:JSON.parse(String(init.body)).level});
        return {ok:true};
      }
      throw Error('Opération indisponible.');
    });
    const sheet = mountShareSheet(panel,{client,slug:'atelier',pageId:'route',pageTitle:'Feuille de route',accountId:manage?'lou':'camille'});
    abortSignal.addEventListener('abort',()=>sheet.destroy(),{once:true});return host;
  },
} satisfies Meta<{theme:ShellTheme;manage:boolean}>;
export default meta;
type Story = StoryObj<{theme:ShellTheme;manage:boolean}>;

export const ChoisirUnMembre: Story = {
  name:'Choisir un membre',
  play:async ({canvasElement}) => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('combobox',{name:'Ajouter une personne'});
    await userEvent.type(field,'camille');
    const option = await canvas.findByRole('option',{name:/Camille Martin/});
    await expect(option).toBeVisible();
  },
};
export const LectureSeule: Story = {
  args:{manage:false},
  play:async ({canvasElement}) => {
    const canvas=within(canvasElement);
    await expect(await canvas.findByText('lou@example.test')).toBeVisible();
    await expect(canvas.queryByRole('combobox',{name:'Ajouter une personne'})).toBeNull();
  },
};
