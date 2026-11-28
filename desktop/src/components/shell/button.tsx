import './shell-ui.css';
import { Button as BaseButton } from '@base-ui/react/button';
import type { ComponentProps } from 'react';

export interface ButtonProps extends ComponentProps<typeof BaseButton> {
  variant?: 'outline' | 'ghost' | 'plain';
}

export const Button = ({ variant = 'outline', ...props }: ButtonProps) => (
  <BaseButton
    data-blok-button={variant === 'plain' ? undefined : variant}
    {...props}
  />
);
