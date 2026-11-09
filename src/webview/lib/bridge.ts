// postMessage bridge between the webview and the extension host.
// Requests are correlated by an incrementing id; unsolicited messages with a
// `type` (e.g. "changed") are delivered to event listeners.

type VsCodeApi = {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
let seq = 0;
const pending = new Map<number, (value: unknown) => void>();
const listeners = new Set<(e: any) => void>();

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m && typeof m.id === "number" && pending.has(m.id)) {
    pending.get(m.id)!(m.result);
    pending.delete(m.id);
  } else if (m && m.type) {
    for (const l of listeners) l(m);
  }
});

export function request<T>(
  type: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve) => {
    pending.set(id, resolve as (v: unknown) => void);
    // Deep-clone to strip Svelte $state proxies — postMessage's structured
    // clone throws on proxies, which would silently drop saves.
    const msg = JSON.parse(JSON.stringify({ id, type, ...payload }));
    vscode.postMessage(msg);
  });
}

export function onEvent(cb: (e: any) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
