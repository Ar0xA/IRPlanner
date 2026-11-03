// Ability tooltip token scaling/formatting, ported from the Tabula Rasa 1.16.5.0 client bytecode.
// See tools/ABILITY_TOOLTIPS.md for the source functions. Dependency-free ES module.
//
// tokenSpec (one pump, from tools/ability_tokens.py -> ability_tokens.json "abilities"[id][pump]):
//   { token: "<display string>" | { scale: <scaleTypeId>, base: <number> } }
// Display strings were already formatted the way the client formats them (Python 2.4 '%s').
// Level-scaled entries are computed here with shared/scaling.ScaleActorAmount.

export const SCALE_ACTOR_LINEAR = 1; // shared/scaling.pyo
export const SCALE_ACTOR_EXP = 2;

// shared.scaling.ScaleActorAmount(actor, baseAmount, scaleTypeId); actor.GetExperienceLevel() == level.
// Returns a Number; isInt tells whether the Python result was an int (int(...) was applied).
export function scaleActorAmount(level, baseAmount, scaleTypeId) {
  if (baseAmount === null || baseAmount === undefined) return { value: null, isInt: false };
  if (scaleTypeId === SCALE_ACTOR_LINEAR) {
    // int(baseAmount / 100.0 * (100 + (level - 1) * 100.0 / 3.0))
    return { value: Math.trunc(baseAmount / 100.0 * (100 + (level - 1) * 100.0 / 3.0)), isInt: true };
  }
  if (scaleTypeId === SCALE_ACTOR_EXP) {
    // ScaleExponentialAmount(base, level - 1, 8.0) = int(base * pow(2, (level - 1) / 8.0))
    return { value: Math.trunc(baseAmount * Math.pow(2, (level - 1) / 8.0)), isInt: true };
  }
  return { value: baseAmount, isInt: Number.isInteger(baseAmount) }; // unchanged
}

// '%s' % value as Python 2.4 (Windows build) prints it.
export function pyStr(value, isInt = Number.isInteger(value)) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value !== 'number') return String(value);
  if (isInt) return BigInt(Math.trunc(value)).toString();
  return pyFloatStr(value);
}

// str(float) in Python 2.4: "%.12g", then ".0" appended when only digits remain.
export function pyFloatStr(x) {
  if (Number.isNaN(x)) return 'nan';           // MSVC CRT would print '-1.#IND'; not reachable for tooltips
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  let s;
  if (x === 0) {
    s = Object.is(x, -0) ? '-0' : '0';
  } else {
    const P = 12;
    const exp = Number(x.toExponential(P - 1).split('e')[1]);
    if (exp < -4 || exp >= P) {
      let [m, e] = x.toExponential(P - 1).split('e');
      if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
      const sign = e[0] === '-' ? '-' : '+';
      s = m + 'e' + sign + e.replace(/^[+-]/, '').padStart(3, '0'); // MSVC: 3-digit exponent
    } else {
      s = x.toFixed(Math.max(0, P - 1 - exp));
      if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
  }
  if (/^-?\d+$/.test(s)) s += '.0';
  return s;
}

// Resolve one pump's token spec at a character level -> { token: displayString }.
// `attributes` is accepted for API stability but unused: the client's GetAbilityDataDict reads
// only actor.GetExperienceLevel() (no body/mind/spirit or other attribute enters any token).
export function resolveTokens(tokenSpec, level, attributes = undefined) { // eslint-disable-line no-unused-vars
  const out = {};
  for (const [token, v] of Object.entries(tokenSpec || {})) {
    if (v !== null && typeof v === 'object') {
      const r = scaleActorAmount(level, v.base, v.scale);
      out[token] = pyStr(r.value, r.isInt);
    } else {
      out[token] = String(v);
    }
  }
  return out;
}

// string.Template(text).safe_substitute(values) (client/system/string.pyo = Python 2.4 stdlib):
// delimiter '$', idpattern [_a-z][_a-z0-9]* with IGNORECASE. "$$" -> "$"; "$name" and "${name}"
// are both substituted; unknown names and malformed "$" are left as written.
const TEMPLATE_RE = /\$(?:(\$)|([_a-z][_a-z0-9]*)|\{([_a-z][_a-z0-9]*)\}|())/gi;
export function fillTemplate(text, values) {
  return String(text).replace(TEMPLATE_RE, (whole, escaped, named, braced) => {
    const name = named ?? braced;
    if (name !== undefined) {
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole;
    }
    return '$'; // escaped "$$" or invalid "$"
  });
}
