import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type PropsWithChildren,
  type ReactElement,
} from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Visible, tabbable descendants used only to detect the Tab edges. */
function focusableItems(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

/** Nested dialogs share one document scroll lock. */
let scrollLocks = 0;
let scrollRestore: { rootOverflow: string; bodyPaddingRight: string } | null = null;

function lockDocumentScroll(): void {
  scrollLocks += 1;
  if (scrollLocks > 1) return;
  const root = document.documentElement;
  const body = document.body;
  scrollRestore = { rootOverflow: root.style.overflow, bodyPaddingRight: body.style.paddingRight };
  const scrollbar = window.innerWidth - root.clientWidth;
  root.style.overflow = 'hidden';
  if (scrollbar > 0 && scrollbar < 100) body.style.paddingRight = scrollbar + 'px';
}

function unlockDocumentScroll(): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks > 0 || !scrollRestore) return;
  document.documentElement.style.overflow = scrollRestore.rootOverflow;
  document.body.style.paddingRight = scrollRestore.bodyPaddingRight;
  scrollRestore = null;
}

type ModalTitleContextValue = { id: string; register: (delta: number) => void };
const ModalTitleContext = createContext<ModalTitleContextValue | null>(null);

/** Marks the dialog title so the native dialog gets an accessible name. */
export function ModalTitle({ children, asChild }: PropsWithChildren<{ asChild?: boolean }>) {
  const context = useContext(ModalTitleContext);
  useLayoutEffect(() => {
    if (!context) return;
    context.register(1);
    return () => context.register(-1);
  }, [context]);
  if (!asChild) return <h2 id={context?.id}>{children}</h2>;
  if (!isValidElement(children)) throw new Error('ModalTitle asChild expects a single React element.');
  return cloneElement(children as ReactElement<{ id?: string }>, { id: context?.id });
}

type ModalProps = PropsWithChildren<{
  onClose: () => void;
  className: string;
  /** Extra class on the dialog element; style the native backdrop via ::backdrop. */
  backdropClassName: string;
  id?: string;
  label?: string;
}>;

/**
 * One controlled native modal dialog: the browser owns the top layer, Escape
 * ordering and background inertness; this wrapper owns controlled close, Tab
 * looping, backdrop pointer dismissal, focus restore and scroll locking.
 */
export function Modal({ children, onClose, className, backdropClassName, id, label }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [titleCount, setTitleCount] = useState(0);
  // URL/store-driven dialogs can open without a meaningful click target, so
  // remember the focused element before showModal moves focus.
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    opener.current = document.activeElement;
  }
  const titleContext = useMemo<ModalTitleContextValue>(() => ({
    id: titleId,
    register: (delta) => setTitleCount((count) => Math.max(0, count + delta)),
  }), [titleId]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    if (!dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>('[autofocus]') ?? focusableItems(dialog)[0])?.focus();
    }
    return () => {
      if (!dialog.open) return;
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  }, []);

  useEffect(() => {
    lockDocumentScroll();
    return unlockDocumentScroll;
  }, []);

  // Native close() restores the opener in browsers; keep an explicit fallback
  // for URL-driven dialogs and environments without dialog focus handling.
  useEffect(() => {
    const previous = opener.current;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Browser-initiated close requests (assistive technology, platform shortcuts)
  // still stay controlled.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  const backdropPointer = useRef(false);
  function handlePointerDown(event: ReactPointerEvent<HTMLDialogElement>): void {
    backdropPointer.current = event.target === event.currentTarget;
  }
  function handleClick(event: ReactMouseEvent<HTMLDialogElement>): void {
    if (!backdropPointer.current || event.target !== event.currentTarget) return;
    backdropPointer.current = false;
    onClose();
  }
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const items = focusableItems(dialog);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      id={id}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleCount > 0 ? titleId : undefined}
      aria-label={label}
      className={className + ' ' + backdropClassName}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <ModalTitleContext.Provider value={titleContext}>{children}</ModalTitleContext.Provider>
    </dialog>
  );
}
