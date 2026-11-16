import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

export type BackSource = "escape" | "browser" | "native";

export interface BackHandler {
  readonly handle: () => void | Promise<void>;
  readonly enabled?: () => boolean;
  readonly priority?: number;
  readonly signal?: AbortSignal;
}

const handlers = new Set<BackHandler>();
const activeHandlers = new Set<BackHandler>();
let refreshWebGuard: (() => void) | undefined;

/** A handler belongs to the lifetime of its page or overlay, not its DOM nodes. */
export function registerBackHandler(handler: BackHandler): () => void {
  const remove = () => {
    handlers.delete(handler);
    handler.signal?.removeEventListener("abort", remove);
  };
  if (!handler.signal?.aborted) {
    handlers.add(handler);
    handler.signal?.addEventListener("abort", remove, { once: true });
    refreshWebGuard?.();
  }
  return remove;
}

function currentHandler(): BackHandler | undefined {
  let current: BackHandler | undefined;
  for (const handler of handlers) {
    if (handler.signal?.aborted || handler.enabled?.() === false) continue;
    if (!current || (handler.priority ?? 0) >= (current.priority ?? 0)) current = handler;
  }
  return current;
}

/** Rapid repeated input is consumed while a navigation or confirmation is pending. */
export async function requestBack(_source: BackSource): Promise<boolean> {
  const handler = currentHandler();
  if (!handler) return activeHandlers.size > 0;
  if (activeHandlers.has(handler)) return true;
  activeHandlers.add(handler);
  try { await handler.handle(); }
  finally { activeHandlers.delete(handler); }
  return true;
}

interface HistoryMarker {
  readonly version: 1;
  readonly position: "base" | "guard";
}
const HISTORY_KEY = "__hocBackNavigation";

function historyMarker(state: unknown): HistoryMarker | undefined {
  if (!state || typeof state !== "object") return undefined;
  const marker = (state as Record<string, unknown>)[HISTORY_KEY] as Partial<HistoryMarker> | undefined;
  return marker?.version === 1 && (marker.position === "base" || marker.position === "guard")
    ? marker as HistoryMarker : undefined;
}

function markedState(state: unknown, position: HistoryMarker["position"]): Record<string, unknown> {
  // Preserve a router's object state; keep primitive/array state intact in a wrapper.
  const value = state && typeof state === "object" && !Array.isArray(state)
    ? state : { previousState: state };
  return { ...value, [HISTORY_KEY]: { version: 1, position } satisfies HistoryMarker };
}

export interface InstallBackNavigationOptions {
  readonly onNativeRoot: () => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/** Install once for the application, across launcher/runtime restarts. */
export async function installBackNavigation(options: InstallBackNavigationOptions): Promise<() => Promise<void>> {
  let disposed = false;
  let nativeRootPending = false;
  const report = (error: unknown) => { options.onError?.(error); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || (!activeHandlers.size && !currentHandler())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void requestBack("escape").catch(report);
  };
  window.addEventListener("keydown", onKeyDown);

  let removeNative: (() => Promise<void>) | undefined;
  let onPopState: (() => void) | undefined;
  let onPageShow: (() => void) | undefined;
  let observer: MutationObserver | undefined;
  let refreshGuard: (() => void) | undefined;
  try {
    if (Capacitor.isNativePlatform()) {
      const listener = await App.addListener("backButton", () => {
        if (disposed) return;
        void requestBack("native").then(async handled => {
          if (handled || disposed || nativeRootPending) return;
          nativeRootPending = true;
          try { await options.onNativeRoot(); }
          finally { nativeRootPending = false; }
        }).catch(report);
      });
      removeNative = () => listener.remove();
    } else {
      const history = window.history;
      // Restricted embedded browsers can deny History API writes. Keyboard back
      // must still work, and a denied guard must never prevent application boot.
      try {
        if (historyMarker(history.state)?.position !== "guard") {
          history.replaceState(markedState(history.state, "base"), "");
          history.pushState(markedState(history.state, "guard"), "");
        }
        let leavingRoot = false;
        refreshGuard = () => {
          try {
            if (!disposed && !leavingRoot && historyMarker(history.state)?.position === "base" && currentHandler()) {
              history.pushState(markedState(history.state, "guard"), "");
            }
          } catch (error) { report(error); }
        };
        refreshWebGuard = refreshGuard;
        const restoreForward = (): boolean => {
          if (!leavingRoot) return false;
          if (historyMarker(history.state)?.position === "base") {
            history.pushState(markedState(history.state, "guard"), "");
            leavingRoot = false;
          }
          return true;
        };
        onPopState = () => {
          try {
            if (disposed) return;
            if (historyMarker(history.state)?.position === "guard") { leavingRoot = false; return; }
            // A forward/BFCache restoration only reinstates protection; it must
            // not close whatever the restored page currently displays.
            if (restoreForward()) return;
            if (!currentHandler() && !activeHandlers.size) {
              // Already at our base. Continue normally, leaving no extra guard
              // in a new tab/PWA that has no preceding page to navigate to.
              leavingRoot = history.length > 2;
              history.go(-1);
              return;
            }
            // Re-arm synchronously before async dialogs run. Every return attempt
            // uses this same slot, so cancelling never grows the history.
            history.pushState(markedState(history.state, "guard"), "");
            void requestBack("browser").then(handled => {
              if (!handled && !disposed) {
                // A handler can disappear while handling is being scheduled.
                leavingRoot = history.length > 2;
                history.go(-2);
              }
            }).catch(report);
          } catch (error) { report(error); }
        };
        onPageShow = () => { try { restoreForward(); } catch (error) { report(error); } };
        window.addEventListener("popstate", onPopState);
        window.addEventListener("pageshow", onPageShow);
        if (typeof MutationObserver !== "undefined") {
          observer = new MutationObserver(refreshGuard);
          observer.observe(document.documentElement, {
            subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden", "class"]
          });
        }
      } catch (error) { report(error); }
    }
  } catch (error) {
    window.removeEventListener("keydown", onKeyDown);
    if (onPopState) window.removeEventListener("popstate", onPopState);
    if (onPageShow) window.removeEventListener("pageshow", onPageShow);
    observer?.disconnect();
    if (refreshWebGuard === refreshGuard) refreshWebGuard = undefined;
    throw error;
  }
  return async () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("keydown", onKeyDown);
    if (onPopState) window.removeEventListener("popstate", onPopState);
    if (onPageShow) window.removeEventListener("pageshow", onPageShow);
    observer?.disconnect();
    if (refreshWebGuard === refreshGuard) refreshWebGuard = undefined;
    await removeNative?.();
  };
}
