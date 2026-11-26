interface GoatCounterEvent {
  path: string;
  title?: string;
  event: true;
}

interface GoatCounterApi {
  count?: (vars: GoatCounterEvent) => void;
}

declare global {
  interface Window {
    goatcounter?: GoatCounterApi;
  }
}

const MAX_QUEUED_EVENTS = 16;
const QUEUE_TIMEOUT_MS = 10_000;

const sentOnce = new Set<string>();
const pendingQueue: GoatCounterEvent[] = [];
let scriptSettled = false;
let listenerBound = false;

function sendNow(payload: GoatCounterEvent): void {
  try {
    window.goatcounter?.count?.(payload);
  } catch {
    // Analytics must never interrupt gameplay.
  }
}

function flushQueue(): void {
  scriptSettled = true;
  if (typeof window.goatcounter?.count !== 'function') {
    pendingQueue.length = 0;
    return;
  }
  while (pendingQueue.length > 0) {
    const next = pendingQueue.shift();
    if (next) sendNow(next);
  }
}

function discardQueue(): void {
  scriptSettled = true;
  pendingQueue.length = 0;
}

function bindScriptListeners(): boolean {
  if (typeof document === 'undefined') return false;
  const script = document.querySelector<HTMLScriptElement>('script[data-goatcounter]');
  if (!script) {
    scriptSettled = true;
    return false;
  }
  if (!listenerBound) {
    listenerBound = true;
    script.addEventListener('load', flushQueue, { once: true });
    script.addEventListener('error', discardQueue, { once: true });
    window.setTimeout(() => {
      if (!scriptSettled) discardQueue();
    }, QUEUE_TIMEOUT_MS);
  }
  return true;
}

bindScriptListeners();

/**
 * Records a lightweight, cookieless GoatCounter custom event.
 * Safely no-ops in local dev, when `VITE_GOATCOUNTER_URL` is unset, or when blocked.
 */
export function trackEvent(path: string, title?: string): void {
  const cleanPath = path.replace(/^\/+/, '');
  if (!cleanPath) return;

  const payload: GoatCounterEvent = title
    ? { path: cleanPath, title, event: true }
    : { path: cleanPath, event: true };

  if (typeof window !== 'undefined' && typeof window.goatcounter?.count === 'function') {
    sendNow(payload);
    return;
  }

  if (scriptSettled || !bindScriptListeners()) return;

  if (pendingQueue.length < MAX_QUEUED_EVENTS) {
    pendingQueue.push(payload);
  }
}

/**
 * Records a GoatCounter custom event at most once per page session.
 */
export function trackEventOnce(path: string, title?: string): void {
  const cleanPath = path.replace(/^\/+/, '');
  if (!cleanPath || sentOnce.has(cleanPath)) return;
  sentOnce.add(cleanPath);
  trackEvent(cleanPath, title);
}
