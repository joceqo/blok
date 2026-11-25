import type { Meta, StoryObj } from '@storybook/html-vite';
import {expect,userEvent,within} from 'storybook/test';
import {openTeamspaces} from '../../desktop/src/cloud/teamspaces';
import {PreviewClient,shellPreview,type ShellTheme} from './shell-story-fixtures';

const meta={
  title:'Shell/Espaces d’équipe',id:'shell-equipes',parameters:{layout:'fullscreen'},
  args:{theme:'dark'},argTypes:{theme:{name:'Thème',control:'inline-radio',options:['light','dark']}},
  render:({theme},{abortSignal,viewMode})=>{
    const host=shellPreview(theme);
    const launcher=document.createElement('button');launcher.type='button';launcher.textContent='Espaces d’équipe';launcher.className='blok-button';
    const title=document.createElement('h1');title.textContent='Atelier';host.append(launcher,title);
    const teams=[{id:'p',name:'Équipe produit'},{id:'d',name:'Design'}];
    const pages=[{id:'brief',title:'Brief produit'},{id:'agenda',title:'Calendrier de lancement'}];
    const client=new PreviewClient(path=>{
      if(path.endsWith('/teamspaces'))return {teamspaces:teams};
      if(path.endsWith('/members'))return {members:[]};
      if(path.endsWith('/pages'))return {pages:path.includes('/d/') ? [{id:'maquettes',title:'Maquettes'}] : pages};
      throw Error('Opération indisponible.');
    });
    let close:(()=>void)|undefined;
    launcher.onclick=()=>{close?.();close=openTeamspaces({kind:'remote',id:'atelier',server:'https://example.test',workspaceId:'atelier',name:'Atelier',
      accountId:'lou',role:'viewer'}, {pages:()=>pages,canEdit:()=>false,open:async id=>{title.textContent=pages.find(page=>page.id===id)?.title??'Maquettes';}},client);};
    if(viewMode==='story')queueMicrotask(()=>{if(!abortSignal.aborted&&launcher.isConnected)launcher.click();});
    abortSignal.addEventListener('abort',()=>close?.(),{once:true});return host;
  },
} satisfies Meta<{theme:ShellTheme}>;
export default meta;
type Story=StoryObj<{theme:ShellTheme}>;
export const Repertoire:Story={
  name:'Répertoire et pages accessibles',
  play:async({canvasElement,viewMode})=>{
    if(viewMode!=='story')return;
    const screen=within(canvasElement.ownerDocument.body);
    const input=await screen.findByRole('searchbox',{name:'Rechercher une page de cette équipe'});
    await userEvent.type(input,'lancement');
    await expect(screen.getByRole('button',{name:'Calendrier de lancement'})).toBeVisible();
    await expect(screen.queryByRole('button',{name:'Brief produit'})).toBeNull();
  },
};

export const Parametres: Story = {
  name: 'Paramètres · tableau et création',
  render: ({theme}, {abortSignal}) => {
    const host = shellPreview(theme);
    const teams = [{id:'design', name:'Design', description:'Revues et maquettes', icon:'icon:paint:purple',
      isDefault:false, memberCount:1, joined:true, owners:[{userId:'lou',name:'Lou',email:''}], updatedAt:'2026-11-20', canManage:true}];
    let restrictCreation = false;
    const client = new PreviewClient((path,init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/teamspaces/settings')) {
        if (typeof body.restrictCreation === 'boolean') restrictCreation = body.restrictCreation;
        if (Array.isArray(body.defaultTeamspaceIds)) for (const team of teams) team.isDefault = body.defaultTeamspaceIds.includes(team.id);
        return {ok:true};
      }
      if (path.endsWith('/teamspaces')) {
        if (init?.method === 'POST') {
          const team = {...teams[0], id:crypto.randomUUID(), ...body, updatedAt:new Date().toISOString(), isDefault:false};
          teams.push(team);
          return {teamspace:team};
        }
        return {teamspaces:teams, settings:{restrictCreation}, canCreate:true};
      }
      if (path.endsWith('/members')) return {members:[{id:'lou',userId:'lou',name:'Lou',email:'',role:path.includes('/teamspaces/')?'owner':'admin',workspaceRole:'admin'}]};
      if (path.endsWith('/pages')) return {pages:[]};
      if (init?.method === 'PATCH') {
        const team = teams.find(item=>path.endsWith('/'+item.id));
        if (team) { Object.assign(team, body); return {teamspace:team}; }
      }
      if (init?.method === 'DELETE') {
        const index=teams.findIndex(item=>path.endsWith('/'+item.id)); if(index>=0){teams.splice(index,1);return {ok:true};}
      }
      throw Error('Opération indisponible dans cet exemple.');
    });
    const panel=document.createElement('main');panel.style.cssText='box-sizing:border-box;max-width:864px;width:100%;padding:36px 32px;margin:0 auto;';host.append(panel);
    const dispose=openTeamspaces({kind:'remote',id:'atelier',server:'https://example.test',workspaceId:'atelier',name:'Atelier',accountId:'lou',role:'admin'},
      {pages:()=>[],canEdit:()=>false,open:async()=>{}},client,panel);
    abortSignal.addEventListener('abort',dispose,{once:true});return host;
  },
  play:async({canvasElement,viewMode})=>{
    if(viewMode!=='story')return;
    const page=within(canvasElement);
    await expect(await page.findByRole('button',{name:'Nouvel espace d’équipe'})).toBeEnabled();
    await expect(page.getByRole('columnheader',{name:'Propriétaires'})).toBeVisible();
  },
};
