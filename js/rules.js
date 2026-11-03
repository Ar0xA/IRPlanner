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

// [server] UpdateStatsValues, without equipment modules or active effects.
// Float math in C# single precision is close enough to double here; results are truncated
// to int exactly like the server's (int) casts.
export function derivedStats(raceKey, level, spent) {
  const base = baseAttributes(raceKey, level);
  const body = base.body + (spent.body || 0);
  const mind = base.mind + (spent.mind || 0);
  const spirit = base.spirit + (spent.spirit || 0);
  const humanBase = 2 * (level - 1) + 10;
  const divisor = 2 * (level - 1) + 2 * humanBase + 10;

  const health = Math.max(1, Math.trunc((HEALTH_BASELINE[level - 1] / divisor) * (spirit + 2 * body)));
  const power = Math.trunc(((3 * level + 100) / divisor) * (body + 2 * mind));
  const regen = Math.trunc(((2 * level + 100) / divisor) * (mind + 2 * spirit));
  const regenPerSecond = Math.round((2 * regen) / 100);

  return {
    body, mind, spirit,
    health, power, regen, regenPerSecond,
    armorBonus: Math.max(0, (body - humanBase) * 0.667),
    logosBonus: Math.max(0, (mind - humanBase) * 0.375),
    critBonus: Math.max(0, (spirit - humanBase) * 0.065),
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

export function minRank(skillId) {
  return isStartingSkill(skillId) ? 1 : 0;
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
  for (const id of Object.keys(GAME.skills)) total += rankCost(rankOf(build, Number(id)));
  return total;
}

export function spentAttributePoints(build) {
  const a = build.attributes;
  return (a.body || 0) + (a.mind || 0) + (a.spirit || 0);
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
