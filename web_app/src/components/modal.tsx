import { useRef, type PropsWithChildren } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export const ModalTitle = Dialog.Title;

type ModalProps = PropsWithChildren<{
  onClose: () => void;
  className: string;
  overlayClassName: string;
  id?: string;
  label?: string;
  /** Preserve owner-scoped theme variables. Explicit null waits for its mount. */
  portalContainer?: HTMLElement | null;
}>;

/** One controlled modal lifetime; application state remains in the caller. */
export function Modal({ children, onClose, className, overlayClassName, id, label, portalContainer }: ModalProps) {
  // URL/store-driven dialogs have no Dialog.Trigger. Remember the actual opener
  // before Radix moves focus so closing still restores it when it is connected.
  const opener = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (portalContainer === null) return null;
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal container={portalContainer}>
        <Dialog.Overlay id={id} className={overlayClassName}>
          <Dialog.Content asChild aria-modal="true" aria-label={label} aria-describedby={undefined}
            onEscapeKeyDown={event => event.stopPropagation()}
            onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
            <section className={className}>{children}</section>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
