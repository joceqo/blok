import { describe, expect, it } from 'vitest';

import { assistantActions } from '../../../../../src/components/modules/assistant/actions';

import type { ActionContext, AssistantAction } from '../../../../../src/components/modules/assistant/actions';

const t = (key: string): string => `<${key}>`;
const actionOf = (context: ActionContext, id: string): AssistantAction | undefined =>
  assistantActions(context, t).find((action) => action.label === t(`assistant.action.${id}`));
const destinationOf = (context: ActionContext, id: string): string | undefined => actionOf(context, id)?.destination;
const insertOf = (context: ActionContext, id: string): string | undefined => actionOf(context, id)?.insert;

describe('assistantActions', () => {
  it('offers edits of the selected text when text is selected', () => {
    const labels = assistantActions('selection', t).map((action) => action.label);

    expect(labels).toEqual([
      '<assistant.action.improve>',
      '<assistant.action.proofread>',
      '<assistant.action.shorter>',
      '<assistant.action.longer>',
      '<assistant.action.simplify>',
      '<assistant.action.explain>',
      '<assistant.action.diagram>',
      '<assistant.action.asciiDiagram>',
    ]);
  });

  it('offers work on the whole page at a caret', () => {
    const labels = assistantActions('caret', t).map((action) => action.label);

    expect(labels).toEqual([
      '<assistant.action.summarize>',
      '<assistant.action.actionItems>',
      '<assistant.action.diagram>',
      '<assistant.action.asciiDiagram>',
      '<assistant.action.proofread>',
      '<assistant.action.continue>',
    ]);
  });

  it('offers nothing on an empty page: there is nothing to work on', () => {
    expect(assistantActions('empty', t)).toEqual([]);
  });

  it('keeps answers out of the page: summary, action items and explain only reply', () => {
    const answers = [...assistantActions('selection', t), ...assistantActions('caret', t)]
      .filter((action) => /summarize|actionItems|explain/.test(action.label));

    expect(answers).toHaveLength(3);
    answers.forEach((action) => expect(action.prompt).toContain('Do not edit the document.'));
  });

  it('asks for the document language, since the prompts are English', () => {
    [...assistantActions('selection', t), ...assistantActions('caret', t)]
      .forEach((action) => expect(action.prompt).toContain('language of the document'));
  });

  it('uses the host list instead of the built-in one', () => {
    const host = [
      { label: 'Translate', prompt: 'Translate it.', context: 'selection' as const },
      { label: 'Title', prompt: 'Suggest a title.', context: 'caret' as const },
      { label: 'Tone', prompt: 'Make it friendly.' },
    ];

    expect(assistantActions('selection', t, host)).toEqual([
      { label: 'Translate', prompt: 'Translate it.' },
      { label: 'Tone', prompt: 'Make it friendly.' },
    ]);
    expect(assistantActions('caret', t, host)).toEqual([
      { label: 'Title', prompt: 'Suggest a title.' },
      { label: 'Tone', prompt: 'Make it friendly.' },
    ]);
  });

  it('shows caret host actions on an empty page too: a host may offer drafts there', () => {
    const host = [
      { label: 'Draft', prompt: 'Draft a plan.', context: 'caret' as const },
      { label: 'Translate', prompt: 'Translate it.', context: 'selection' as const },
    ];

    expect(assistantActions('empty', t, host)).toEqual([{ label: 'Draft', prompt: 'Draft a plan.' }]);
  });

  it('gives every built-in action an icon', () => {
    [...assistantActions('selection', t), ...assistantActions('caret', t)]
      .forEach((action) => expect(action.icon, action.label).toMatch(/^\s*<svg/));
  });

  it('keeps a host action\'s icon, and shows a host action without one as text only', () => {
    const host = [
      { label: 'Translate', prompt: 'Translate it.', icon: '<svg></svg>' },
      { label: 'Tone', prompt: 'Make it friendly.' },
    ];

    expect(assistantActions('caret', t, host).map((action) => action.icon)).toEqual(['<svg></svg>', undefined]);
  });

  it('tells the bar where each action\'s result goes', () => {
    expect(destinationOf('selection', 'explain')).toBe('answer');
    expect(destinationOf('selection', 'improve')).toBe('replaceSelection');
    expect(destinationOf('caret', 'summarize')).toBe('answer');
    expect(destinationOf('caret', 'continue')).toBe('document');
  });

  it('sends both diagram skills to a code block, wherever the bar opened', () => {
    expect(destinationOf('selection', 'diagram')).toBe('codeBlock');
    expect(destinationOf('caret', 'diagram')).toBe('codeBlock');
    expect(destinationOf('selection', 'asciiDiagram')).toBe('codeBlock');
    expect(destinationOf('caret', 'asciiDiagram')).toBe('codeBlock');
  });

  it('tells the bar which block each answer deserves: a summary heads the page, action items are ticked off', () => {
    expect(insertOf('caret', 'summarize')).toBe('calloutAtTop');
    expect(insertOf('caret', 'actionItems')).toBe('checklist');
  });

  it('leaves every other answer to the plain insert, the host\'s own actions included', () => {
    expect(insertOf('selection', 'explain')).toBeUndefined();
    expect(insertOf('caret', 'continue')).toBeUndefined();
    expect(assistantActions('caret', t, [{ label: 'Title', prompt: 'Suggest a title.' }])[0]?.insert).toBeUndefined();
  });

  it('reads a destination per context: proofread swaps a selection, and edits the page at a caret', () => {
    expect(destinationOf('selection', 'proofread')).toBe('replaceSelection');
    expect(destinationOf('caret', 'proofread')).toBe('document');
  });

  it('leaves a host action without a destination: the host never said where its result goes', () => {
    const [action] = assistantActions('caret', t, [{ label: 'Title', prompt: 'Suggest a title.' }]);

    expect(action.destination).toBeUndefined();
  });

  it('hides every action for an empty host list', () => {
    expect(assistantActions('caret', t, [])).toEqual([]);
  });
});
