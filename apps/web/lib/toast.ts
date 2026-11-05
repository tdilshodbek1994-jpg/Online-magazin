/** Tiny global toast: toast('✓ Tasdiqlandi') from anywhere; <Toaster/> in the layout shows it at the top of the screen. */
export type ToastKind = 'ok' | 'err' | 'info';
export function toast(text: string, kind: ToastKind = 'ok') {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('om-toast', { detail: { text, kind } }));
}
