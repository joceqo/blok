import type { ComponentProps, ReactNode } from 'react';

export const Feedback = ({
  kind = 'status',
  ...props
}: ComponentProps<'span'> & { kind?: 'status' | 'error' }) => (
  <span
    role={kind === 'error' ? 'alert' : 'status'}
    data-desktop-feedback-kind={kind}
    {...props}
  />
);

interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'ref' | 'title'> {
  description?: string;
  action?: ReactNode;
}

export const EmptyState = ({ children, description, action, ...props }: EmptyStateProps) => {
  if (!description && !action) return <p {...props}>{children}</p>;
  return (
    <div
      data-desktop-empty-state=""
      {...props}
    >
      <strong>{children}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
};
