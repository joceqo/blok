import { describe, expect, it } from 'vitest';

import { AGENT_SKILLS, skillDestination, skillPrompt, skillsFor } from '../../../src/shared/skills';

import type { AgentSkill, SkillContext, SkillDestination } from '../../../src/shared/skills';

const skillById = (id: string): AgentSkill => {
  const skill = AGENT_SKILLS.find((candidate) => candidate.id === id);

  if (skill === undefined) {
    throw new Error(`No skill named ${id}`);
  }

  return skill;
};

const LANGUAGE = 'Write in the language of the document, and reply in it too.';

/**
 * Every skill and context, with the request it has always sent. Moving the destination out of the
 * prompt text and into data must not change one character of what the model receives.
 */
const FROZEN: ReadonlyArray<[string, SkillContext, string]> = [
  ['improve', 'selection', `Improve the writing of the selected text: clearer and smoother, with the same meaning. Replace the selected text with the result. ${LANGUAGE}`],
  ['proofread', 'selection', `Fix spelling, grammar and punctuation in the selected text. Change nothing else. Replace the selected text with the result. ${LANGUAGE}`],
  ['proofread', 'caret', `Fix spelling, grammar and punctuation across the whole document. Change nothing else. ${LANGUAGE}`],
  ['shorter', 'selection', `Make the selected text shorter. Keep its meaning. Replace the selected text with the result. ${LANGUAGE}`],
  ['longer', 'selection', `Make the selected text longer, with more detail. Keep its meaning. Replace the selected text with the result. ${LANGUAGE}`],
  ['simplify', 'selection', `Rewrite the selected text in simpler words. Keep its meaning. Replace the selected text with the result. ${LANGUAGE}`],
  ['explain', 'selection', `Explain the selected text in your reply. Do not edit the document. ${LANGUAGE}`],
  ['summarize', 'caret', `Summarize the whole document in your reply, in a few sentences. Do not edit the document. ${LANGUAGE}`],
  ['actionItems', 'caret', `List the action items and next steps from the document in your reply, as a Markdown list. Do not edit the document. ${LANGUAGE}`],
  ['continue', 'caret', 'Continue writing from the user\'s place, in the same style. Add a paragraph or two. ' + LANGUAGE],
];

/** What each skill does with its result, per context. */
const DESTINATIONS: ReadonlyArray<[string, SkillContext, SkillDestination]> = [
  ['improve', 'selection', 'replaceSelection'],
  ['proofread', 'selection', 'replaceSelection'],
  // The same skill edits the page in place at a caret: there is no selection to swap.
  ['proofread', 'caret', 'document'],
  ['shorter', 'selection', 'replaceSelection'],
  ['longer', 'selection', 'replaceSelection'],
  ['simplify', 'selection', 'replaceSelection'],
  ['explain', 'selection', 'answer'],
  ['summarize', 'caret', 'answer'],
  ['actionItems', 'caret', 'answer'],
  ['continue', 'caret', 'document'],
];

describe('skill prompts stay what they were', () => {
  it('covers every skill and context (non-vacuity)', () => {
    const pairs = AGENT_SKILLS.flatMap((skill) => (['selection', 'caret'] as SkillContext[])
      .filter((context) => skill.prompts[context] !== undefined)
      .map((context) => `${skill.id}:${context}`));

    expect(pairs).toHaveLength(FROZEN.length);
  });

  it.each(FROZEN)('%s at a %s sends the same request as before', (id, context, expected) => {
    expect(skillPrompt(skillById(id), context)).toBe(expected);
  });
});

describe('a skill declares where its result goes', () => {
  it.each(DESTINATIONS)('%s at a %s goes to %s', (id, context, expected) => {
    expect(skillDestination(skillById(id), context)).toBe(expected);
  });

  it('answers the destination for every skill a context offers', () => {
    (['selection', 'caret'] as SkillContext[]).forEach((context) => {
      skillsFor(context).forEach(({ skill }) => {
        expect(skillDestination(skill, context)).toBeTypeOf('string');
      });
    });
  });

  it('treats a skill that declares nothing as editing the document', () => {
    const plain: AgentSkill = { id: 'plain', label: 'Plain', prompts: { caret: 'Do a thing.' } };

    expect(skillDestination(plain, 'caret')).toBe('document');
  });

  it('projects the destination into the prompt, so the model is told the same thing', () => {
    const replacing: AgentSkill = {
      id: 'replacing',
      label: 'Replacing',
      prompts: { selection: 'Rework this.' },
      destinations: { selection: 'replaceSelection' },
    };

    expect(skillPrompt(replacing, 'selection')).toBe(`Rework this. Replace the selected text with the result. ${LANGUAGE}`);
  });

  it('says nothing extra for a skill that edits the document', () => {
    const editing: AgentSkill = {
      id: 'editing',
      label: 'Editing',
      prompts: { caret: 'Write a paragraph.' },
      destinations: { caret: 'document' },
    };

    expect(skillPrompt(editing, 'caret')).toBe(`Write a paragraph. ${LANGUAGE}`);
  });
});
