import type { ComponentProps, ReactNode } from 'react';

/**
 * La marque d'un espace ou d'un compte : le dessin qu'on lui donne, sinon
 * l'initiale de son nom. Le dessin arrive tout fait — le design system ne
 * connaît pas les icônes d'espace, c'est l'appelant qui les sait rendre.
 */
export const Avatar = ({
  name,
  mark,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { name: string; mark?: ReactNode }) => (
  <span
    aria-hidden="true"
    {...props}
  >
    {mark ?? Array.from(name)[0]?.toLocaleUpperCase() ?? 'B'}
  </span>
);
