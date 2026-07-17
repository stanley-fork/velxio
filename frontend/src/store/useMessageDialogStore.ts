/**
 * Global message dialog store — the in-app replacement for window.alert().
 *
 * Any code can open the dialog:
 *   - React components: `showMessageDialog('...', { kind: 'error' })`
 *   - Plain .ts modules (desktop menu handlers, services): same call —
 *     zustand stores work outside React via getState().
 *
 * The dialog itself is rendered by <MessageDialogHost />, mounted once in
 * App.tsx. The pro overlay reuses this store via `@velxio/store/...`.
 */

import { create } from 'zustand';

export type MessageDialogKind = 'info' | 'success' | 'error';

export interface MessageDialogOptions {
  kind?: MessageDialogKind;
  /** Optional header line. Callers pass an already-translated string. */
  title?: string;
}

interface MessageDialogState {
  open: boolean;
  kind: MessageDialogKind;
  title: string | null;
  message: string;
  show: (message: string, opts?: MessageDialogOptions) => void;
  close: () => void;
}

export const useMessageDialogStore = create<MessageDialogState>((set) => ({
  open: false,
  kind: 'info',
  title: null,
  message: '',
  show: (message, opts) =>
    set({
      open: true,
      message,
      kind: opts?.kind ?? 'info',
      title: opts?.title ?? null,
    }),
  close: () => set({ open: false }),
}));

/** Imperative helper so non-React callers don't need to know zustand. */
export function showMessageDialog(message: string, opts?: MessageDialogOptions): void {
  useMessageDialogStore.getState().show(message, opts);
}
