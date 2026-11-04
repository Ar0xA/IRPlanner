// Reads the planner's server numbers from a Rasa.NET source tree on GitHub, so the planner can
// follow a repository, a branch or one commit.
//
// The fetched files are only ever searched for numbers: nothing from them is run or shown as
// markup. Each number has a strict pattern and a range check, and formulas are checked for the
// shape the planner assumes. A number that fails keeps its built-in value and is reported.

import { GAME } from './data/gamedata.js';
import { DEFAULT_RULES, applyRules } from './rules.js';
import { loadCopy, saveCopy } from './sourcestore.js';

export const DEFAULT_SOURCE = Object.freeze({ repo: 'InfiniteRasa/Rasa.NET', ref: 'development' });

const FILES = {
  manifestation: 'src/Rasa.Game/Managers/ManifestationManager.cs',
  critical: 'src/Rasa.Game/Managers/CriticalHits.cs',
  // Where ability damage is worked out: only read to notice Mind reaching it.
  ability: 'src/Rasa.Game/Managers/AbilityManager.cs',
  effects: 'src/Rasa.Game/Managers/GameEffectManager.cs',
};
const SETTINGS_KEY = 'irplanner.server';
const CACHE_KEY = 'irplanner.server.cache';
const MAX_FILE_SIZE = 5_000_000;
const TIMEOUT_MS = 15000;

// ---- source settings -----------------------------------------------------------------------

// Accepts owner/name or a GitHub URL (.git and /tree/<ref> allowed). Returns { repo, ref? } or null.
export function parseRepoInput(text) {
  const t = String(text || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = t.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/);
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) return null;
  return { repo: `${m[1]}/${m[2]}`, ...(m[3] ? { ref: m[3] } : {}) };
}

export function isValidRef(ref) {
  return /^[\w./-]{1,100}$/.test(ref) && !ref.includes('..') && !ref.startsWith('/') && !ref.endsWith('/');
}

export function isCommitHash(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* the rules still apply for this page view */ }
}

// null means the built-in numbers.
export function loadSource() {
  const saved = readJson(SETTINGS_KEY);
  if (saved?.builtin) return null;
  if (saved && parseRepoInput(saved.repo) && isValidRef(saved.ref || '')) return { repo: saved.repo, ref: saved.ref };
  return { ...DEFAULT_SOURCE };
}

export function saveSource(source) {
  writeJson(SETTINGS_KEY, source || { builtin: true });
}

// ---- reading numbers from the source -------------------------------------------------------

const num = v => Number(v);
const between = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

function section(text, start, end) {
  const i = text.indexOf(start);
  if (i < 0) return null;
  const j = text.indexOf(end, i);
  return j < 0 ? null : text.slice(i, j);
}

function readBudget(mm) {
  const body = section(mm, 'public int GetSkillPointsAvailable', 'foreach (var skill');
  if (!body) return null;
  const perLevel = body.match(/\(player\.Level - 1\) \* (\d+);/);
  const start = body.match(/\n\s*pointsAvailable \+= (\d+);/);
  const bonuses = [...body.matchAll(/if \(level >= (\d+)\)\s*pointsAvailable \+= (\d+);/g)].map(m => [num(m[1]), num(m[2])]);
  if (!perLevel || !start || !bonuses.length) return null;
  const value = { skillPerLevel: num(perLevel[1]), skillStart: num(start[1]), skillBonuses: bonuses };
  const ok = between(value.skillPerLevel, 0, 50) && between(value.skillStart, 0, 500)
    && bonuses.every(([level, points]) => between(level, 1, 50) && between(points, 0, 500));
  return ok ? value : null;
}

function readRaceGrowth(mm) {
  const body = section(mm, 'switch (player.Race)', 'int totalBody');
  if (!body) return null;
  const growth = {};
  const races = { Human: 'human', Forean: 'forean_hybrid', Brann: 'brann_hybrid', Thrax: 'thrax_hybrid' };
  for (const [name, key] of Object.entries(races)) {
    const block = body.match(new RegExp(`case Race\\.${name}:([\\s\\S]*?)break;`));
    if (!block) return null;
    const g = {};
    for (const m of block[1].matchAll(/((?:levelBased(?:Body|Mind|Spirit)\s*=\s*)+)(?:(\d+)\s*\*\s*)?\(level - 1\)\s*\+\s*(\d+);/g)) {
      if (num(m[3]) !== 10) return null; // the planner assumes a base of 10
      for (const attr of m[1].matchAll(/levelBased(Body|Mind|Spirit)/g)) g[attr[1].toLowerCase()] = m[2] ? num(m[2]) : 1;
    }
    if (!['body', 'mind', 'spirit'].every(a => between(g[a], 0, 20))) return null;
    growth[key] = g;
  }
  return growth;
}

// Whether the server applies Mind to Logos damage. Today it does not: ManifestationManager works
// out logosBonusPercent and never uses it. Any of these means that has changed:
//  1. logosBonusPercent is used after it is declared: its own rate applies.
//  2. A Mind damage divisor is declared (the client's constant is MIND_DAMAGE_DIVISOR): 1 / divisor.
//  3. Mind appears in the damage code with no rate the planner can read: the retail rate stays.
function readLogos({ mm, crit, ability, effects }) {
  if (!mm.includes('UpdateStatsValues')) return null;
  const code = [mm, crit, ability, effects].join('\n');
  const off = { logosApplied: false, logosPerPoint: DEFAULT_RULES.logosPerPoint };

  const declared = mm.match(/float logosBonusPercent = \(float\)Math\.Max\(0\.0, \(totalMind - \(2 \* \(level - 1\) \+ 10\)\) \* (\d+(?:\.\d+)?)\)/);
  const uses = (code.match(/\blogosBonusPercent\b/g) || []).length;
  if (declared && uses > 1 && between(num(declared[1]), 0.001, 100)) return { logosApplied: true, logosPerPoint: num(declared[1]) };

  const divisor = code.match(/\b(?:MindDamageDivisor|MindDivisor|MIND_DAMAGE_DIVISOR)\s*=\s*(\d+(?:\.\d+)?)/);
  if (divisor && between(num(divisor[1]), 0.1, 10000)) return { logosApplied: true, logosPerPoint: 1 / num(divisor[1]) };

  const inDamage = [ability, effects].join('\n').split('\n').some(line =>
    /Attributes\.Mind|SpentMind|totalMind/.test(line) && !/attribute == Attributes\.Mind|new ActorAttributes|^\s*\/\//.test(line));
  return inDamage ? { ...off, logosApplied: true } : off;
}

// What to read: label, the keys it fills, and how. A reader returns an object of RULES values,
// or null when the source no longer looks the way the planner expects.
const READERS = [
  { label: 'Training points per level', keys: ['skillPerLevel', 'skillStart', 'skillBonuses'], read: ({ mm }) => readBudget(mm) },
  {
    label: 'Rank costs', keys: ['rankCosts'], read: ({ mm }) => {
      const m = mm.match(/requiredSkillLevelPoints = \{([^}]*)\}/);
      const costs = m?.[1].split(',').map(x => num(x.trim()));
      const ok = costs?.length === 6 && costs[0] === 0 && costs.every((c, i) => between(c, 0, 1000) && (i === 0 || c > costs[i - 1]));
      return ok ? { rankCosts: costs } : null;
    },
  },
  {
    label: 'Attribute points per level', keys: ['attrPerLevel'], read: ({ mm }) => {
      const m = mm.match(/var points = (\d+) \* \(player\.Level - 1\);/);
      return m && between(num(m[1]), 0, 50) ? { attrPerLevel: num(m[1]) } : null;
    },
  },
  {
    label: 'Race growth', keys: ['raceGrowth'], read: ({ mm }) => {
      const raceGrowth = readRaceGrowth(mm);
      return raceGrowth ? { raceGrowth } : null;
    },
  },
  {
    label: 'Health table and formula', keys: ['healthTable'], read: ({ mm }) => {
      const m = mm.match(/HealthBaselinePerLevel\s*=\s*\{([^}]*)\}/);
      const table = m ? [...m[1].matchAll(/(\d+(?:\.\d+)?)f?/g)].map(x => num(x[1])) : [];
      const ok = table.length === GAME.maxLevel && table.every((v, i) => between(v, 1, 1e7) && (i === 0 || v > table[i - 1]));
      const shape = /levelBasedHealth \* \(totalSpirit \+ 2 \* totalBody\)/.test(mm);
      return ok && shape ? { healthTable: table } : null;
    },
  },
  {
    label: 'Power', keys: ['powerBase', 'powerPerLevel', 'powerPerMind'], read: ({ mm }) => {
      const m = mm.match(/Attributes\.Power\]\.NormalMax = (\d+) \+ \(player\.Level - 1\) \* (\d+)(?: \* (\d+))? \+ player\.SpentMind \* (\d+);/);
      if (!m) return null;
      const value = { powerBase: num(m[1]), powerPerLevel: num(m[2]) * num(m[3] || 1), powerPerMind: num(m[4]) };
      return between(value.powerBase, 0, 100000) && between(value.powerPerLevel, 0, 10000) && between(value.powerPerMind, 0, 1000) ? value : null;
    },
  },
  {
    label: 'Regeneration', keys: ['regenPerLevel', 'regenBase'], read: ({ mm }) => {
      const m = mm.match(/float baseRegen = \((\d+) \* level \+ (\d+)\) \/ attributeDivisor;/);
      const shape = /baseRegen \* \(totalMind \+ 2 \* totalSpirit\)/.test(mm);
      return m && shape && between(num(m[1]), 0, 100) && between(num(m[2]), 0, 10000)
        ? { regenPerLevel: num(m[1]), regenBase: num(m[2]) } : null;
    },
  },
  {
    label: 'Armor bonus', keys: ['armorPerBody'], read: ({ mm }) => {
      const m = mm.match(/armorBonusPct = player\.Attributes\[Attributes\.Body\]\.CurrentMax \* (\d+(?:\.\d+)?)d?;/);
      return m && between(num(m[1]), 0, 1) ? { armorPerBody: num(m[1]) } : null;
    },
  },
  {
    label: 'Crit chance', keys: ['critBase', 'critDivisor'], read: ({ crit }) => {
      const base = crit.match(/const double BaseChance = (\d+(?:\.\d+)?);/);
      const divisor = crit.match(/const double SpiritDivisor = (\d+(?:\.\d+)?);/);
      return base && divisor && between(num(base[1]), 0, 100) && between(num(divisor[1]), 0.1, 10000)
        ? { critBase: num(base[1]), critDivisor: num(divisor[1]) } : null;
    },
  },
  { label: 'Logos damage', keys: ['logosApplied', 'logosPerPoint'], read: readLogos },
  {
    label: 'Signature skills', keys: ['signatureSkills'], read: ({ mm }) => {
      const m = mm.match(/SignatureSkills = new HashSet<SkillId>\s*\{([^}]*)\}/);
      const ids = m ? [...m[1].matchAll(/\(SkillId\)(\d+)/g)].map(x => num(x[1])) : [];
      return ids.length && ids.every(id => GAME.skills[id]) ? { signatureSkills: ids } : null;
    },
  },
];

// Returns { values, read: [label], missed: [label], changed: [label] }. changed lists what differs
// from the built-in numbers.
export function parseServerSource({ manifestation = '', critical = '', ability = '', effects = '' }) {
  const lf = text => text.replace(/\r\n/g, '\n');
  const [mm, crit, abilityCode, effectCode] = [manifestation, critical, ability, effects].map(lf);
  const out = { values: {}, read: [], missed: [], changed: [] };
  for (const reader of READERS) {
    let value = null;
    try {
      value = reader.read({ mm, crit, ability: abilityCode, effects: effectCode });
    } catch { /* treated as not found */ }
    if (!value) {
      out.missed.push(reader.label);
      continue;
    }
    Object.assign(out.values, value);
    out.read.push(reader.label);
    if (reader.keys.some(k => JSON.stringify(value[k]) !== JSON.stringify(DEFAULT_RULES[k]))) out.changed.push(reader.label);
  }
  return out;
}

// ---- fetching ------------------------------------------------------------------------------

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, cache: 'no-cache' });
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_FILE_SIZE) throw new Error('file too large');
  return text;
}

function rawUrl({ repo, ref }, path) {
  const encodedRef = ref.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${repo}/${encodedRef}/${path}`;
}

// The commit a branch is on, for display. The API allows 60 calls an hour per visitor, so this is
// allowed to fail.
async function resolveCommit({ repo, ref }, signal) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, { signal });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json.sha === 'string' && /^[0-9a-f]{40}$/.test(json.sha) ? json.sha : null;
  } catch {
    return null;
  }
}

export async function fetchServerRules(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const optional = path => fetchText(rawUrl(source, path), controller.signal).catch(e => { if (e.message === 'not-found') return ''; throw e; });
    const [manifestation, critical, ability, effects, commit] = await Promise.all([
      fetchText(rawUrl(source, FILES.manifestation), controller.signal),
      optional(FILES.critical),
      optional(FILES.ability),
      optional(FILES.effects),
      resolveCommit(source, controller.signal),
    ]);
    const files = { manifestation, critical, ability, effects };
    const parsed = parseServerSource(files);
    if (parsed.read.length) await saveCopy(source, files, commit);
    return { ...parsed, commit, source, at: Date.now() };
  } catch (e) {
    if (e.message === 'not-found') throw new Error(`Couldn't find ${FILES.manifestation} in ${source.repo} at "${source.ref}". Check the repository and the branch, tag or commit.`);
    const failed = new Error(e.name === 'AbortError' ? 'GitHub took too long to answer.' : `Couldn't reach GitHub: ${e.message}`);
    failed.network = true;
    throw failed;
  } finally {
    clearTimeout(timer);
  }
}

// The files saved on this device for a source, read again. Null if there are none.
export async function readSavedCopy(source) {
  const copy = await loadCopy(source);
  if (!copy) return null;
  const parsed = parseServerSource(copy.files);
  return parsed.read.length ? { ...parsed, commit: copy.commit, source, at: copy.at, saved: true } : null;
}

// ---- state ---------------------------------------------------------------------------------

// { source, result, error, loading }: source null = built-in, result = last good read of source.
// A result with saved: true came from the files kept on this device.
export const serverRules = { source: null, result: null, error: null, loading: false };

const sameSource = (a, b) => a?.repo === b?.repo && a?.ref === b?.ref;

// Sync: applies the saved source's last good read, so the first render already uses it.
export function initServerRules() {
  serverRules.source = loadSource();
  const cached = readJson(CACHE_KEY);
  if (serverRules.source && cached?.values && sameSource(cached.source, serverRules.source)) {
    serverRules.result = cached;
    applyRules(cached.values);
  }
}

// A value that can't be read now keeps its last good value from the same source. Each value falls
// back in turn: this read, the last good read, then the built-in table (applyRules).
function withLastGood(read, previous) {
  if (!previous || !sameSource(previous.source, read.source)) return read;
  return { ...read, values: { ...previous.values, ...read.values } };
}

// Fetches the saved source. A commit never changes, so a cached read of one is kept.
export async function refreshServerRules() {
  const { source, result } = serverRules;
  if (!source || (result && isCommitHash(source.ref))) return false;
  serverRules.loading = true;
  try {
    const fresh = await fetchServerRules(source);
    if (!sameSource(serverRules.source, source)) return false; // switched while loading
    serverRules.error = null;
    if (!fresh.read.length) throw new Error(UNREADABLE);
    serverRules.result = withLastGood(fresh, result);
    applyRules(serverRules.result.values);
    writeJson(CACHE_KEY, serverRules.result);
    return true;
  } catch (e) {
    serverRules.error = e.message;
    const copy = e.network ? await readSavedCopy(source) : null;
    if (copy && sameSource(serverRules.source, source)) {
      serverRules.result = withLastGood(copy, result);
      applyRules(serverRules.result.values);
    }
    return !!copy;
  } finally {
    serverRules.loading = false;
  }
}

const UNREADABLE = 'No rules could be read from that source. It may be too old or too different from current Rasa.NET.';

// Switches source only if it can be read, so a typing mistake never changes the numbers. With no
// connection, a copy saved on this device will do.
export async function useSource(source) {
  if (!source) {
    saveSource(null);
    Object.assign(serverRules, { source: null, result: null, error: null });
    applyRules();
    return null;
  }
  let fresh;
  try {
    fresh = await fetchServerRules(source);
  } catch (e) {
    fresh = e.network ? await readSavedCopy(source) : null;
    if (!fresh) throw e;
  }
  if (!fresh.read.length) throw new Error(UNREADABLE);
  saveSource(source);
  Object.assign(serverRules, { source, result: fresh, error: fresh.saved ? 'No connection.' : null });
  applyRules(fresh.values);
  writeJson(CACHE_KEY, fresh);
  return fresh;
}

export function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : null;
}

// One line for the footer and the dialog.
export function describeRules() {
  const { source, result, error } = serverRules;
  if (!source) return 'Progression rules: built into the planner.';
  const where = `${source.repo} @ ${source.ref}${result?.commit && !isCommitHash(source.ref) ? ` (${shortCommit(result.commit)})` : ''}`;
  if (!result) return error ? `Progression rules: built in. Couldn't reach ${where}.` : `Progression rules: built in, loading ${where}…`;
  const stale = error ? ` (no connection: copy saved ${new Date(result.at).toLocaleDateString()})` : '';
  const missed = result.missed.length ? ` ${result.missed.length} value(s) kept from the last good read or the built-in table.` : '';
  return `Progression rules: ${where}${stale}.${missed}`;
}
