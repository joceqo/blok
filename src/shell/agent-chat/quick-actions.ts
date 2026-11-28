import { CircleHelp, FileText, Lightbulb, List, Search, Sparkles } from 'lucide';

/** One of the questions the assistant offers before the first one is asked */
export interface QuickAction {
  id: string;
  text: string;
  icon: typeof List;
}

/** On a page, the assistant's offer is about that page */
const ON_A_PAGE: readonly QuickAction[] = [
  {id: 'summary', text: 'Résumer cette page', icon: List},
  {id: 'insight', text: 'Trouver les points clés', icon: Lightbulb},
  {id: 'question', text: 'Que manque-t-il dans cette page ?', icon: CircleHelp},
] as const;

/**
 * Opened on no page — full screen, where the assistant stands on its own.
 * Asking it to summarise "this page" there asks it about nothing, so the
 * offer is about the workspace instead.
 */
const ON_NO_PAGE: readonly QuickAction[] = [
  {id: 'search', text: 'Cherche dans mes pages', icon: Search},
  {id: 'recap', text: 'Résume ma semaine', icon: Sparkles},
  {id: 'draft', text: 'Aide-moi à rédiger une page', icon: FileText},
] as const;

/** What the assistant offers before the first question, given what it is on */
export function quickActions(hasPage: boolean): readonly QuickAction[] {
  return hasPage ? ON_A_PAGE : ON_NO_PAGE;
}
