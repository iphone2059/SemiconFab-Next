/**
 * jsdom does not implement HTMLDialogElement's modal API. Tests install this
 * polyfill so the native dialog contract the Modal wrapper depends on (open
 * state, showModal/close, initial focus, focus restoration) is observable.
 * Production code calls the browser API only.
 */
export function installNativeDialogPolyfill(): void {
  const prototype = HTMLDialogElement.prototype as unknown as {
    showModal?: (this: HTMLDialogElement) => void;
    close?: (this: HTMLDialogElement) => void;
  };
  if (typeof prototype.showModal === 'function') return;
  const focusStack: Array<HTMLElement | null> = [];
  prototype.showModal = function (this: HTMLDialogElement) {
    focusStack.push(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.setAttribute('open', '');
    const target = this.querySelector<HTMLElement>('[autofocus]')
      ?? this.querySelector<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
    (target ?? this).focus();
  };
  prototype.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
    const previous = focusStack.pop();
    if (previous?.isConnected) previous.focus();
  };
}
