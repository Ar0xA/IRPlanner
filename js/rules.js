// Character progression rules.
//
// Sources, in order of authority:
//  [client]  Tabula Rasa client 1.16.5.0 bytecode/data (see js/data/gamedata.js, tools/build_data.py)
//  [server]  Rasa.NET, InfiniteRasa/Rasa.NET (development), src/Rasa.Game/Managers/ManifestationManager.cs
//            - the server this planner targets. The retail client receives these numbers
//            from the server and does not contain them itself.

import { GAME } from './data/gamedata.js';

export const MAX_LEVEL = GAME.maxLevel; // [client] experienceTable

// [client] skillsabilitieswindow.OnPlus: raising a skill to pump N costs N points.
// Cumulative cost of holding rank N: 0, 1, 3, 6, 10, 15.
export function rankCost(rank) {
  return (rank * (rank + 1)) / 2;
}

// [server] CharacterManager.StartingSkills: new characters hold these Recruit skills at rank 1,
// and a skill respec keeps them at rank 1.
export const STARTING_SKILL_KEYS = [
  't1_recruit_lightning', 't1_recruit_sprint', 't1_recruit_firearms',
  't1_recruit_hand_to_hand', 't1_recruit_motor_assist_armor',
];

// [server] ManifestationManager.SkillPointBudget: 2 per level after the first, +5 for the
// starting Recruit ranks, +2 at levels 5, 15 and 30, +4 at 50.
export function skillPointBudget(level) {
  let points = (level - 1) * 2 + 5;
  if (level >= 5) points += 2;
  if (level >= 15) points += 2;
  if (level >= 30) points += 2;
  if (level >= 50) points += 4;
  return points;
}

// [server] GetAvailableAttributePoints: 3 free points per level after the first.
export function attributePointBudget(level) {
  return 3 * (level - 1);
}

// [server] UpdateStatsValues: every race starts at 10/10/10 and gains these per level.
export const RACE_GROWTH = {
  human:         { body: 2, mind: 2, spirit: 2 },
  forean_hybrid: { body: 1, mind: 3, spirit: 2 },
  brann_hybrid:  { body: 1, mind: 1, spirit: 4 },
  thrax_hybrid:  { body: 3, mind: 1, spirit: 2 },
};

export function baseAttributes(raceKey, level) {
  const g = RACE_GROWTH[raceKey] || RACE_GROWTH.human;
  const n = level - 1;
  return { body: 10 + g.body * n, mind: 10 + g.mind * n, spirit: 10 + g.spirit * n };
}

// [server] HealthBaselinePerLevel (levels 1..50).
const HEALTH_BASELINE = [
  286.5784148, 312.51565127, 340.8003787, 371.6450605, 405.28138942, 441.96202792, 481.96250612,
  525.58329139, 573.15204539, 625.02608535, 681.59506802, 743.28391668, 810.55601298, 883.91667764,
  963.91696626, 1051.15780858, 1146.29452247, 1250.04173638, 1363.17875735, 1486.55542483,
  1621.09849437, 1767.818599, 1927.81784069, 2102.29806892, 2292.56990847, 2500.06260431,
  2726.33475751, 2973.08603281, 3242.1699258, 3535.60768567, 3855.60349799, 4204.56104164,
  4585.10154431, 5000.08347207, 5452.62400104, 5946.1224323, 6484.28572615, 7071.15634718,
  7711.14262974, 8409.05189147, 9170.12654399, 10000.08347172, 10905.15697485, 11892.14559882,
  12968.4632023, 14142.19464703, 15422.15652808, 16817.9634005, 18340.1, 20000,
];

// [client] shared/gameconstants: what the retail server used. The client defines these but never
// reads them, so they are the only record of the retail rates.
// (BODY_ARMOR_DIVISOR is 1.5: 1% armor per 1.5 Body, which the server's 0.0066666 below matches.)
const MIND_DAMAGE_DIVISOR = 3;     // 1% Logos damage per 3 Mind
const SPIRIT_CRIT_DIVISOR = 15;    // 1% crit chance per 15 Spirit
export const BASE_CRITICAL_CHANCE = 5;

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
  const perHealth = f(f(HEALTH_BASELINE[level - 1]) / f(divisor));
  const health = Math.max(1, Math.trunc(f(perHealth * f(spirit + 2 * body))));
  // The Power attribute's own line, near the end of UpdateStatsValues. Only spent Mind counts,
  // not a race's Mind growth. (The Body + 2 Mind formula was the old adrenaline bar, which is
  // now a fixed 1000 for everyone.)
  const power = 100 + (level - 1) * 8 + (spent.mind || 0) * 3;
  const perRegen = f(f(2 * level + 100) / f(divisor));
  const regen = Math.trunc(f(perRegen * f(mind + 2 * spirit)));
  const regenPerSecond = roundHalfEven((2 * regen) / 100);

  return {
    body, mind, spirit,
    health, power, regen, regenPerSecond,
    // [server] armorMax * (1 + total Body * 0.0066666): a bonus on worn armor, from all Body.
    armorBonus: body * 0.66666,
    // [client] rate only: Rasa.NET does not apply Mind to Logos damage yet. Measured above the
    // level's base, like crit.
    logosBonus: Math.max(0, mind - humanBase) / MIND_DAMAGE_DIVISOR,
    // [server] CriticalHits.AttackerChance: base chance plus Spirit above the level's base.
    critChance: BASE_CRITICAL_CHANCE + Math.max(0, spirit - humanBase) / SPIRIT_CRIT_DIVISOR,
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
  return !!GAME.skills[skillId]?.signature;
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
  const big = attributePointBudget(MAX_LEVEL);
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
