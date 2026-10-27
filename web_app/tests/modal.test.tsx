// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Modal, ModalTitle } from '../src/components/modal';

afterEach(cleanup);

function Fixture() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open parent</button>
    {open && <Modal className="content" overlayClassName="overlay" onClose={() => setOpen(false)}>
      <ModalTitle>Parent title</ModalTitle>
      <button onClick={() => setNested(true)}>Open child</button>
      <button onClick={() => setOpen(false)}>Close parent</button>
      {nested && <Modal className="content" overlayClassName="overlay" onClose={() => setNested(false)}>
        <ModalTitle>Child title</ModalTitle><button>Child action</button>
      </Modal>}
    </Modal>}
  </>;
}

it('names the dialog and restores the focused opener after Escape', async () => {
  render(<Fixture />);
  const opener = screen.getByRole('button', { name: 'Open parent' });
  opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Parent title' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
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

it('dismisses from the overlay pointer and restores focus', async () => {
  render(<Fixture />);
  const opener = screen.getByRole('button', { name: 'Open parent' });
  opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog');
  // The outside-pointer listener is installed after opening, so the opening
  // gesture itself cannot immediately dismiss the dialog.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  fireEvent.pointerDown(dialog.parentElement!, { button: 0, pointerType: 'mouse' });
  fireEvent.pointerUp(dialog.parentElement!, { button: 0, pointerType: 'mouse' });
  fireEvent.click(dialog.parentElement!);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it('closes safely when the opener was removed while the dialog was open', async () => {
  function RemovedTrigger() {
    const [stage, setStage] = useState<'closed' | 'open' | 'done'>('closed');
    return <>{stage === 'closed' && <button onClick={() => setStage('open')}>Open</button>}
      {stage === 'open' && <Modal className="content" overlayClassName="overlay" onClose={() => setStage('done')}>
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
