import type { SVGProps } from 'react';
import { sidebarIconPaths } from '../../../src/shell/sidebar-icon-paths';

export type SidebarIconName = keyof typeof sidebarIconPaths | 'more';
interface IconProps extends SVGProps<SVGSVGElement> {
  name: SidebarIconName;
  filled?: boolean;
}

export const SidebarIcon = ({
  name,
  filled = name === 'home' || name === 'chat',
  ...props
}: IconProps) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    aria-hidden="true"
    {...props}
  >
    {name === 'more'
      ? [3.5, 8, 12.5].map((x) => (
          <circle
            key={x}
            cx={x}
            cy={8}
            r={1.15}
            fill="currentColor"
          />
        ))
      : sidebarIconPaths[name].map((path) => (
          <path
            key={path}
            d={path}
            fill={filled ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
  </svg>
);
