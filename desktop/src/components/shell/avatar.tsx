import type { ComponentProps } from 'react';

export const Avatar = ({
  name,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { name: string }) => (
  <span
    aria-hidden="true"
    {...props}
  >
    {Array.from(name)[0]?.toLocaleUpperCase() || 'B'}
  </span>
);
