// Register a jsdom window as the global DOM before importing modules that
// capture `window` at import time (DOMPurify). Import this first, then
// dynamically import the module under test.
import { JSDOM } from "jsdom";

// A concrete URL gives the window a non-opaque origin, which localStorage
// requires.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).localStorage = dom.window.localStorage;
for (const key of [
  "Node",
  "Element",
  "HTMLElement",
  "HTMLTemplateElement",
  "DocumentFragment",
  "NodeFilter",
  "NamedNodeMap",
  "DOMParser",
  "Text",
  "Comment",
]) {
  (globalThis as any)[key] = (dom.window as any)[key];
}
