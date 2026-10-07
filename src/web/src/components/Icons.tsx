import type { SVGProps } from "react";
import type { IconName } from "../status.ts";

type P = SVGProps<SVGSVGElement>;

const base: P = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

const PATHS: Record<IconName, React.ReactNode> = {
  question: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.3-.8.7-.8 1.3M8 11.6v.1" />
    </>
  ),
  shield: <path d="M8 1.8 13 3.6v4c0 3-2.1 5.2-5 6.6-2.9-1.4-5-3.6-5-6.6v-4L8 1.8ZM5.8 8l1.6 1.6L10.4 6.4" />,
  // Working: a ring with a solid centre, still (no spinning anywhere); its blue says it's active.
  active: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />
    </>
  ),
  warn: <path d="M8 2.2 14.2 13H1.8L8 2.2ZM8 6.6v3M8 11.4v.1" />,
  cross: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  stop: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <rect x="5.7" y="5.7" width="4.6" height="4.6" rx=".8" />
    </>
  ),
  pause: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.6 5.8v4.4M9.4 5.8v4.4" />
    </>
  ),
  unknown: (
    <>
      <circle cx="8" cy="8" r="6.2" strokeDasharray="2.2 2.2" />
      <path d="M8 6v2.4" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.8" />
    </>
  ),
  flag: <path d="M3.5 14V2.5M3.5 3h8l-1.6 2.7L11.5 8.4h-8" />,
  moon: <path d="M12.8 9.6A5.6 5.6 0 0 1 6.4 3.2a5.6 5.6 0 1 0 6.4 6.4Z" />,
};

export function StatusIcon({ name, ...rest }: { name: IconName } & P) {
  return (
    <svg {...base} {...rest}>
      {PATHS[name]}
    </svg>
  );
}

export const Chevron = (p: P) => (
  <svg {...base} {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);

export const CopyIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="5.4" y="5.4" width="8" height="8" rx="1.6" />
    <path d="M10.6 3.6V3A1.2 1.2 0 0 0 9.4 1.8H3.6A1.2 1.2 0 0 0 2.4 3v5.8a1.2 1.2 0 0 0 1.2 1.2h.6" />
  </svg>
);

export const InboxIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2 9.2 3.8 3h8.4L14 9.2V13H2V9.2ZM2 9.2h3.4a1.4 1.4 0 0 0 1.4 1.2h2.4a1.4 1.4 0 0 0 1.4-1.2H14" />
  </svg>
);

export const ArrowLeft = (p: P) => (
  <svg {...base} {...p}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="m10.4 10.4 3.2 3.2" />
  </svg>
);

export const GearIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
  </svg>
);

export const PaperclipIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m13.2 7.4-5.4 5.4a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.2 11.3a1 1 0 0 1-1.5-1.5l5-5" />
  </svg>
);

export const XIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
