import {shellText, shellLocale} from './shell-i18n';
import {useEffect, useRef, useState} from 'react';
import {CalendarDays, CalendarRange, ChevronLeft, ChevronRight, List, Search} from 'lucide-react';
import {useCalendar} from './calendarcn/components/calendar-provider';
import {Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from './calendarcn/components/ui/command';
import {Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger} from './calendarcn/components/ui/dialog';
import {Button} from './calendarcn/components/ui/button';
import type {DetailedCalendarEvent, ViewType} from './calendarcn/components/calendar-types';

const dayFormat = new Intl.DateTimeFormat(shellLocale(), {weekday:'short', day:'numeric', month:'short'});
const viewKeys: Partial<Record<string, ViewType>> = {
  '1':'day', d:'day', '0':'week', w:'week', m:'month', y:'year', a:'agenda',
};
const viewCommands = [
  {view:'day', label:shellText("Vue jour"), icon:CalendarDays},
  {view:'week', label:shellText("Vue semaine"), icon:CalendarRange},
  {view:'month', label:shellText("Vue mois"), icon:CalendarDays},
  {view:'year', label:shellText("Vue année"), icon:CalendarRange},
  {view:'agenda', label:shellText("Vue agenda"), icon:List},
] as const;

export function CalendarCommands() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const {goToNext, goToPrev, goToToday, switchView, setNumberOfDays, toggleWeekends, events, selectEvent} = useCalendar<DetailedCalendarEvent>();
  function toggle(next: boolean) { setQuery(''); setOpen(next); }

  useEffect(() => {
    const button = trigger.current;
    if (!button) return;
    const doc = button.ownerDocument;
    function shortcut(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.altKey) return;
      const target = e.target;
      // In the desktop shell, focus can also belong to the page sidebar or a settings dialog.
      const surface = button?.closest('[data-calendar-grid]');
      if (target !== doc.body && target !== doc &&
          (!(target instanceof Element) || (!surface?.contains(target) && !target.closest('.blok-calendar-portals')))) return;
      if (surface?.closest('[hidden], [inert]') && !open) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === 'k') {
        e.preventDefault();
        toggle(!open);
        return;
      }
      if (open || (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], [role=menu]'))) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === 'e') {
        e.preventDefault();
        toggleWeekends();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      const mode = viewKeys[key];
      if (mode) {
        e.preventDefault();
        switchView(mode);
      } else if (/^[2-9]$/.test(key)) {
        e.preventDefault();
        switchView('week');
        setNumberOfDays(Number(key));
      }
    }
    doc.addEventListener('keydown', shortcut, true);
    return () => doc.removeEventListener('keydown', shortcut, true);
  }, [open, switchView, setNumberOfDays, toggleWeekends]);

  function run(action: () => void) { toggle(false); action(); }
  return <Dialog open={open} onOpenChange={toggle}>
    <DialogTrigger render={<Button ref={trigger} variant="ghost" size="icon-sm" title={shellText("Rechercher dans le calendrier")} aria-label={shellText("Rechercher dans le calendrier")} aria-keyshortcuts="Meta+K Control+K"/>}>
      <Search/>
    </DialogTrigger>
    <DialogContent className="overflow-hidden p-0 sm:max-w-lg" initialFocus={search} showCloseButton={false}>
      <DialogTitle className="sr-only">{shellText("Commandes du calendrier")}</DialogTitle>
      <DialogDescription className="sr-only">{shellText("Recherchez une commande ou un événement de la période affichée.")}</DialogDescription>
      <Command loop label={shellText("Commandes du calendrier")}>
        <CommandInput ref={search} placeholder={shellText("Rechercher une commande ou un événement…")} value={query} onValueChange={setQuery}/>
        <CommandList>
          <CommandEmpty>{shellText("Aucun résultat")}</CommandEmpty>
          <CommandGroup heading={shellText("Navigation")}>
            <CommandItem onSelect={() => run(goToToday)}><CalendarDays/>{shellText("Aujourd’hui")}</CommandItem>
            <CommandItem onSelect={() => run(goToPrev)}><ChevronLeft/>{shellText("Période précédente")}</CommandItem>
            <CommandItem onSelect={() => run(goToNext)}><ChevronRight/>{shellText("Période suivante")}</CommandItem>
          </CommandGroup>
          <CommandGroup heading={shellText("Affichage")}>
            {viewCommands.map(({view, label, icon:Icon}) => <CommandItem key={view} onSelect={() => run(() => switchView(view))}><Icon/>{label}</CommandItem>)}
          </CommandGroup>
          {events.length > 0 && <CommandGroup heading={shellText("Événements de la période")}>
            {events.map(event => {
              const date = dayFormat.format(event.start);
              return <CommandItem key={event.id} value={'event:'+event.id} keywords={[event.title, date]}
                onSelect={() => run(() => selectEvent(event.id))}>
                <CalendarDays/><span className="truncate">{event.title || shellText("Sans titre")}</span><span className="ml-auto shrink-0 text-xs text-muted-foreground">{date}</span>
              </CommandItem>;
            })}
          </CommandGroup>}
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>;
}
