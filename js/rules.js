// Character progression rules.
//
// Sources, in order of authority:
//  [client]  Tabula Rasa client 1.16.5.0 bytecode/data (see js/data/gamedata.js, tools/build_data.py)
//  [server]  Rasa.NET, InfiniteRasa/Rasa.NET (development), src/Rasa.Game/Managers/ManifestationManager.cs
//            - the server this planner targets. The retail client receives these numbers
//            from the server and does not contain them itself.
//
// Server numbers live in RULES. DEFAULT_RULES is the fallback that is always there: a complete
// table, matching Rasa.NET at the commit named in tests/tests.js. js/serverrules.js can replace
// values with ones read from a server repository, but only values that pass validRule.

import { GAME } from './data/gamedata.js';

export const MAX_LEVEL = GAME.maxLevel; // [client] experienceTable

export const DEFAULT_RULES = Object.freeze({
  // [client] skillsabilitieswindow.OnPlus: raising a skill to pump N costs N points.
  // [server] requiredSkillLevelPoints: the cumulative cost of holding each rank.
  rankCosts: [0, 1, 3, 6, 10, 15],
  // [server] GetSkillPointsAvailable: 2 per level after the first, +5 for the starting Recruit
  // ranks, +2 at levels 5, 15 and 30, +4 at 50.
  skillPerLevel: 2,
  skillStart: 5,
  skillBonuses: [[5, 2], [15, 2], [30, 2], [50, 4]],
  // [server] GetAvailableAttributePoints: 3 free points per level after the first.
  attrPerLevel: 3,
  // [server] UpdateStatsValues: every race starts at 10/10/10 and gains these per level.
  raceGrowth: {
    human:         { body: 2, mind: 2, spirit: 2 },
    forean_hybrid: { body: 1, mind: 3, spirit: 2 },
    brann_hybrid:  { body: 1, mind: 1, spirit: 4 },
    thrax_hybrid:  { body: 3, mind: 1, spirit: 2 },
  },
  // [server] HealthBaselinePerLevel (levels 1..50).
  healthTable: [
    286.5784148, 312.51565127, 340.8003787, 371.6450605, 405.28138942, 441.96202792, 481.96250612,
    525.58329139, 573.15204539, 625.02608535, 681.59506802, 743.28391668, 810.55601298, 883.91667764,
    963.91696626, 1051.15780858, 1146.29452247, 1250.04173638, 1363.17875735, 1486.55542483,
    1621.09849437, 1767.818599, 1927.81784069, 2102.29806892, 2292.56990847, 2500.06260431,
    2726.33475751, 2973.08603281, 3242.1699258, 3535.60768567, 3855.60349799, 4204.56104164,
    4585.10154431, 5000.08347207, 5452.62400104, 5946.1224323, 6484.28572615, 7071.15634718,
    7711.14262974, 8409.05189147, 9170.12654399, 10000.08347172, 10905.15697485, 11892.14559882,
    12968.4632023, 14142.19464703, 15422.15652808, 16817.9634005, 18340.1, 20000,
  ],
  // [server] The Power attribute's own line, near the end of UpdateStatsValues. Only spent Mind
  // counts, not a race's Mind growth.
  powerBase: 100,
  powerPerLevel: 8,
  powerPerMind: 3,
  // [server] baseRegen = (2 * level + 100) / divisor.
  regenPerLevel: 2,
  regenBase: 100,
  // [server] armorMax * (1 + total Body * 0.0066666): a bonus on worn armor, from all Body.
  armorPerBody: 0.0066666,
  // [server] CriticalHits: base chance plus Spirit above the level's base.
  critBase: 5,
  critDivisor: 15,
  // [server] SignatureSkills: given with the class, never trained, no points.
  signatureSkills: [20, 47, 92, 110, 149, 154, 156, 157],
  // [client] shared/gameconstants MIND_DAMAGE_DIVISOR 3.0: 1% Logos damage per 3 Mind, in percent
  // per point. Rasa.NET does not apply Mind to damage yet; js/serverrules.js switches logosApplied
  // on, and takes the server's rate if it has one, when that changes.
  logosPerPoint: 1 / 3,
  logosApplied: false,
});

// Whether a value is safe for the math, whatever its source: it may come from a saved file or
// from storage that has been damaged.
export function validRule(key, value) {
  const fallback = DEFAULT_RULES[key];
  const number = v => typeof v === 'number' && Number.isFinite(v);
  switch (key) {
    case 'healthTable':
    case 'rankCosts':
      return Array.isArray(value) && value.length === fallback.length && value.every(v => number(v) && v >= 0);
    case 'skillBonuses':
      return Array.isArray(value) && value.every(p => Array.isArray(p) && p.length === 2 && p.every(number));
    case 'signatureSkills':
      return Array.isArray(value) && value.every(Number.isInteger);
    case 'raceGrowth':
      return Object.keys(fallback).every(race => ['body', 'mind', 'spirit'].every(a => number(value?.[race]?.[a])));
    case 'logosApplied':
      return typeof value === 'boolean';
    case 'critDivisor':
      return number(value) && value > 0;
    default:
      return fallback !== undefined && number(value);
  }
}

// The rules in force: always complete, starting from the built-in table.
export const RULES = { ...DEFAULT_RULES };

export function applyRules(values = {}) {
  Object.assign(RULES, DEFAULT_RULES);
  for (const [key, value] of Object.entries(values || {})) if (validRule(key, value)) RULES[key] = value;
}

export function rankCost(rank) {
  return RULES.rankCosts[rank] ?? 0;
}

// [server] CharacterManager.StartingSkills: new characters hold these Recruit skills at rank 1,
// and a skill respec keeps them at rank 1.
export const STARTING_SKILL_KEYS = [
  't1_recruit_lightning', 't1_recruit_sprint', 't1_recruit_firearms',
  't1_recruit_hand_to_hand', 't1_recruit_motor_assist_armor',
];

export function skillPointBudget(level) {
  let points = (level - 1) * RULES.skillPerLevel + RULES.skillStart;
  for (const [atLevel, bonus] of RULES.skillBonuses) if (level >= atLevel) points += bonus;
  return points;
}

export function attributePointBudget(level) {
  return RULES.attrPerLevel * (level - 1);
}

export const RACE_GROWTH = DEFAULT_RULES.raceGrowth; // the race keys; growth itself is in RULES

export function baseAttributes(raceKey, level) {
  const g = RULES.raceGrowth[raceKey] || RULES.raceGrowth.human;
  const n = level - 1;
  return { body: 10 + g.body * n, mind: 10 + g.mind * n, spirit: 10 + g.spirit * n };
}

// [client] shared/gameconstants: what the retail server used. The client defines these but never
// reads them, so they are the only record of the retail rates.
// (BODY_ARMOR_DIVISOR is 1.5 and SPIRIT_CRIT_DIVISOR 15, which RULES matches; MIND_DAMAGE_DIVISOR
// is 3, RULES.logosPerPoint.)

// C# Math.Round: a midpoint goes to the even neighbour (2.5 -> 2, 3.5 -> 4).
function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff !== 0.5) return Math.round(x);
  return floor % 2 === 0 ? floor : floor + 1;
}

// [server] UpdateStatsValues, without equipment modules or active effects.
// The server does this in C# single-precision floats and truncates with (int). Math.fround
// repeats that step by step: plain doubles can land just under a whole number and truncate
// to one less than the server shows.
export function derivedStats(raceKey, level, spent) {
  const base = baseAttributes(raceKey, level);
  const body = base.body + (spent.body || 0);
  const mind = base.mind + (spent.mind || 0);
  const spirit = base.spirit + (spent.spirit || 0);
  const humanBase = 2 * (level - 1) + 10;
  const divisor = 2 * (level - 1) + 2 * humanBase + 10;

  const f = Math.fround;
  const perHealth = f(f(RULES.healthTable[level - 1]) / f(divisor));
  const health = Math.max(1, Math.trunc(f(perHealth * f(spirit + 2 * body))));
  const power = RULES.powerBase + (level - 1) * RULES.powerPerLevel + (spent.mind || 0) * RULES.powerPerMind;
  const perRegen = f(f(RULES.regenPerLevel * level + RULES.regenBase) / f(divisor));
  const regen = Math.trunc(f(perRegen * f(mind + 2 * spirit)));
  const regenPerSecond = roundHalfEven((2 * regen) / 100);

  return {
    body, mind, spirit,
    health, power, regen, regenPerSecond,
    armorBonus: body * RULES.armorPerBody * 100,
    // Measured above the level's base, like crit.
    logosBonus: Math.max(0, mind - humanBase) * RULES.logosPerPoint,
    critChance: RULES.critBase + Math.max(0, spirit - humanBase) / RULES.critDivisor,
  };
}

// ---- Career / skill legality -------------------------------------------------------------

export function lineage(classId) {
  const path = [];
  for (let id = classId; id; id = GAME.classes[id]?.parent) path.unshift(Number(id));
  return path;
}

export function isStartingSkill(skillId) {
  return STARTING_SKILL_KEYS.includes(GAME.skills[skillId]?.key);
}

// [server] IsSignatureSkill / GrantSignatureSkill: a Tier IV class's signature ability is given
// at its one rank with the class. It cannot be trained and costs no points.
export function isSignatureSkill(skillId) {
  return RULES.signatureSkills.includes(Number(skillId));
}

export function minRank(skillId) {
  return isStartingSkill(skillId) || isSignatureSkill(skillId) ? 1 : 0;
}

// Points a skill uses at a rank: the normal cost, except for signature skills.
export function skillCost(skillId, rank) {
  return isSignatureSkill(skillId) ? 0 : rankCost(rank);
}

// Skills a build can train: every skill of its class and the classes above it.
export function availableSkills(classId) {
  const path = new Set(lineage(classId));
  return Object.keys(GAME.skills).map(Number).filter(id => path.has(GAME.skills[id].class));
}

export function rankOf(build, skillId) {
  const r = build.skills[skillId];
  return r === undefined ? minRank(skillId) : r;
}

export function spentSkillPoints(build) {
  let total = 0;
  for (const id of Object.keys(GAME.skills)) total += skillCost(Number(id), rankOf(build, Number(id)));
  return total;
}

export function spentAttributePoints(build) {
  const a = build.attributes;
  return (a.body || 0) + (a.mind || 0) + (a.spirit || 0);
}

// Force a build's numbers into what the game allows, so a hand-edited backup or a damaged share
// code cannot break the page. Skills of classes off the path are dropped: they cannot be shown.
export function normalizeBuild(b) {
  const int = (v, min, max) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : min);
  const career = GAME.classes[b.career] ? b.career : 1;
  const allowed = new Set(availableSkills(career));
  const skills = {};
  for (const [id, rank] of Object.entries(b.skills || {})) {
    const n = Number(id);
    if (!allowed.has(n) || isSignatureSkill(n)) continue;
    const r = int(rank, minRank(n), GAME.skills[n].maxRank);
    if (r > minRank(n)) skills[n] = r;
  }
  const a = b.attributes || {};
  const big = 5000; // far above any budget; the rules in force may not be loaded yet
  return {
    ...b,
    level: int(b.level, 1, MAX_LEVEL),
    career,
    skills,
    attributes: { body: int(a.body, 0, big), mind: int(a.mind, 0, big), spirit: int(a.spirit, 0, big) },
  };
}

export function normalizeRace(raceKey) {
  return RACE_GROWTH[raceKey] ? raceKey : 'human';
}

// Everything wrong with a build, for display. Each issue: { level: 'error' | 'warn', text }.
export function validate(build, raceKey) {
  const issues = [];
  const cls = GAME.classes[build.career];
  if (!cls) {
    issues.push({ level: 'error', text: 'Unknown class.' });
    return issues;
  }
  for (const id of lineage(build.career)) {
    const c = GAME.classes[id];
    if (build.level < c.level) issues.push({ level: 'error', text: `${c.name} needs level ${c.level}.` });
  }
  const allowed = new Set(availableSkills(build.career));
  for (const [id, rank] of Object.entries(build.skills)) {
    const s = GAME.skills[id];
    if (!s) continue;
    if (rank > minRank(Number(id)) && !allowed.has(Number(id))) {
      issues.push({ level: 'error', text: `${displayName(s)} belongs to ${GAME.classes[s.class].name}, which this build has not trained.` });
    }
    if (rank > s.maxRank) issues.push({ level: 'error', text: `${displayName(s)} is above its maximum rank ${s.maxRank}.` });
  }
  const skillLeft = skillPointBudget(build.level) - spentSkillPoints(build);
  if (skillLeft < 0) issues.push({ level: 'error', text: `${-skillLeft} training point(s) over budget.` });
  const attrLeft = attributePointBudget(build.level) - spentAttributePoints(build);
  if (attrLeft < 0) issues.push({ level: 'error', text: `${-attrLeft} attribute point(s) over budget.` });
  if (!RACE_GROWTH[raceKey]) issues.push({ level: 'warn', text: 'Unknown race; using Human growth.' });
  return issues;
}

// Client names carry a prefix ("Skill: Firearms", "Ability: Lightning", "Signature Ability: …").
export function displayName(skill) {
  return skill.name.replace(/^(Signature Ability|Ability|Skill):\s*/, '');
}

export function skillKind(skill) {
  if (skill.signature) return 'Signature';
  return skill.abilities.length ? 'Ability' : 'Training';
}
