"use client";

import {shellText} from '../../shell-i18n';
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { useCalendarConfig } from "./calendar-provider";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Kbd, KbdGroup } from "./ui/kbd";
import { NUMBER_OF_DAYS_OPTIONS } from "../lib/event-utils";

import type { ViewSettings, ViewType } from "./week-view-types";

/** Display labels for each view type */
const VIEW_LABELS: Record<ViewType, string> = {
  day: shellText("Day"),
  week: shellText("Week"),
  month: shellText("Month"),
  year: shellText("Year"),
  agenda: shellText("Agenda"),
};

/** View mode options with their shortcut labels */
const VIEW_OPTIONS: Array<{
  value: ViewType;
  shortcuts: Array<string>;
}> = [
  { value: "day", shortcuts: ["1", "or", "D"] },
  { value: "week", shortcuts: ["0", "or", "W"] },
  { value: "month", shortcuts: ["M"] },
  { value: "year", shortcuts: ["Y"] },
  { value: "agenda", shortcuts: ["A"] },
];

/**
 * Shortcut hints inside menu items drop the key-cap background. Classes
 * rather than a Kbd variant, so the file works with the stock shadcn/ui Kbd.
 */
const PLAIN_KBD_CLASS = "h-auto min-w-0 rounded-none bg-transparent px-0";

interface ViewDropdownProps {
  view: ViewType;
  numberOfDays: number;
  viewSettings: ViewSettings;
  onSwitchView: (view: ViewType) => void;
  onSetNumberOfDays: (count: number) => void;
  onToggleWeekends: () => void;
  onToggleWeekNumbers: () => void;
}

export function ViewDropdown({
  view,
  numberOfDays,
  viewSettings,
  onSwitchView,
  onSetNumberOfDays,
  onToggleWeekends,
  onToggleWeekNumbers,
}: ViewDropdownProps) {
  const french = useCalendarConfig().locale.code.startsWith("fr");
  const labels = french ? {day:shellText("Jour"), week:shellText("Semaine"), month:shellText("Mois"), year:shellText("Année"), agenda:shellText("Agenda")} : VIEW_LABELS;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="secondary" size="sm" className="gap-1 px-3" aria-label={french ? shellText("Vue du calendrier") : shellText("Calendar view")} />}>{labels[view]}<ChevronDownIcon className="size-4 text-muted-foreground" /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-56">
        {VIEW_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={view === option.value}
            aria-label={labels[option.value]}
            onClick={() => onSwitchView(option.value)}
          >
            <CheckIcon
              className={cn(
                "size-4 shrink-0",
                view !== option.value && "invisible",
              )}
            />
            {labels[option.value]}
            <KbdGroup className="ml-auto">
              {option.shortcuts.map((s) =>
                s === "or" ? (
                  <span key={s} className="text-muted-foreground text-xs">
                    {french ? shellText("ou") : shellText("or")}
                  </span>
                ) : (
                  <Kbd key={s} className={PLAIN_KBD_CLASS}>
                    {s}
                  </Kbd>
                ),
              )}
            </KbdGroup>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* Number of days submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="pl-8">
            {french ? shellText("Nombre de jours") : shellText("Number of days")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {NUMBER_OF_DAYS_OPTIONS.map((n) => (
              <DropdownMenuItem key={n} onClick={() => onSetNumberOfDays(n)}>
                <CheckIcon
                  className={cn(
                    "size-4 shrink-0",
                    numberOfDays !== n && "invisible",
                  )}
                />
                {n} {french ? shellText("jours") : shellText("days")}
                <Kbd className={cn(PLAIN_KBD_CLASS, "ml-auto")}>{n}</Kbd>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        {/* View settings submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="pl-8">
            {french ? shellText("Options d’affichage") : shellText("View settings")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuCheckboxItem
              checked={viewSettings.showWeekends}
              onCheckedChange={() => onToggleWeekends()}
            >
              {french ? "Week-ends" : shellText("Weekends")}
              <KbdGroup className="ml-auto">
                <Kbd className={PLAIN_KBD_CLASS}>{shellText("shift")}</Kbd>
                <Kbd className={PLAIN_KBD_CLASS}>&#8984;</Kbd>
                <Kbd className={PLAIN_KBD_CLASS}>{shellText("E")}</Kbd>
              </KbdGroup>
            </DropdownMenuCheckboxItem>

            <DropdownMenuCheckboxItem
              checked={viewSettings.showWeekNumbers}
              onCheckedChange={() => onToggleWeekNumbers()}
            >
              {french ? shellText("Numéros de semaine") : shellText("Week numbers")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
