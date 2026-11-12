// Gate registry. First gate whose match(url) returns true handles that URL.
// To add a gate: copy _template.mjs to <name>.mjs, implement it, import it here.

import hypeddit from './hypeddit.mjs';
import droploud from './droploud.mjs';

export const GATES = [hypeddit, droploud];

export function findGate(url) {
  return GATES.find(g => { try { return g.match(url); } catch { return false; } }) || null;
}
