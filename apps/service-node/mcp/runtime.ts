import { AsyncLocalStorage } from 'node:async_hooks';
import { publicMcpActor } from '../src/shell/agent-identity.ts';
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { createBlok } from '../../../src/mcp/embed';
import type { HostedMcpOptions } from '../src/shell/hosted-mcp.ts';

const hostTool = (name: string, description: string, fields: string[], required = fields): Tool => ({
  name, description,
  inputSchema: {type:'object',properties:Object.fromEntries(fields.map(k => [k,{type:'string'}])),required,additionalProperties:false},
});
const tools:Tool[] = [
  hostTool('blok_list_databases','List readable databases and their filterable columns and options.',['workspace']),
  {name:'blok_query_database',description:'Count all matching rows and list up to 50 row IDs and titles in document order. Filters use exact equality (membership for multiSelect) and combine with AND. For the next page pass nextOffset as offset.',
    inputSchema:{type:'object',properties:{workspace:{type:'string'},page:{type:'string'},database:{type:'string'},
      filters:{type:'array',maxItems:8,items:{type:'object',properties:{column:{type:'string'},value:{type:'string'}},required:['column','value'],additionalProperties:false}},
      offset:{type:'integer',minimum:0}},required:['workspace','page','database','filters'],additionalProperties:false}},
  hostTool('blok_list_workspaces','List workspaces available to this account.',[]),
  hostTool('blok_list_pages','List visible pages in the workspace.',['workspace']),
  hostTool('blok_create_page','Create a page in a writable workspace.',['workspace','title','parentId'],['workspace','title']),
  hostTool('blok_upload_image','Store a private workspace image (PNG, JPEG, GIF or WebP, up to 5 MiB).',['workspace','dataUrl']),
];
export function hostedMcp(options: HostedMcpOptions) {
  const account = new AsyncLocalStorage<{principal:string; owner:string}>();
  const blok = createBlok({
    sync: {url:options.syncUrl,origin:options.origin},
    tickets:{kind:'secret',secret:options.ticketSecret,subject:'principal'},
    authorize:options.authorize,
    agentActor(principal,name) {
      const caller = account.getStore();
      if (!caller || caller.principal !== principal) throw new Error('Missing authenticated agent owner');
      return {id:publicMcpActor(principal), name, kind:'agent', onBehalfOf:caller.owner};
    },
  });
  const http = createMcpHandler(() => {
    const server = new Server({name:'blok-cloud',version:'1.0.0'},{
      instructions:'List workspaces and pages to find a document ID. Open it live to read or edit.\n\n'+blok.instructions,
    });
    blok.attach(server,{tools,callTool:async (req,ctx) => {
      const principal = ctx.http?.authInfo?.extra?.sub;
      if (typeof principal !== 'string') throw new Error('Missing principal');
      return options.call(principal,req.params.name,req.params.arguments ?? {});
    }});
    return server;
  });
  return {
    fetch:(req: Request,principal: string,owner:string) => account.run({principal,owner}, () =>
      http.fetch(req,{authInfo:{token:'',clientId:'blok-cloud',scopes:[],extra:{sub:principal}}})),
    close:async () => { await http.close(); await blok.close(); },
  };
}
