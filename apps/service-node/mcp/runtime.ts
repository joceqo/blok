import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { createBlok } from '../../../src/mcp/embed';
import type { HostedMcpOptions } from '../src/shell/hosted-mcp.ts';

const hostTool = (name: string, description: string, fields: string[], required = fields): Tool => ({
  name, description,
  inputSchema: {type:'object',properties:Object.fromEntries(fields.map(k => [k,{type:'string'}])),required,additionalProperties:false},
});
const tools = [
  hostTool('blok_list_workspaces','List workspaces available to this account.',[]),
  hostTool('blok_list_pages','List visible pages in the workspace.',['workspace']),
  hostTool('blok_create_page','Create a page in a writable workspace.',['workspace','title','parentId'],['workspace','title']),
  hostTool('blok_upload_image','Store a private workspace image (PNG, JPEG, GIF or WebP, up to 5 MiB).',['workspace','dataUrl']),
];
export function hostedMcp(options: HostedMcpOptions) {
  const blok = createBlok({
    sync: {url:options.syncUrl,origin:options.origin},
    tickets:{kind:'secret',secret:options.ticketSecret},
    authorize:options.authorize,
    agentActor:(principal,name) => ({id:principal,name,kind:'agent'}),
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
    fetch:(req: Request,principal: string) => http.fetch(req,{authInfo:{token:'',clientId:'blok-cloud',scopes:[],extra:{sub:principal}}}),
    close:async () => { await http.close(); await blok.close(); },
  };
}
