import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import ConfirmModal, { type ConfirmOptions } from "../components/ConfirmModal";

export type { ConfirmOptions };

export type ConfirmFunction = (optionsOrMessage: string | ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFunction | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [activeOptions, setActiveOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFunction>((optionsOrMessage) => {
    return new Promise<boolean>((resolve) => {
      if (resolverRef.current) {
        resolverRef.current(false);
      }
      resolverRef.current = resolve;

      if (typeof optionsOrMessage === "string") {
        setActiveOptions({
          title: "Are you sure?",
          message: optionsOrMessage,
          confirmLabel: "Confirm",
          cancelLabel: "Cancel",
          danger: false,
        });
      } else {
        setActiveOptions(optionsOrMessage);
      }
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setActiveOptions(null);
    if (resolverRef.current) {
      resolverRef.current(true);
      resolverRef.current = null;
    }
  }, []);

  const handleCancel = useCallback(() => {
    setActiveOptions(null);
    if (resolverRef.current) {
      resolverRef.current(false);
      resolverRef.current = null;
    }
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {activeOptions && (
        <ConfirmModal
          options={activeOptions}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export const useConfirm = (): ConfirmFunction => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used inside a ConfirmProvider");
  }
  return ctx;
};
