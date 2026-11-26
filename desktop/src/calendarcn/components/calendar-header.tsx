"use client";

import * as React from "react";
import { addDays, format } from "date-fns";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from "lucide-react";

import { cn } from "../lib/utils";
import { useCalendar, useCalendarConfig } from "./calendar-provider";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Separator } from "./ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { ViewDropdown } from "./view-dropdown";
import { AGENDA_DAYS, getFirstShownDay } from "../lib/event-utils";

import type { ViewType } from "./calendar-types";

/** What previous and next move by in each view, for their labels */
const PERIOD_LABELS: Record<ViewType, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
  agenda: `${AGENDA_DAYS} days`,
};

interface CalendarHeaderProps {
  /** Whether the sidebar is open: its toggle's tooltip offers to close or open it */
  sidebarOpen?: boolean;
  /** Opens or closes the sidebar. The sidebar toggle shows only when given */
  onToggleSidebar?: () => void;
  sidebarSide?: "left" | "right";
  /** Whether the context panel is open. Its toggle hides while it is */
  contextPanelOpen?: boolean;
  /** Opens or closes the context panel. The toggle shows only when given */
  onToggleContextPanel?: () => void;
  /** Shown before the view switcher on wide headers, e.g. the signed-in user's avatar */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The live demo's header: the sidebar toggle, the month and year with the
 * period on screen, then the view switcher, today, previous and next, and
 * the context panel toggle. Reads the calendar from `useCalendar()`, so it
 * goes inside `CalendarProvider`; the panels are your app's, so their state
 * comes in as props.
 */
export function CalendarHeader({
  sidebarOpen = false,
  onToggleSidebar,
  sidebarSide = "left",
  contextPanelOpen = false,
  onToggleContextPanel,
  children,
  className,
}: CalendarHeaderProps) {
  const { monthName, year, view } = useCalendar();
  const {locale} = useCalendarConfig();
  const french = locale.code.startsWith("fr");
  const SideIcon = sidebarSide === "right" ? PanelRightIcon : PanelLeftIcon;
  const toggleLabel = french ? "Agendas" : "Toggle Calendar Sidebar";

  return (
    // Tooltips need a provider with Radix; a closer one (yours) still wins
    <TooltipProvider>
      <header
        className={cn(
          "@container/header bg-background sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 pl-2 @md/header:gap-2 @xl/header:px-4">
          {onToggleSidebar && (
            <>
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onToggleSidebar} aria-expanded={sidebarOpen} aria-label={toggleLabel} />}><SideIcon /></TooltipTrigger>
                <TooltipContent side="bottom">
                  {french
                    ? (sidebarOpen ? "Masquer les agendas" : "Afficher les agendas")
                    : (sidebarOpen ? "Close sidebar" : "Open sidebar")}
                </TooltipContent>
              </Tooltip>
              <Separator
                orientation="vertical"
                className="mr-2 hidden data-[orientation=vertical]:h-4 @md/header:block"
              />
            </>
          )}
          <h1 className="min-w-0 truncate text-sm first-letter:uppercase @xs/header:text-base @xl/header:text-xl">
            {/* Narrow headers use the short month ("Sep"); en-US "MMMM" names abbreviate to their first three letters */}
            {view !== "year" && <>
            <span className="font-extrabold @md/header:hidden">
              {monthName.slice(0, 3)}
            </span>
            <span className="hidden font-extrabold @md/header:inline">
              {monthName}
            </span>{" "}
            </>}
            <span className="font-extrabold">{year}</span>{" "}
            <CalendarPeriodLabel className="text-muted-foreground hidden text-xs @xl/header:inline" />
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1 pr-2 @md/header:gap-2 @xl/header:px-4">
          {children && <div className="flex items-center gap-1">{children}</div>}
          <div>
            <CalendarViewSwitcher />
          </div>
          <CalendarNavigation buttonClassName="size-7 @2xs/header:size-8" />
          {onToggleContextPanel && !contextPanelOpen && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onToggleContextPanel} />}><PanelRightIcon /><span className="sr-only">Toggle Navigation Sidebar</span></TooltipTrigger>
              <TooltipContent side="bottom">
                Open context panel <Kbd className="ml-1">/</Kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>
    </TooltipProvider>
  );
}

interface CalendarPeriodLabelProps {
  className?: string;
}

/**
 * The period on screen, for beside the title: the day ("Thursday, Jun 4"),
 * or the agenda's range. While week numbers are on, day and week view add
 * the week's number ("Week 23"), as Notion Calendar shows it beside the
 * title. Empty in month and year view, where the title already says it.
 */
export function CalendarPeriodLabel({ className }: CalendarPeriodLabelProps) {
  const { view, currentDate, weekNumber, viewSettings } = useCalendar();
  const { locale } = useCalendarConfig();
  // The day on screen: with weekends hidden, a Saturday's date shows Monday
  const day = getFirstShownDay(currentDate, viewSettings.showWeekends);
  const showWeekNumber =
    viewSettings.showWeekNumbers && (view === "day" || view === "week");

  return (
    <span className={className}>
      {view === "day" && format(day, "EEEE, MMM d", { locale })}
      {view === "day" && showWeekNumber && " "}
      {showWeekNumber && (
        <span className={cn(view === "day" && "ml-1")}>{locale.code.startsWith("fr") ? "Semaine" : "Week"} {weekNumber}</span>
      )}
      {view === "agenda" &&
        `${format(currentDate, "MMM d", { locale })} – ${format(addDays(currentDate, AGENDA_DAYS - 1), "MMM d", { locale })}`}
    </span>
  );
}

/**
 * The view dropdown wired to the provider: day, week, month, year or agenda, the
 * number of days, and the weekend and week number settings
 */
export function CalendarViewSwitcher() {
  const {
    view,
    numberOfDays,
    viewSettings,
    switchView,
    setNumberOfDays,
    toggleWeekends,
    toggleWeekNumbers,
  } = useCalendar();

  return (
    <ViewDropdown
      view={view}
      numberOfDays={numberOfDays}
      viewSettings={viewSettings}
      onSwitchView={switchView}
      onSetNumberOfDays={count => {
        switchView("week");
        setNumberOfDays(count);
      }}
      onToggleWeekends={toggleWeekends}
      onToggleWeekNumbers={toggleWeekNumbers}
    />
  );
}

interface CalendarNavigationProps {
  /** Classes for the previous and next buttons, e.g. their size */
  buttonClassName?: string;
}

/** Today, then previous and next, labelled with the period they move by */
export function CalendarNavigation({
  buttonClassName,
}: CalendarNavigationProps) {
  const { view, goToToday, goToPrev, goToNext } = useCalendar();
  const periodLabel = PERIOD_LABELS[view];
  const french = useCalendarConfig().locale.code.startsWith("fr");

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="px-2 @md/header:px-3"
        onClick={goToToday}
      >
        {french ? "Aujourd’hui" : "Today"}
      </Button>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className={cn("text-muted-foreground", buttonClassName)}
          aria-label={french ? "Période précédente" : `Previous ${periodLabel}`}
          onClick={goToPrev}
        >
          <ChevronLeftIcon className="size-4" />
          <span className="sr-only">{french ? "Période précédente" : `Previous ${periodLabel}`}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("text-muted-foreground", buttonClassName)}
          aria-label={french ? "Période suivante" : `Next ${periodLabel}`}
          onClick={goToNext}
        >
          <ChevronRightIcon className="size-4" />
          <span className="sr-only">{french ? "Période suivante" : `Next ${periodLabel}`}</span>
        </Button>
      </div>
    </>
  );
}
