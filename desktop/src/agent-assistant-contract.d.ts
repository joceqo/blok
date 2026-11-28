import type {AgentModel} from '../../types/api';
import type {CliCommand,CliStatus} from '../../src/shell/agent-model';
export interface AgentAssistantOptions {
  acceptAttachments?: boolean;
  chatLinks?: ReturnType<typeof import('./chat-link').chatLinks>;
  onOpenChange?(open: boolean): void;
  workspaceSearch?: {
    find(query: string, signal: AbortSignal): Promise<{id: string; title: string; excerpt: string; blockId?: string}[]>;
    open(id: string, blockId?: string): void;
  };
  editPage?: { available(): boolean; open(): void };
  getPageText(): string;
  getPageTitle?(): string;
  openSettings(): void;
  inspectProvider?: (command:CliCommand,signal:AbortSignal)=>Promise<CliStatus>;
  modelFor?(providerId:string,onProgress:(status:string)=>void):AgentModel;
  preferredProvider?:()=>string|null;
  listProviders?:(signal:AbortSignal)=>Promise<{id:string;label:string}[]>;
  onProviderSelected?:(id:string)=>void;
}
export interface AgentAssistantHandle {
  searchableChats(): {id: string; title: string; excerpt: string}[];
  openChat(id: string): void;
  newChat(): void;
  refreshPageActions(): void;
  element:HTMLElement;editorSlot:HTMLElement;open():void;close():void;destroy():void;refreshProviders():Promise<void>;
}
export function mountAgentAssistant(options:AgentAssistantOptions):AgentAssistantHandle;
