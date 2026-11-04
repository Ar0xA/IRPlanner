// Character and build persistence in localStorage.
// A character (name, race) holds any number of builds (level, career, skills, attributes).
// Every read/write is guarded: storage can be unavailable (private mode, blocked
// site data), and the app must still work in memory.

import { normalizeBuild, normalizeRace } from './rules.js';

const KEY = 'irplanner.v2';
const LEGACY_KEYS = ['afsplanner.v2']; // read once if KEY is empty (the app was called AFSPlanner)

function blankState() {
  return { version: 2, activeCharacterId: null, characters: [] };
}

function load() {
  try {
    let raw = localStorage.getItem(KEY);
    for (const legacy of LEGACY_KEYS) raw ??= localStorage.getItem(legacy);
    if (!raw) return blankState();
    const state = JSON.parse(raw);
    if (!state || !Array.isArray(state.characters)) return blankState();
    state.characters = state.characters.filter(c => c && typeof c === 'object').map(cleanCharacter);
    return state;
  } catch {
    return blankState();
  }
}

let state = load();
let persistent = true;
const listeners = new Set();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    persistent = true;
  } catch {
    persistent = false;
  }
  for (const fn of listeners) fn();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newBuild(name = 'Build 1') {
  return {
    id: uid(),
    name,
    level: 1,
    career: 1,           // client character class id (1 = Recruit)
    skills: {},          // client skillId -> rank (absent = the skill's minimum rank)
    attributes: { body: 0, mind: 0, spirit: 0 }, // points spent above race base
    notes: '',
  };
}

export function newCharacter(name = 'New character') {
  const now = Date.now();
  const build = newBuild();
  return { id: uid(), name, race: 'human', notes: '', created: now, updated: now, activeBuildId: build.id, builds: [build] };
}

function findChar(id) {
  return state.characters.find(c => c.id === id) || null;
}

function touch(char) {
  char.updated = Date.now();
  save();
}

export const store = {
  isPersistent: () => persistent,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  characters: () => state.characters,
  activeCharacter: () => findChar(state.activeCharacterId),
  activeBuild() {
    const c = this.activeCharacter();
    return c ? c.builds.find(b => b.id === c.activeBuildId) || c.builds[0] || null : null;
  },

  selectCharacter(id) { state.activeCharacterId = id; save(); },
  selectBuild(buildId) {
    const c = this.activeCharacter();
    if (c) { c.activeBuildId = buildId; save(); }
  },

  createCharacter(name) {
    const c = newCharacter(name || `Character ${state.characters.length + 1}`);
    state.characters.push(c);
    state.activeCharacterId = c.id;
    save();
    return c;
  },

  updateCharacter(id, fields) {
    const c = findChar(id);
    if (!c) return;
    Object.assign(c, fields);
    touch(c);
  },

  duplicateCharacter(id) {
    const src = findChar(id);
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = uid();
    copy.name = `${src.name} (copy)`;
    copy.created = copy.updated = Date.now();
    for (const b of copy.builds) {
      const old = b.id;
      b.id = uid();
      if (copy.activeBuildId === old) copy.activeBuildId = b.id;
    }
    state.characters.push(copy);
    state.activeCharacterId = copy.id;
    save();
    return copy;
  },

  removeCharacter(id) {
    state.characters = state.characters.filter(c => c.id !== id);
    if (state.activeCharacterId === id) state.activeCharacterId = state.characters[0]?.id ?? null;
    save();
  },

  createBuild(name) {
    const c = this.activeCharacter();
    if (!c) return null;
    const b = newBuild(name || `Build ${c.builds.length + 1}`);
    c.builds.push(b);
    c.activeBuildId = b.id;
    touch(c);
    return b;
  },

  updateBuild(build) {
    const c = this.activeCharacter();
    if (!c) return;
    const i = c.builds.findIndex(b => b.id === build.id);
    if (i >= 0) c.builds[i] = build;
    touch(c);
  },

  duplicateBuild(buildId) {
    const c = this.activeCharacter();
    const src = c?.builds.find(b => b.id === buildId);
    if (!src) return null;
    const copy = { ...structuredClone(src), id: uid(), name: `${src.name} (copy)` };
    c.builds.push(copy);
    c.activeBuildId = copy.id;
    touch(c);
    return copy;
  },

  removeBuild(buildId) {
    const c = this.activeCharacter();
    if (!c || c.builds.length <= 1) return; // a character always keeps one build
    c.builds = c.builds.filter(b => b.id !== buildId);
    if (c.activeBuildId === buildId) c.activeBuildId = c.builds[0].id;
    touch(c);
  },

  // Import a shared build as a new character, or as a new build of the active one.
  importShared(shared, { asNewCharacter }) {
    const build = cleanBuild({ ...shared.build, id: undefined });
    if (asNewCharacter || !this.activeCharacter()) {
      const name = typeof shared.character === 'string' && shared.character ? shared.character.slice(0, 60) : 'Imported character';
      const c = newCharacter(name);
      c.race = normalizeRace(shared.race);
      c.builds = [build];
      c.activeBuildId = build.id;
      state.characters.push(c);
      state.activeCharacterId = c.id;
      save();
      return c;
    }
    const c = this.activeCharacter();
    c.builds.push(build);
    c.activeBuildId = build.id;
    touch(c);
    return c;
  },

  // Whole-database backup as a JSON string, and restore (merges, never overwrites).
  exportAll: () => JSON.stringify(state, null, 1),
  importAll(json) {
    const incoming = JSON.parse(json);
    if (!incoming || !Array.isArray(incoming.characters)) throw new Error('Not an IRPlanner backup');
    const restored = incoming.characters.filter(c => c && typeof c === 'object');
    for (const c of restored) state.characters.push({ ...cleanCharacter(c), id: uid() });
    state.activeCharacterId ??= state.characters[0]?.id ?? null;
    save();
    return restored.length;
  },
};

// Saved and imported data is checked before use: it may be old, hand-edited or damaged.
function cleanBuild(b) {
  const clean = normalizeBuild({ ...newBuild(), ...sanitizeBuild(b) });
  if (typeof b?.id === 'string' && b.id) clean.id = b.id;
  return clean;
}

function cleanCharacter(c) {
  const builds = (Array.isArray(c.builds) ? c.builds : []).filter(b => b && typeof b === 'object').map(cleanBuild);
  if (!builds.length) builds.push(newBuild());
  return {
    ...c,
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    name: typeof c.name === 'string' && c.name ? c.name.slice(0, 60) : 'Unnamed',
    race: normalizeRace(c.race),
    builds,
    activeBuildId: builds.some(b => b.id === c.activeBuildId) ? c.activeBuildId : builds[0].id,
  };
}

function sanitizeBuild(b = {}) {
  const out = {};
  if (typeof b.name === 'string') out.name = b.name.slice(0, 80);
  if (Number.isInteger(b.level)) out.level = b.level;
  if (Number.isInteger(b.career)) out.career = b.career;
  if (b.skills && typeof b.skills === 'object') {
    out.skills = {};
    for (const [k, v] of Object.entries(b.skills)) if (Number.isInteger(v)) out.skills[k] = v;
  }
  if (b.attributes && typeof b.attributes === 'object') {
    out.attributes = { body: 0, mind: 0, spirit: 0 };
    for (const k of Object.keys(out.attributes)) if (Number.isInteger(b.attributes[k])) out.attributes[k] = b.attributes[k];
  }
  if (typeof b.notes === 'string') out.notes = b.notes.slice(0, 2000);
  return out;
}

// Share codes: base64url JSON of one build plus its character's race and name.
export function encodeShare(character, build) {
  const { name, level, career, skills, attributes, notes } = build;
  const json = JSON.stringify({ v: 2, character: character.name, race: character.race, build: { name, level, career, skills, attributes, notes } });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(code) {
  const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  const obj = JSON.parse(new TextDecoder().decode(bytes));
  if (!obj || obj.v !== 2 || !obj.build) throw new Error('Unrecognized build code');
  return obj;
}
