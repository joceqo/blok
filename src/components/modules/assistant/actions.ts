import type { AgentAssistantAction } from '../../../../types/api';
import {
  IconAskAiActionItems,
  IconAskAiAsciiDiagram,
  IconAskAiContinue,
  IconAskAiDiagram,
  IconAskAiExplain,
  IconAskAiImprove,
  IconAskAiLonger,
  IconAskAiProofread,
  IconAskAiShorter,
  IconAskAiSimplify,
  IconAskAiSummarize,
} from '../../icons';
import { skillDestination, skillsFor } from '../../../shared/skills';
import type { SkillDestination, SkillId } from '../../../shared/skills';

/** Where the bar opened: over selected text, at a caret, or on a page with no text. */
export type ActionContext = 'selection' | 'caret' | 'empty';

/**
 * The shape an answer takes when the user inserts it. A destination says the reply stays in the bar;
 * it does not say which block the reply deserves, nor where on the page it belongs.
 */
export type AssistantInsert = 'calloutAtTop' | 'checklist';

/** The tool an insert shape needs. Without it the bar falls back to the plain insert. */
export const INSERT_TOOL: Record<AssistantInsert, string> = { calloutAtTop: 'callout', checklist: 'list' };

/** A button under the prompt field: its label, the prompt it sends, where its result goes, and an optional icon. */
export interface AssistantAction {
  label: string;
  prompt: string;
  icon?: string;
  /**
   * What becomes of the result; the bar reads it to know which buttons the answer deserves.
   * A host's action says nothing, so the bar offers every one of them.
   */
  destination?: SkillDestination;
  /**
   * How Insert puts this answer in the page. Absent: as Markdown, under the user's place.
   * A host's action says nothing, so its answer goes in plainly.
   */
  insert?: AssistantInsert;
}

/** A summary heads the page the way a person writes one; action items are made to be ticked off. */
const INSERTS: Partial<Record<SkillId, AssistantInsert>> = { summarize: 'calloutAtTop', actionItems: 'checklist' };

const ICONS: Record<SkillId, string> = {
  improve: IconAskAiImprove,
  proofread: IconAskAiProofread,
  shorter: IconAskAiShorter,
  longer: IconAskAiLonger,
  simplify: IconAskAiSimplify,
  explain: IconAskAiExplain,
  summarize: IconAskAiSummarize,
  actionItems: IconAskAiActionItems,
  continue: IconAskAiContinue,
  diagram: IconAskAiDiagram,
  asciiDiagram: IconAskAiAsciiDiagram,
};

/**
 * The actions the bar offers where it opened.
 * @param context - where the bar opened
 * @param t - translates a label key
 * @param host - the host's list, which replaces the built-in one; [] shows none
 */
export const assistantActions = (
  context: ActionContext,
  t: (key: string) => string,
  host?: readonly AgentAssistantAction[]
): AssistantAction[] => {
  if (host !== undefined) {
    // A caret action fits an empty page as well: it may draft from nothing.
    const fits = (action: AgentAssistantAction): boolean => action.context === undefined
      || action.context === (context === 'selection' ? 'selection' : 'caret');

    return host.filter(fits).map(({ label, prompt, icon }) => ({ label, prompt, icon }));
  }
  if (context === 'empty') {
    return [];
  }

  return skillsFor(context).map(({ skill, prompt }) => ({
    label: t(`assistant.action.${skill.id}`),
    icon: ICONS[skill.id],
    prompt,
    destination: skillDestination(skill, context),
    ...(INSERTS[skill.id] === undefined ? {} : { insert: INSERTS[skill.id] }),
  }));
};
