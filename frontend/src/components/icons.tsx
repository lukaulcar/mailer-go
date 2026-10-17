type IconProps = {
  size?: number;
  className?: string;
  "aria-hidden"?: boolean;
};

export function TrashIcon({
  size = 15,
  className,
  strokeWidth = 1.6,
  linejoin,
  "aria-hidden": ariaHidden,
}: IconProps & { strokeWidth?: number; linejoin?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden={ariaHidden} className={className}>
      <path
        d="M3.5 5.5h13M8 5V3.8A.8.8 0 0 1 8.8 3h2.4a.8.8 0 0 1 .8.8V5M6 5.5 7 17h6l1-11.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin={linejoin ? "round" : undefined}
      />
    </svg>
  );
}

export function EnvelopeIcon({
  size = 15,
  className,
  rx = 2,
  filled,
  "aria-hidden": ariaHidden,
}: IconProps & { rx?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden={ariaHidden} className={className}>
      <rect
        x="2.5"
        y="4"
        width="15"
        height="12"
        rx={rx}
        stroke="currentColor"
        strokeWidth="1.6"
        fill={filled ? "currentColor" : undefined}
        opacity={filled ? 0.2 : undefined}
      />
      <path d="M3.5 5.5 10 11l6.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StarIcon({
  size = 16,
  className,
  strokeWidth = 1.6,
  filled,
  "aria-hidden": ariaHidden,
}: IconProps & { strokeWidth?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={filled ? "currentColor" : "none"}
      aria-hidden={ariaHidden}
      className={className}
    >
      <path
        d="M10 2.8 12.2 7.3 17.2 8 13.6 11.5 14.5 16.5 10 14 5.5 16.5 6.4 11.5 2.8 8 7.8 7.3Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PencilIcon({ size = 14, className, "aria-hidden": ariaHidden }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden={ariaHidden} className={className}>
      <path d="M12.5 3.5 16.5 7.5 7 17H3v-4L12.5 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className, "aria-hidden": ariaHidden }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden={ariaHidden} className={className}>
      <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
