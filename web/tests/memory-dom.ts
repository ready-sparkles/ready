// Install DOM globals before React DOM evaluates its event support checks.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom lacks pointer capture; browsers implement it, so provide a minimal stand-in for drag tests.
const capturedPointerIds = new WeakMap<Element, Set<number>>();
if (typeof HTMLElement.prototype.setPointerCapture !== "function") {
  HTMLElement.prototype.setPointerCapture = function setPointerCapture(this: Element, pointerId: number) {
    const ids = capturedPointerIds.get(this) ?? new Set<number>();
    ids.add(pointerId);
    capturedPointerIds.set(this, ids);
  };
  HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(this: Element, pointerId: number) {
    capturedPointerIds.get(this)?.delete(pointerId);
  };
  HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(this: Element, pointerId: number) {
    return capturedPointerIds.get(this)?.has(pointerId) ?? false;
  };
}
