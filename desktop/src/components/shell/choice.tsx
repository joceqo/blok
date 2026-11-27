import { useRef, useLayoutEffect } from 'react';
import { createChoice, type ChoiceOptions } from '../../ui/controls';

export const Choice = <T extends string>({
  attribute,
  label,
  value,
  options,
  onChange,
  searchable,
  disabled,
}: ChoiceOptions<T> & { attribute?: string; disabled?: boolean }) => {
  const host = useRef<HTMLDivElement>(null);
  const control = useRef<ReturnType<typeof createChoice<T>> | null>(null);
  const latestValue = useRef(value);
  useLayoutEffect(() => {
    latestValue.current = value;
  }, [value]);
  useLayoutEffect(() => {
    const choice = createChoice({
      label,
      value: latestValue.current,
      options,
      onChange,
      searchable,
    });
    if (attribute) choice.element.setAttribute(attribute, '');
    host.current?.append(choice.element);
    control.current = choice;
    return () => {
      choice.destroy();
      choice.element.remove();
    };
  }, [attribute, label, options, onChange, searchable]);
  useLayoutEffect(() => {
    control.current?.setValue(value);
  }, [value]);
  useLayoutEffect(() => {
    if (control.current) control.current.disabled = Boolean(disabled);
  }, [disabled]);
  return <div ref={host} />;
};
