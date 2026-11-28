import React, { createElement } from 'react';
import type { IconNode } from 'lucide';

export function Icon({icon, size = 16}: {icon: IconNode; size?: number}) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {icon.map(([tag, attrs], i) => createElement(tag, {...attrs, key: i}))}
  </svg>;
}
