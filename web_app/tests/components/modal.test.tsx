// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal, ModalTitle } from '@/components/modal';
import { installNativeDialogPolyfill } from '../support/native-dialog.ts';

installNativeDialogPolyfill();

afterEach(cleanup);

function Fixture({ title }: { title?: ReactNode } = {}) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open parent</button>
    {open && <Modal className="content" backdropClassName="backdrop" onClose={() => setOpen(false)}>
      {title ?? <ModalTitle>Parent title</ModalTitle>}
      <button onClick={() => setNested(true)}>Open child</button>
      <button onClick={() => setOpen(false)}>Close parent</button>
      {nested && <Modal className="content" backdropClassName="backdrop" onClose={() => setNested(false)}>
        <ModalTitle>Child title</ModalTitle><button>Child action</button>
      </Modal>}
    </Modal>}
  </>;
}

async function openParent() {
  const opener = screen.getByRole('button', { name: 'Open parent' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: await screen.findByRole('dialog') };
}

it('names the native dialog and restores the focused opener after Escape', async () => {
  render(<Fixture />);
  const { opener, dialog } = await openParent();
  expect(await screen.findByRole('dialog', { name: 'Parent title' })).toBe(dialog);
  expect(dialog.tagName).toBe('DIALOG');
  expect(dialog.hasAttribute('open')).toBe(true);
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Parent title');
  expect(dialog.className).toBe('content backdrop');
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it('opens through the native HTMLDialogElement.showModal path', async () => {
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  try {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Open parent' }));
    await screen.findByRole('dialog');
    expect(showModal).toHaveBeenCalledTimes(1);
  } finally {
    showModal.mockRestore();
  }
});

it('keeps an asChild title element and assigns the dialog label id', async () => {
  render(<Fixture title={<ModalTitle asChild><h2>Custom title</h2></ModalTitle>} />);
  const { dialog } = await openParent();
  expect(await screen.findByRole('dialog', { name: 'Custom title' })).toBe(dialog);
  expect(within(dialog).getByRole('heading', { name: 'Custom title' }).tagName).toBe('H2');
});

it('Escape closes only the nested modal and returns focus to its parent', async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Open parent' }));
  const parent = await screen.findByRole('dialog', { name: 'Parent title' });
  const opener = within(parent).getByRole('button', { name: 'Open child' });
  opener.focus(); fireEvent.click(opener);
  await screen.findByRole('dialog', { name: 'Child title' });
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Child title' })).toBeNull());
  expect(screen.getByRole('dialog', { name: 'Parent title' })).toBe(parent);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it('does not send the consumed modal Escape to background shortcuts', async () => {
  let backgroundEscapes = 0;
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') backgroundEscapes++; };
  window.addEventListener('keydown', onKey);
  try {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Open parent' }));
    await screen.findByRole('dialog');
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' }));
    expect(backgroundEscapes).toBe(0);
  } finally { window.removeEventListener('keydown', onKey); }
});

it('loops Tab and Shift+Tab inside the modal', async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Open parent' }));
  const dialog = await screen.findByRole('dialog');
  const first = within(dialog).getByRole('button', { name: 'Open child' });
  const last = within(dialog).getByRole('button', { name: 'Close parent' });
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab', code: 'Tab' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', code: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
});

it('dismisses from a backdrop pointer press and restores focus', async () => {
  render(<Fixture />);
  const { opener, dialog } = await openParent();
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  fireEvent.pointerDown(dialog, { button: 0, pointerType: 'mouse' });
  fireEvent.click(dialog);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));

  fireEvent.click(screen.getByRole('button', { name: 'Open parent' }));
  const reopened = await screen.findByRole('dialog');
  const inside = within(reopened).getByRole('heading', { name: 'Parent title' });
  fireEvent.pointerDown(inside, { button: 0, pointerType: 'mouse' });
  fireEvent.click(inside);
  expect(screen.getByRole('dialog')).toBe(reopened);
});

it('locks document scrolling until the last modal closes', async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Open parent' }));
  const parent = await screen.findByRole('dialog', { name: 'Parent title' });
  expect(document.documentElement.style.overflow).toBe('hidden');
  fireEvent.click(within(parent).getByRole('button', { name: 'Open child' }));
  await screen.findByRole('dialog', { name: 'Child title' });
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Child title' })).toBeNull());
  expect(document.documentElement.style.overflow).toBe('hidden');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(document.documentElement.style.overflow).toBe(''));
});

it('closes safely when the opener was removed while the dialog was open', async () => {
  function RemovedTrigger() {
    const [stage, setStage] = useState<'closed' | 'open' | 'done'>('closed');
    return <>{stage === 'closed' && <button onClick={() => setStage('open')}>Open</button>}
      {stage === 'open' && <Modal className="content" backdropClassName="backdrop" onClose={() => setStage('done')}>
        <ModalTitle>Detached opener</ModalTitle><button>Only action</button>
      </Modal>}
      {stage === 'done' && <p>Closed safely</p>}
    </>;
  }
  render(<RemovedTrigger />);
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus(); fireEvent.click(opener);
  await screen.findByRole('dialog');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await screen.findByText('Closed safely');
  expect(document.contains(opener)).toBe(false);
  expect(document.activeElement?.isConnected).toBe(true);
});
