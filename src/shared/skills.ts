/**
 * Ask AI's built-in skills. Ask AI shows them as buttons and @bloklabs/mcp serves them as prompts,
 * so both send the same prompt text.
 */

/** Where a skill works: on selected text, or at a caret on the whole document. */
export type SkillContext = 'selection' | 'caret';

export type SkillId =
  | 'improve' | 'proofread' | 'shorter' | 'longer' | 'simplify' | 'explain'
  | 'summarize' | 'actionItems' | 'continue';

/**
 * Where a skill's result goes. Data, not a sentence in the prompt: the bar reads it to know which
 * buttons an answer deserves, and `skillPrompt` turns it back into the sentence the model needs.
 */
export type SkillDestination =
  /** The skill edits the document itself. */
  | 'document'
  /** The result takes the place of the selected text. */
  | 'replaceSelection'
  /** The reply stays in the bar; the page is untouched until the user inserts it. */
  | 'answer';

export interface AgentSkill {
  /** Ask AI's label key is `assistant.action.<id>`; the MCP prompt name is the id. */
  id: SkillId;
  /** The English label, as in the en locale. */
  label: string;
  /** The request per context the skill works in. */
  prompts: Partial<Record<SkillContext, string>>;
  /** What becomes of the result, per context. A context left out edits the document. */
  destinations?: Partial<Record<SkillContext, SkillDestination>>;
}

// The prompts are English, so the model would answer in English without this.
export const SKILL_LANGUAGE = 'Write in the language of the document, and reply in it too.';

/** The sentence each destination adds to the request. 'document' adds none: editing is the default. */
const DESTINATION_SENTENCE: Record<SkillDestination, string> = {
  document: '',
  replaceSelection: 'Replace the selected text with the result.',
  // The guidance sends questions to the reply; an answer shown in the bar can then be inserted.
  answer: 'Do not edit the document.',
};

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    id: 'improve',
    label: 'Improve writing',
    prompts: { selection: 'Improve the writing of the selected text: clearer and smoother, with the same meaning.' },
    destinations: { selection: 'replaceSelection' },
  },
  {
    id: 'proofread',
    label: 'Fix spelling and grammar',
    prompts: {
      selection: 'Fix spelling, grammar and punctuation in the selected text. Change nothing else.',
      caret: 'Fix spelling, grammar and punctuation across the whole document. Change nothing else.',
    },
    // At a caret there is no selection to swap, so it edits the page in place.
    destinations: { selection: 'replaceSelection', caret: 'document' },
  },
  {
    id: 'shorter',
    label: 'Make shorter',
    prompts: { selection: 'Make the selected text shorter. Keep its meaning.' },
    destinations: { selection: 'replaceSelection' },
  },
  {
    id: 'longer',
    label: 'Make longer',
    prompts: { selection: 'Make the selected text longer, with more detail. Keep its meaning.' },
    destinations: { selection: 'replaceSelection' },
  },
  {
    id: 'simplify',
    label: 'Simplify language',
    prompts: { selection: 'Rewrite the selected text in simpler words. Keep its meaning.' },
    destinations: { selection: 'replaceSelection' },
  },
  {
    id: 'explain',
    label: 'Explain',
    prompts: { selection: 'Explain the selected text in your reply.' },
    destinations: { selection: 'answer' },
  },
  {
    id: 'summarize',
    label: 'Summarize',
    prompts: { caret: 'Summarize the whole document in your reply, in a few sentences.' },
    destinations: { caret: 'answer' },
  },
  {
    id: 'actionItems',
    label: 'Find action items',
    prompts: { caret: 'List the action items and next steps from the document in your reply, as a Markdown list.' },
    destinations: { caret: 'answer' },
  },
  {
    id: 'continue',
    label: 'Continue writing',
    prompts: { caret: 'Continue writing from the user\'s place, in the same style. Add a paragraph or two.' },
    destinations: { caret: 'document' },
  },
];

/** The order Ask AI shows the skills in, per context. */
const ORDER: Record<SkillContext, readonly SkillId[]> = {
  selection: ['improve', 'proofread', 'shorter', 'longer', 'simplify', 'explain'],
  caret: ['summarize', 'actionItems', 'proofread', 'continue'],
};

/** What a skill does with its result in a context. A skill that says nothing edits the document. */
export const skillDestination = (skill: AgentSkill, context: SkillContext): SkillDestination =>
  skill.destinations?.[context] ?? 'document';

/** The full request a skill sends in a context: its sentence, what to do with the result, and the language rule. */
export const skillPrompt = (skill: AgentSkill, context: SkillContext): string | undefined => {
  const prompt = skill.prompts[context];

  if (prompt === undefined) {
    return undefined;
  }

  return [prompt, DESTINATION_SENTENCE[skillDestination(skill, context)], SKILL_LANGUAGE]
    .filter((part) => part !== '')
    .join(' ');
};

/** The skills for one context, in Ask AI's order, with their full requests. */
export const skillsFor = (context: SkillContext): Array<{ skill: AgentSkill; prompt: string }> =>
  ORDER[context].flatMap((id) => {
    const skill = AGENT_SKILLS.find((candidate) => candidate.id === id);
    const prompt = skill === undefined ? undefined : skillPrompt(skill, context);

    return skill === undefined || prompt === undefined ? [] : [{ skill, prompt }];
  });
