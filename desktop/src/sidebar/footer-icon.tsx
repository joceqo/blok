import { SidebarIcon } from './sidebar-icon';
import { footerIconPaths } from '../components/shell/footer-icon-paths';

export const FooterIcon = ({ name }: { name: keyof typeof footerIconPaths | 'chevron' }) => {
  if (name === 'chevron')
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-hidden="true"
      >
        <path
          d="m4 6 4 4 4-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <path
        d={footerIconPaths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
};

export const DestinationIcon = ({ name }: { name: string }) => {
  if (name === 'library')
    return (
      <SidebarIcon
        name="library"
        width={18}
        height={18}
      />
    );
  if (name !== 'calendar' && name !== 'trash') return null;
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'calendar' ? (
        <>
          <rect
            x="3"
            y="4.5"
            width="14"
            height="11"
            rx="2.5"
          />
          <path d="M3 8.25h14M7 3v3M13 3v3" />
          {[7, 10, 13].map((x) => (
            <circle
              key={x}
              cx={x}
              cy="11.75"
              r="1"
              fill="currentColor"
              stroke="none"
            />
          ))}
        </>
      ) : (
        <>
          <g data-blok-icon-lid="">
            <path d="M3.5 5.5h13" />
            <path d="M8 5.5V4.25c0-.55.45-1 1-1h2c.55 0 1 .45 1 1V5.5" />
          </g>
          <path d="M5.5 5.5v9a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2v-9" />
          <path d="M8.5 9v4M11.5 9v4" />
        </>
      )}
    </svg>
  );
};
