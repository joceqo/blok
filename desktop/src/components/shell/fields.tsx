import type { ComponentProps } from 'react';
import '../../../../src/styles/field.css';

type FieldProps = ComponentProps<'input'> & { appearance?: 'field' | 'inline' };

export const TextField = ({ appearance = 'field', ...props }: FieldProps) => (
  <input
    type="text"
    data-blok-field={appearance === 'field' ? 'text' : undefined}
    {...props}
  />
);

export const SearchField = ({ appearance = 'field', ...props }: FieldProps) => {
  const input = (
    <input
      {...props}
      type="search"
    />
  );
  return appearance === 'inline' ? input : <div data-blok-field="search">{input}</div>;
};
