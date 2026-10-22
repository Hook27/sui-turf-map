// Loads modules/realtime.js and modules/analyzer.js into an isolated vm context, the way the
// browser loads them as classic scripts (shared global scope, no import/export).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

export function loadModules(fetchImpl) {
  const noop = () => {};
  const el = { addEventListener: noop, style: {}, classList: { add: noop, remove: noop } };
  const ctx = vm.createContext({
    fetch: fetchImpl, TextEncoder, btoa, BigInt, Date, console, parseInt, Math, JSON, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
    localStorage: { getItem: () => null, setItem: noop },
    document: { getElementById: () => el, addEventListener: noop },
    window: {},
  });
  for (const f of ['realtime.js', 'analyzer.js']) {
    const file = path.join(REPO, 'modules', f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return ctx;
}

// Evaluate an expression inside the context (top-level const/let are not properties of ctx).
export const evalIn = (ctx, code) => vm.runInContext(code, ctx);
