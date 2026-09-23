import type { SVGProps } from "react";

/**
 * Sidebar icon set copied from codex-ui (`src/components/Icons.tsx`).
 *
 * Pi Desktop's sidebar used lucide equivalents, but they are not the same drawings: codex-ui's
 * pushpin has a flat top bar and a straight stem, its "new session" glyph is a compose box
 * (square + pen) rather than a bare pencil, and its archive is a lidded box. The sidebar is
 * built to match codex-ui, so the icon paths are copied verbatim (same 24px grid, same 1.7
 * stroke) instead of being approximated with another icon family.
 *
 * `FolderOpen` has no codex-ui original — it is drawn on the same construction as codex-ui's
 * `Folder` so the collapsed/expanded pair reads as one family.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** codex-ui `Pin` — pushpin for "pin session / pin project". */
export function SidebarPinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1z" />
    </Svg>
  );
}

/** codex-ui `Compose` — "new session" (square + pen), not a bare pencil. */
export function SidebarNewSessionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6.5" />
      <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-3.5 1 1-3.5Z" />
    </Svg>
  );
}

/** codex-ui `Archive` — lidded box with the handle dash. */
export function SidebarArchiveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
      <path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5" />
      <path d="M10 12.5h4" />
    </Svg>
  );
}

/** codex-ui `Folder` — collapsed project. */
export function SidebarFolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v6.7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

/** Expanded project: same back panel, front flap tilted open. */
export function SidebarFolderOpenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 9.6V7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v.2" />
      <path d="M3.2 9.6h16.1a1.6 1.6 0 0 1 1.56 1.98l-1.2 5.22a2 2 0 0 1-1.95 1.6H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

/** codex-ui `MessageCircle` — hollow speech bubble for the project card's session count. */
export function SidebarMessageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.5 11.8a8.5 8.5 0 0 1-12.5 7.5L3.5 20.5l1.3-4.4A8.5 8.5 0 1 1 20.5 11.8Z" />
    </Svg>
  );
}

/** codex-ui `Monitor` — the session card's timestamp glyph. */
export function SidebarMonitorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="4.5" width="19" height="12.5" rx="2" />
      <path d="M9 21h6M12 17v4" />
    </Svg>
  );
}