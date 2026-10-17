import { useEffect, useRef } from "react";

export function useModalBehavior(
  onClose: () => void,
  opts: {
    onKeyDown?: (e: KeyboardEvent) => void;
    capture?: boolean;
    stopPropagation?: boolean;
  } = {},
) {
  const ref = useRef({ onClose, opts });
  const capture = opts.capture ?? false;

  useEffect(() => {
    ref.current = { onClose, opts };
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const current = ref.current;
      current.opts.onKeyDown?.(e);
      if (e.key === "Escape") {
        if (current.opts.stopPropagation) {
          e.preventDefault();
          e.stopPropagation();
        }
        current.onClose();
      }
    };
    document.addEventListener("keydown", handler, capture);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler, capture);
      document.body.style.overflow = prevOverflow;
    };
  }, [capture]);
}
