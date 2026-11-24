import type { BlokConfig } from '../../types';
import { openaiModel } from '../../src/agent-models/openai';
import type { AiClient } from './ai-client';

/** One mounted page. Navigation or a permission change ends its open editing turns. */
export function pageEditorAssistant(
  client: Pick<AiClient, 'available' | 'config' | 'editorRespond'>,
  canEdit: () => boolean,
  selected: () => string | null,
) {
  let scope = new AbortController();
  const scopeSignal = (): AbortSignal => {
    if (!canEdit()) throw new Error('L’édition IA nécessite une page active et modifiable.');
    return scope.signal;
  };
  const configuredModel = async (signal: AbortSignal): Promise<string> => {
    const configured = (await client.config(signal)).effective;
    if (configured.source === 'none' || !configured.model) {
      throw new Error('Configurez OpenAI dans les réglages IA pour modifier la page.');
    }
    const preferred = selected();
    return preferred?.startsWith('openai:') ? preferred.slice('openai:'.length) : configured.model;
  };
  const models = new WeakMap<AbortSignal, Promise<string>>();
  const agent: BlokConfig['agent'] = client.available ? {
    // Inserting a Page block invokes the host's workspace-wide page creation hook.
    overrides: { page: { hidden: true } },
    assistant: {
      name: 'OpenAI',
      scopeSignal,
      async model(request) {
        const check = (): void => { request.signal.throwIfAborted(); scopeSignal(); };
        check();
        const pending = models.get(request.signal) ?? configuredModel(request.signal);
        models.set(request.signal, pending);
        const model = await pending;
        check();
        const respond = openaiModel({
          model,
          maxTokens: 4096,
          send: (body, context) => client.editorRespond({...body, stream: false}, context.signal),
        }, {name: 'OpenAI', encryptedReasoning: true});
        const result = await respond(request);
        check();
        return result;
      },
    },
  } : undefined;
  return {
    agent,
    cancel(): void {
      scope.abort();
      scope = new AbortController();
    },
  };
}
