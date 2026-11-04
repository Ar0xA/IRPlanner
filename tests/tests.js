// Planner tests. Open tests/index.html from a local server (or the live site) and read the result.
// Reference numbers come from the Rasa.NET source and its unit tests, the client data, and
// tests/expected_stats.json (an independent 32-bit float version, tools/gen_expected_stats.py),
// and tests/server_stats.json (output of the real server code, tools/PlannerDumpTests.cs).
import { GAME } from '../js/data/gamedata.js';
import {
  MAX_LEVEL, rankCost, skillCost, skillPointBudget, attributePointBudget, baseAttributes, derivedStats,
  lineage, availableSkills, rankOf, minRank, isSignatureSkill, isStartingSkill, spentSkillPoints,
  spentAttributePoints, validate, normalizeBuild, normalizeRace, RACE_GROWTH, DEFAULT_RULES, applyRules, RULES,
} from '../js/rules.js';
import { parseServerSource, parseRepoInput, isValidRef, isCommitHash, readSavedCopy, refreshServerRules, serverRules } from '../js/serverrules.js';
import { saveCopy, loadCopy, listCopies } from '../js/sourcestore.js';
import { encodeShare, decodeShare } from '../js/storage.js';
import { abilityText } from '../js/abilitytext.js';
import { resolveTokens } from '../js/abilityscale.js';

const results = [];
function test(name, fn) {
  const failures = [];
  const eq = (actual, expected, label = '') => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const ok = (cond, label) => { if (!cond) failures.push(label); };
  try {
    fn({ eq, ok });
  } catch (e) {
    failures.push(`threw ${e.message}`);
  }
  results.push({ name, failures });
}

const build = (over = {}) => ({ level: 1, career: 1, skills: {}, attributes: { body: 0, mind: 0, spirit: 0 }, ...over });
const skillId = key => Number(Object.keys(GAME.skills).find(id => GAME.skills[id].key === key));
const classId = key => Number(Object.keys(GAME.classes).find(id => GAME.classes[id].key === key));

// ---- server reference values ---------------------------------------------------------------

test('Server unit test rows (AttributeProgressionTests)', ({ eq }) => {
  const rows = [
    [1, 'human', 10, 10, 10, 286, 102], [20, 'human', 48, 48, 48, 1486, 140], [26, 'human', 60, 60, 60, 2500, 152],
    [50, 'human', 108, 108, 108, 20000, 200], [20, 'forean_hybrid', 29, 67, 48, 1094, 158],
    [20, 'brann_hybrid', 29, 29, 86, 1486, 195], [20, 'thrax_hybrid', 67, 29, 48, 1878, 121],
  ];
  for (const [level, race, body, mind, spirit, health, regen] of rows) {
    const d = derivedStats(race, level, {});
    eq([d.body, d.mind, d.spirit, d.health, d.regen], [body, mind, spirit, health, regen], `L${level} ${race}`);
  }
  eq(derivedStats('human', 1, {}).power, 100, 'power L1');
  eq(derivedStats('human', 26, {}).regenPerSecond, 3, 'regen/s L26');
});

test('Power: 100 + 8 per level + 3 per spent Mind, no race effect', ({ eq }) => {
  eq(derivedStats('human', 30, {}).power, 332);
  eq(derivedStats('human', 30, { mind: 40 }).power, 452);
  eq(derivedStats('forean_hybrid', 30, {}).power, 332, 'Forean Mind growth adds nothing');
  eq(derivedStats('human', 30, { body: 50, spirit: 30 }).power, 332, 'only Mind counts');
  eq(derivedStats('human', 50, { mind: 147 }).power, 100 + 392 + 441);
});

test('Regen per second rounds midpoints to even, like C# Math.Round', ({ eq }) => {
  const seen = {};
  for (const race of Object.keys(RACE_GROWTH)) {
    for (let level = 1; level <= 50; level++) {
      for (let s = 0; s <= 3 * (level - 1); s += 3) {
        const d = derivedStats(race, level, { spirit: s });
        const exact = (2 * d.regen) / 100;
        if (exact % 1 === 0.5) seen[d.regen] = d.regenPerSecond;
      }
    }
  }
  for (const [regen, perSecond] of Object.entries(seen)) {
    const exact = (2 * Number(regen)) / 100;
    eq(perSecond % 2, 0, `regen ${regen} (${exact})`);
  }
});

test('Armor, Logos and crit use the retail rates', ({ eq, ok }) => {
  const near = (a, b, label) => ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
  const d = derivedStats('human', 30, { body: 30, mind: 45, spirit: 30 });
  near(d.armorBonus, 98 * 0.66666, 'armor is 1% per 1.5 of ALL Body');
  near(d.logosBonus, 15, 'logos is 1% per 3 Mind above base');
  near(d.critChance, 7, 'crit is 5% + 1% per 15 Spirit above base');
  near(derivedStats('human', 1, {}).armorBonus, 6.6666, 'armor at L1 Body 10');
  eq(derivedStats('human', 30, {}).critChance, 5, 'no spend: base crit only');
  eq(derivedStats('human', 30, {}).logosBonus, 0, 'no spend: no Logos bonus');
  eq(derivedStats('forean_hybrid', 30, {}).spirit, 68);
  eq(derivedStats('brann_hybrid', 30, {}).logosBonus, 0, 'below human base floors at 0');
  near(derivedStats('brann_hybrid', 30, {}).critChance, 5 + (126 - 68) / 15, 'Brann Spirit growth counts as above base');
});

test('Budgets at every breakpoint', ({ eq }) => {
  const table = { 1: 5, 2: 7, 4: 11, 5: 15, 14: 33, 15: 37, 29: 65, 30: 69, 49: 107, 50: 113 };
  for (const [level, points] of Object.entries(table)) eq(skillPointBudget(Number(level)), points, `L${level}`);
  for (let level = 1; level <= 50; level++) eq(attributePointBudget(level), 3 * (level - 1), `attr L${level}`);
});

test('Rank cost table matches the server', ({ eq }) => {
  eq([0, 1, 2, 3, 4, 5].map(rankCost), [0, 1, 3, 6, 10, 15]);
});

test('Base attributes: race growth from 10/10/10', ({ eq }) => {
  eq(baseAttributes('human', 1), { body: 10, mind: 10, spirit: 10 });
  eq(baseAttributes('forean_hybrid', 50), { body: 59, mind: 157, spirit: 108 });
  eq(baseAttributes('brann_hybrid', 50), { body: 59, mind: 59, spirit: 206 });
  eq(baseAttributes('thrax_hybrid', 50), { body: 157, mind: 59, spirit: 108 });
});

// ---- client data ---------------------------------------------------------------------------

test('Client data shape', ({ eq, ok }) => {
  eq(GAME.clientVersion, '1.16.5.0');
  eq(MAX_LEVEL, 50);
  eq(Object.keys(GAME.skills).length, 73, 'skills');
  eq(Object.keys(GAME.classes).length, 15, 'classes');
  eq(Object.keys(GAME.races).length, 4, 'races');
  eq(Object.keys(GAME.abilities).length, 53, 'abilities');
  eq(GAME.xp.length, 50, 'xp rows');
  eq(GAME.xp[0], 0, 'xp L1');
  eq(GAME.xp[49], 103410000, 'xp L50');
  for (let i = 1; i < 50; i++) ok(GAME.xp[i] > GAME.xp[i - 1], `xp rises at L${i + 1}`);
  for (const r of Object.values(GAME.races)) ok(RACE_GROWTH[r.key], `growth for ${r.key}`);
});

test('Class tree: parents, children and tier levels agree', ({ eq, ok }) => {
  const tierLevel = { 1: 1, 2: 5, 3: 15, 4: 30 };
  for (const [id, c] of Object.entries(GAME.classes)) {
    eq(c.level, tierLevel[c.tier], `${c.name} level`);
    if (c.parent) ok(GAME.classes[c.parent].children.includes(Number(id)), `${c.name} listed by parent`);
    eq(c.children.length, c.tier === 4 ? 0 : 2, `${c.name} children`);
    eq(lineage(Number(id)).length, c.tier, `${c.name} lineage`);
  }
});

test('Every skill belongs to a class and unlocks at its level', ({ eq, ok }) => {
  for (const s of Object.values(GAME.skills)) {
    ok(GAME.classes[s.class], `${s.name} class`);
    eq(s.level, GAME.classes[s.class].level, `${s.name} level`);
    eq(s.maxRank, s.signature ? 1 : 5, `${s.name} max rank`);
  }
});

test('Signature skills are the server list, one per Tier IV class that has one', ({ eq }) => {
  const ids = Object.keys(GAME.skills).map(Number).filter(isSignatureSkill).sort((a, b) => a - b);
  eq(ids, [20, 47, 92, 110, 149, 154, 156, 157]);
  eq(ids.map(id => GAME.classes[GAME.skills[id].class].tier), Array(8).fill(4));
  eq(new Set(ids.map(id => GAME.skills[id].class)).size, 8);
});

test('Five starting skills, all Recruit', ({ eq }) => {
  const ids = Object.keys(GAME.skills).map(Number).filter(isStartingSkill);
  eq(ids.length, 5);
  eq(ids.every(id => GAME.skills[id].class === 1), true);
});

// ---- point accounting ----------------------------------------------------------------------

test('New character: 5 points used, 0 left', ({ eq }) => {
  eq(spentSkillPoints(build()), 5);
  eq(skillPointBudget(1) - spentSkillPoints(build()), 0);
  eq(validate(build(), 'human'), []);
});

test('Signature skills cost nothing and cannot change', ({ eq }) => {
  const engineer = classId('engineer');
  const baseWave = skillId('t4_engineer_sig_base_wave');
  const b = build({ level: 30, career: engineer });
  eq(spentSkillPoints(b), 5, 'granted signature costs 0');
  eq(rankOf(b, baseWave), 1, 'owned');
  eq(minRank(baseWave), 1);
  eq(skillCost(baseWave, 1), 0);
  eq(spentSkillPoints({ ...b, skills: { [baseWave]: 1 } }), 5, 'old save that trained it');
  eq(normalizeBuild({ ...b, skills: { [baseWave]: 1 } }).skills, {}, 'old save cleaned');
});

test('Point totals with real ranks', ({ eq }) => {
  const firearms = skillId('t1_recruit_firearms');
  const tools = skillId('t2_specialist_tools');
  const b = build({ level: 30, career: classId('specialist'), skills: { [firearms]: 5, [tools]: 3 } });
  eq(spentSkillPoints(b), 4 + 15 + 6);
  eq(spentSkillPoints(build({ skills: { [firearms]: 2 } })), 4 + 3);
});

test('Every path can spend exactly its budget and no further', ({ eq }) => {
  const firearms = skillId('t1_recruit_firearms');
  const hand = skillId('t1_recruit_hand_to_hand');
  const lightning = skillId('t1_recruit_lightning');
  // Level 12: budget 22 + 5 + 2 = 29.
  const b = build({ level: 12, skills: { [firearms]: 5, [hand]: 4, [lightning]: 1 } });
  eq(skillPointBudget(12), 29);
  eq(spentSkillPoints(b), 15 + 10 + 1 + 2);
  eq(validate(b, 'human'), [], 'under budget');
  const at = build({ level: 12, skills: { [firearms]: 5, [hand]: 4, [lightning]: 2 } });
  eq(spentSkillPoints(at), 30);
  eq(validate(at, 'human').map(i => i.text), ['1 training point(s) over budget.'], 'one over');
  const motor = skillId('t1_recruit_motor_assist_armor');
  const exact = build({ level: 12, skills: { [firearms]: 5, [hand]: 3, [motor]: 3 } });
  eq(skillPointBudget(12) - spentSkillPoints(exact), 0, 'exactly spent');
  eq(validate(exact, 'human'), [], 'exact budget is fine');
});

test('Attribute budget boundaries', ({ eq }) => {
  eq(validate(build({ level: 30, attributes: { body: 87, mind: 0, spirit: 0 } }), 'human'), []);
  eq(validate(build({ level: 30, attributes: { body: 87, mind: 1, spirit: 0 } }), 'human').map(i => i.text), ['1 attribute point(s) over budget.']);
  eq(spentAttributePoints(build({ attributes: { body: 3, mind: 4, spirit: 5 } })), 12);
});

test('Class level gating', ({ eq }) => {
  const guardian = classId('guardian');
  const texts = validate(build({ level: 10, career: guardian }), 'human').map(i => i.text);
  eq(texts, ['Commando needs level 15.', 'Guardian needs level 30.']);
  eq(validate(build({ level: 30, career: guardian }), 'human'), []);
  eq(validate(build({ level: 4, career: classId('soldier') }), 'human').map(i => i.text), ['Soldier needs level 5.']);
  eq(validate(build({ level: 5, career: classId('soldier') }), 'human'), []);
});

test('A class only trains its own path', ({ eq, ok }) => {
  const spy = classId('spy');
  const skills = availableSkills(spy);
  const classes = new Set(skills.map(id => GAME.skills[id].class));
  eq([...classes].sort((a, b) => a - b), lineage(spy).slice().sort((a, b) => a - b));
  ok(!skills.includes(skillId('t2_specialist_tools')), 'no Specialist skills');
  const texts = validate(build({ level: 30, career: spy, skills: { [skillId('t2_specialist_tools')]: 2 } }), 'human').map(i => i.text);
  ok(texts.some(t => t.includes('Specialist')), 'off-path skill reported');
});

// ---- damaged input -------------------------------------------------------------------------

test('normalizeBuild repairs bad builds', ({ eq }) => {
  const firearms = skillId('t1_recruit_firearms');
  const tools = skillId('t2_specialist_tools');
  const n = normalizeBuild({
    level: 99, career: 999,
    skills: { [firearms]: 9, [tools]: 3, 9999: 2 },
    attributes: { body: -5, mind: 2.5, spirit: 'x' },
  });
  eq(n.level, 50);
  eq(n.career, 1);
  eq(n.skills, { [firearms]: 5 }, 'clamped; off-path and unknown dropped');
  eq(n.attributes, { body: 0, mind: 0, spirit: 0 });
  eq(normalizeBuild({ level: 0 }).level, 1);
  eq(normalizeBuild({ level: '30' }).level, 1);
  eq(normalizeBuild({ skills: { [firearms]: -2 } }).skills, {});
  eq(normalizeBuild({ skills: null, attributes: null }).skills, {});
  eq(normalizeRace('martian'), 'human');
  eq(normalizeRace('thrax_hybrid'), 'thrax_hybrid');
});

test('Random builds never break the rules code', ({ ok }) => {
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const ids = Object.keys(GAME.skills);
  const classIds = Object.keys(GAME.classes).map(Number);
  const races = Object.keys(RACE_GROWTH);
  for (let i = 0; i < 3000; i++) {
    const skills = {};
    for (let k = rnd(12); k > 0; k--) skills[ids[rnd(ids.length)]] = rnd(9) - 2;
    const b = normalizeBuild({
      level: rnd(70) - 10, career: classIds[rnd(classIds.length)], skills,
      attributes: { body: rnd(300) - 50, mind: rnd(300) - 50, spirit: rnd(300) - 50 },
    });
    const race = races[rnd(races.length)];
    const d = derivedStats(race, b.level, b.attributes);
    ok(Object.values(d).every(Number.isFinite), `finite stats: ${JSON.stringify(b)}`);
    ok(d.health >= 1 && d.power >= 100 && d.regen >= 0, `sane stats: ${JSON.stringify(b)}`);
    const expected = Object.keys(GAME.skills).reduce((sum, id) => {
      const s = GAME.skills[id];
      if (s.signature) return sum;
      const start = id in b.skills ? b.skills[id] : isStartingSkill(Number(id)) ? 1 : 0;
      return sum + (start * (start + 1)) / 2;
    }, 0);
    ok(spentSkillPoints(b) === expected, `spent: ${JSON.stringify(b)}`);
    validate(b, race);
    ok(Object.keys(b.skills).every(id => availableSkills(b.career).includes(Number(id))), 'skills on path');
  }
});

test('Share codes round-trip, including non-English names', ({ eq, ok }) => {
  const character = { name: 'Kæl “Ωmega”', race: 'brann_hybrid' };
  const b = { name: 'Bûild ☢', level: 30, career: 13, skills: { 1: 5 }, attributes: { body: 1, mind: 2, spirit: 3 }, notes: 'multi\nline' };
  const out = decodeShare(encodeShare(character, b));
  eq(out.character, character.name);
  eq(out.race, character.race);
  eq(out.build, b);
  for (const bad of ['', 'not a code!', 'e30', btoa('{"v":1}')]) {
    let threw = false;
    try { decodeShare(bad); } catch { threw = true; }
    ok(threw, `rejects ${JSON.stringify(bad)}`);
  }
});

// ---- ability tooltips ----------------------------------------------------------------------

test('Lightning at client-derived reference points', ({ ok }) => {
  const text = (pump, level) => abilityText(194, pump, GAME.abilities[194].pumps[pump].desc, level);
  ok(text(1, 1).includes('Base Damage: 180 - 240'), 'P1 L1');
  ok(text(1, 15).includes('605 - 807'), 'P1 L15');
  ok(text(1, 30).includes('2220 - 2961'), 'P1 L30');
  ok(text(1, 50).includes('12562 - 16750'), 'P1 L50');
  ok(text(5, 30).includes('2961 - 3701'), 'P5 L30');
  ok(text(5, 30).includes('Arc Base Damage: 2590'), 'P5 arc');
  ok(text(5, 30).includes('740 - 1110'), 'P5 storm');
  ok(text(5, 50).includes('Power: 150'), 'P5 power is not scaled');
});

test('No ability tooltip keeps an unfilled token at any level', ({ ok }) => {
  for (const [id, s] of Object.entries(GAME.skills)) {
    for (const a of s.abilities) {
      for (let r = 1; r <= s.maxRank; r++) {
        const pump = GAME.abilities[a].pumps[r];
        ok(pump, `${s.name} has rank ${r}`);
        for (const level of [1, s.level, 25, 50]) {
          const t = abilityText(a, r, pump.desc, level);
          // "Target: None (Self)" is real client text; a None after a number label is not.
          ok(!/\$|NaN|undefined|(Power|Adrenaline|Activation|Cooldown|Range|Damage): None/.test(t), `${s.name} r${r} L${level}: ${t.slice(0, 80)}`);
        }
      }
    }
    if (!s.abilities.length) s.ranks.forEach((r, i) => ok(r?.name && r?.desc, `${s.name} rank ${i + 1} text`));
    ok(id, 'id');
  }
});

// ---- full table ----------------------------------------------------------------------------

const rows = await (await fetch('expected_stats.json')).json();
test(`Independent float32 reference (${rows.length} rows)`, ({ eq, ok }) => {
  ok(rows.length > 1000, 'reference loaded');
  for (const r of rows) {
    const [body, mind, spirit] = r.spent;
    const d = derivedStats(r.race, r.level, { body, mind, spirit });
    eq([d.body, d.mind, d.spirit, d.health, d.power, d.regen, d.regenPerSecond],
      [r.body, r.mind, r.spirit, r.health, r.power, r.regen, r.regenPerSecond], `${r.race} L${r.level} ${r.spent}`);
    for (const key of ['armorBonus', 'logosBonus', 'critChance']) ok(Math.abs(d[key] - r[key]) < 1e-9, `${key} ${r.race} L${r.level} ${r.spent}: ${d[key]} vs ${r[key]}`);
  }
});

// ---- output of the real server code --------------------------------------------------------
// tests/server_stats.json is written by the real C# code: tools/PlannerDumpTests.cs run inside
// Rasa.Test at server commit 6394cc3.

const server = await (await fetch('server_stats.json')).json();
test(`Real server output: stats and points (${server.rows.length} rows)`, ({ eq, ok }) => {
  ok(server.rows.length > 1000, 'server output loaded');
  for (const r of server.rows) {
    const [body, mind, spirit] = r.spent;
    const b = build({ level: r.level, attributes: { body, mind, spirit } });
    const d = derivedStats(r.race, r.level, b.attributes);
    const label = `${r.race} L${r.level} ${r.spent}`;
    eq([d.body, d.mind, d.spirit, d.health, d.power, d.regen, d.regenPerSecond],
      [r.body, r.mind, r.spirit, r.health, r.power, r.regen, r.regenPerSecond], label);
    ok(Math.abs(d.critChance - r.critChance) < 1e-9, `crit ${label}: ${d.critChance} vs ${r.critChance}`);
    eq(skillPointBudget(r.level), r.trainingLeft, `training ${label}`);
    eq(attributePointBudget(r.level) - spentAttributePoints(b), r.attrLeft, `attributes ${label}`);
  }
});

test(`Real server output: ability scaling (${server.scales.length} rows)`, ({ eq }) => {
  for (const s of server.scales) {
    eq(resolveTokens({ a: { scale: 2, base: s.baseAmount } }, s.level).a, String(s.type2), `type 2 base ${s.baseAmount} L${s.level}`);
    eq(resolveTokens({ a: { scale: 1, base: s.baseAmount } }, s.level).a, String(s.type1), `type 1 base ${s.baseAmount} L${s.level}`);
  }
});

// ---- reading rules from server source ------------------------------------------------------
// These fetch real files from GitHub at fixed commits, so they need a network connection.

const PINNED = '6394cc38f533cc2caa819fabfe272404c965202e';
const SERVER_RAW = `https://raw.githubusercontent.com/InfiniteRasa/Rasa.NET/${PINNED}/src/Rasa.Game/Managers`;
let source = null;
try {
  const get = async f => (await fetch(`${SERVER_RAW}/${f}`)).text();
  source = {
    manifestation: await get('ManifestationManager.cs'), critical: await get('CriticalHits.cs'),
    ability: await get('AbilityManager.cs'), effects: await get('GameEffectManager.cs'),
  };
} catch { /* reported by the tests below */ }

test('Reading the pinned server source gives exactly the built-in rules', ({ eq, ok }) => {
  ok(source, 'server source fetched');
  const out = parseServerSource(source);
  eq(out.missed, [], 'everything read');
  eq(out.changed, [], 'nothing differs');
  eq(out.read.length, 11, 'all eleven groups');
  eq(out.values.logosApplied, false, 'Logos is not applied at this commit');
  for (const key of Object.keys(DEFAULT_RULES)) eq(out.values[key], DEFAULT_RULES[key], key);
});

test('Changed server numbers flow through to the planner', ({ eq }) => {
  const edited = source.manifestation
    .replace('player.SpentMind * 3;', 'player.SpentMind * 5;')
    .replace('var points = 3 * (player.Level - 1);', 'var points = 4 * (player.Level - 1);')
    .replace(/if \(level >= 50\)(\s*)pointsAvailable \+= 4;/, 'if (level >= 50)$1pointsAvailable += 9;');
  const out = parseServerSource({ ...source, manifestation: edited, critical: source.critical.replace('SpiritDivisor = 15.0', 'SpiritDivisor = 10.0') });
  eq(out.changed.sort(), ['Attribute points per level', 'Crit chance', 'Power', 'Training points per level']);
  try {
    applyRules(out.values);
    eq(derivedStats('human', 30, { mind: 10 }).power, 100 + 232 + 50, 'power');
    eq(attributePointBudget(30), 116, 'attribute points');
    eq(skillPointBudget(50), 118, 'training points');
    eq(derivedStats('human', 30, { spirit: 20 }).critChance, 7, 'crit');
  } finally {
    applyRules();
  }
  eq(derivedStats('human', 30, {}).power, 332, 'back to built-in');
});

test('A changed formula shape is refused, not misread', ({ eq, ok }) => {
  const reshaped = source.manifestation
    .replace('levelBasedHealth * (totalSpirit + 2 * totalBody)', 'levelBasedHealth * (totalSpirit + 3 * totalBody)')
    .replace('baseRegen * (totalMind + 2 * totalSpirit)', 'baseRegen * (2 * totalMind + totalSpirit)')
    .replace('player.SpentMind * 3;', 'player.SpentMind * 3 + player.SpentBody;');
  const out = parseServerSource({ ...source, manifestation: reshaped });
  eq(out.missed.sort(), ['Health table and formula', 'Power', 'Regeneration']);
  ok(!('healthTable' in out.values) && !('powerBase' in out.values), 'unread values not supplied');
});

test('Logos math is picked up when the server adds it', ({ eq, ok }) => {
  const logos = changes => parseServerSource({ ...source, ...changes });
  const near = (a, b, label) => ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);

  // 1. The existing variable starts being used: its 0.375 applies.
  let out = logos({ ability: `${source.ability}\nvar amount = rolled * (100 + logosBonusPercent) / 100;` });
  eq(out.values.logosApplied, true, 'variable used');
  eq(out.values.logosPerPoint, 0.375, 'its rate');
  ok(out.changed.includes('Logos damage'), 'reported as changed');

  // 2. A divisor constant appears, as in the client.
  out = logos({ critical: `${source.critical}\npublic const double MindDamageDivisor = 4.0;` });
  eq(out.values.logosApplied, true, 'divisor declared');
  eq(out.values.logosPerPoint, 0.25, 'one over the divisor');

  // 3. Mind reaches the damage code with no readable rate: the retail rate stays.
  out = logos({ effects: `${source.effects}\nvar bonus = source.Attributes[Attributes.Mind].Current;` });
  eq(out.values.logosApplied, true, 'Mind in damage code');
  near(out.values.logosPerPoint, 1 / 3, 'retail rate kept');

  // A comment does not count.
  out = logos({ effects: `${source.effects}\n    // Attributes.Mind should raise this one day` });
  eq(out.values.logosApplied, false, 'comment ignored');

  // The stat follows the rate.
  try {
    applyRules({ logosApplied: true, logosPerPoint: 0.375 });
    near(derivedStats('human', 30, { mind: 40 }).logosBonus, 15, 'planner uses the server rate');
  } finally {
    applyRules();
  }
  near(derivedStats('human', 30, { mind: 30 }).logosBonus, 10, 'back to the retail rate');
});

test('Unrelated or hostile text yields nothing usable', ({ eq, ok }) => {
  for (const manifestation of ['', '<html>404</html>', 'requiredSkillLevelPoints = { alert(1) }; HealthBaselinePerLevel = { 1f, 2f }']) {
    const out = parseServerSource({ manifestation, critical: '' });
    eq(out.read, [], `nothing read from ${JSON.stringify(manifestation.slice(0, 20))}`);
    eq(out.values, {}, 'no values');
  }
  const silly = parseServerSource({ manifestation: 'var points = 999999 * (player.Level - 1);', critical: '' });
  ok(!('attrPerLevel' in silly.values), 'out-of-range number refused');
});

test('Repository and branch input', ({ eq, ok }) => {
  eq(parseRepoInput('InfiniteRasa/Rasa.NET'), { repo: 'InfiniteRasa/Rasa.NET' });
  eq(parseRepoInput(' https://github.com/Ar0xA/Rasa.NET.git/ '), { repo: 'Ar0xA/Rasa.NET' });
  eq(parseRepoInput('https://github.com/InfiniteRasa/Rasa.NET/tree/feature/x'), { repo: 'InfiniteRasa/Rasa.NET', ref: 'feature/x' });
  for (const bad of ['', 'justone', 'https://evil.example/a/b', '../../etc/passwd', 'a/b/c', 'a b/c']) eq(parseRepoInput(bad), null, bad);
  for (const good of ['development', 'master', 'feature/x', 'v1.2', PINNED]) ok(isValidRef(good), good);
  for (const bad of ['', '../x', 'a b', '/x', 'x/', 'a?b=c', 'a#b']) ok(!isValidRef(bad), bad);
  ok(isCommitHash('6394cc3') && isCommitHash(PINNED) && !isCommitHash('development'), 'commit detection');
});

// Saved copies use a test key and are removed afterwards.
const testSource = { repo: 'irplanner/test-copy', ref: 'test' };
await saveCopy(testSource, source, 'abc1234');
const savedRaw = await loadCopy(testSource);
const savedRead = await readSavedCopy(testSource);
const noCopy = await readSavedCopy({ repo: 'irplanner/none', ref: 'none' });
const savedList = await listCopies();
await new Promise(resolve => {
  const open = indexedDB.open('irplanner-sources', 1);
  open.onsuccess = () => {
    const tx = open.result.transaction('copies', 'readwrite');
    tx.objectStore('copies').delete(`${testSource.repo}@${testSource.ref}`);
    tx.oncomplete = () => { open.result.close(); resolve(); };
  };
});

test('Saved server files give the same rules with no network', ({ eq, ok }) => {
  ok(savedRaw?.files?.manifestation?.length > 100000, 'whole file kept');
  ok(savedRead?.saved, 'marked as a saved copy');
  eq(savedRead.commit, 'abc1234');
  eq(savedRead.values, parseServerSource(source).values, 'same numbers as the live read');
  eq(noCopy, null, 'no copy, no result');
  ok(savedList.some(c => c.source.repo === testSource.repo), 'listed');
});

test('The built-in table survives damaged values', ({ eq, ok }) => {
  const junk = [
    { healthTable: [1, 2, 3] }, { healthTable: Array(50).fill('x') }, { rankCosts: null }, { rankCosts: [0, 1] },
    { raceGrowth: { human: { body: 2 } } }, { skillBonuses: 'lots' }, { skillBonuses: [[5]] }, { signatureSkills: {} },
    { powerBase: 'NaN' }, { powerPerMind: null }, { attrPerLevel: Infinity }, { critDivisor: 0 }, { logosApplied: 'yes' },
    { somethingElse: 5 }, { __proto__: { powerBase: 9 } },
  ];
  try {
    for (const values of junk) {
      applyRules(values);
      for (const key of Object.keys(DEFAULT_RULES)) eq(RULES[key], DEFAULT_RULES[key], `${JSON.stringify(values).slice(0, 40)} -> ${key}`);
      ok(!('somethingElse' in RULES), 'unknown keys ignored');
      const d = derivedStats('human', 30, { body: 5, mind: 5, spirit: 5 });
      ok(Object.values(d).every(Number.isFinite), 'stats stay numbers');
    }
    applyRules(null);
    eq(RULES.powerBase, 100, 'null is fine');
    applyRules({ powerPerMind: 7, healthTable: [1] });
    eq([RULES.powerPerMind, RULES.healthTable.length], [7, 50], 'good values kept, bad ones replaced');
  } finally {
    applyRules();
  }
});

// The whole chain, with GitHub faked. The cached read and saved copy are put back afterwards.
const CACHE_KEY = 'irplanner.server.cache';
const chain = {};
{
  const cachedBefore = localStorage.getItem(CACHE_KEY);
  const realFetch = window.fetch;
  const fake = { repo: 'irplanner/test-chain', ref: 'test' };
  const respond = files => url => {
    if (url.includes('api.github.com')) return Promise.resolve(new Response('{}', { status: 403 }));
    const name = Object.keys(files).find(f => url.endsWith(f));
    return Promise.resolve(new Response(files[name] ?? '', { status: name ? 200 : 404 }));
  };
  const files = changes => ({
    'ManifestationManager.cs': source.manifestation, 'CriticalHits.cs': source.critical,
    'AbilityManager.cs': source.ability, 'GameEffectManager.cs': source.effects, ...changes,
  });
  try {
    Object.assign(serverRules, { source: fake, result: null, error: null });

    // A good read with a changed Power rate.
    window.fetch = respond(files({ 'ManifestationManager.cs': source.manifestation.replace('player.SpentMind * 3;', 'player.SpentMind * 7;') }));
    await refreshServerRules();
    chain.fresh = RULES.powerPerMind;

    // A later read where Power can't be read: the last good 7 stays, not the built-in 3.
    window.fetch = respond(files({ 'ManifestationManager.cs': source.manifestation.replace('player.SpentMind * 3;', 'player.SpentMind * 3 + player.SpentBody;') }));
    await refreshServerRules();
    chain.partial = { rate: RULES.powerPerMind, missed: serverRules.result.missed };

    // No connection: the saved files are used, and the last good 7 still stands.
    window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    await refreshServerRules();
    chain.offline = { saved: serverRules.result.saved, rate: RULES.powerPerMind, error: !!serverRules.error, full: Object.keys(DEFAULT_RULES).every(k => RULES[k] !== undefined) };

    // No connection and nothing saved for this source: the built-in table.
    Object.assign(serverRules, { source: { repo: 'irplanner/never-seen', ref: 'test' }, result: null, error: null });
    applyRules();
    await refreshServerRules();
    chain.nothing = { result: serverRules.result, rate: RULES.powerPerMind, table: RULES.healthTable.length, power: derivedStats('human', 30, {}).power };
  } finally {
    window.fetch = realFetch;
    Object.assign(serverRules, { source: null, result: null, error: null });
    applyRules();
    if (cachedBefore === null) localStorage.removeItem(CACHE_KEY); else localStorage.setItem(CACHE_KEY, cachedBefore);
    await new Promise(resolve => {
      const open = indexedDB.open('irplanner-sources', 1);
      open.onsuccess = () => {
        const tx = open.result.transaction('copies', 'readwrite');
        tx.objectStore('copies').delete(`${fake.repo}@${fake.ref}`);
        tx.oncomplete = () => { open.result.close(); resolve(); };
      };
    });
  }
}

test('Fallback chain: fresh, last good, saved copy, built-in table', ({ eq, ok }) => {
  eq(chain.fresh, 7, 'fresh read used');
  eq(chain.partial?.rate, 7, 'unreadable value keeps the last good one');
  ok(chain.partial?.missed.includes('Power'), 'and is reported');
  eq(chain.offline?.saved, true, 'offline uses the saved copy');
  eq(chain.offline?.rate, 7, 'offline keeps the last good value');
  eq(chain.offline?.full, true, 'offline rules are complete');
  ok(chain.offline?.error, 'and says it is offline');
  eq(chain.nothing, { result: null, rate: 3, table: 50, power: 332 }, 'nothing saved: the built-in table, fully working');
});

test('Signature list follows the rules in force', ({ eq }) => {
  const wave = skillId('t4_engineer_sig_base_wave');
  try {
    applyRules({ signatureSkills: [] });
    eq(isSignatureSkill(wave), false);
    eq(skillCost(wave, 1), 1, 'costs a point when not granted');
    eq(minRank(wave), 0);
  } finally {
    applyRules();
  }
  eq(isSignatureSkill(wave), true);
});

// ---- report --------------------------------------------------------------------------------

const list = document.getElementById('results');
let failed = 0;
for (const { name, failures } of results) {
  if (failures.length) failed++;
  const li = document.createElement('li');
  li.className = failures.length ? 'fail' : 'pass';
  li.textContent = `${failures.length ? 'FAIL' : 'ok  '} ${name}`;
  if (failures.length) {
    const ul = document.createElement('ul');
    for (const f of failures.slice(0, 8)) ul.append(Object.assign(document.createElement('li'), { textContent: f }));
    if (failures.length > 8) ul.append(Object.assign(document.createElement('li'), { textContent: `…and ${failures.length - 8} more` }));
    li.append(ul);
  }
  list.append(li);
}
const summary = document.getElementById('summary');
summary.textContent = `${results.length - failed} of ${results.length} tests passed`;
summary.className = failed ? 'fail' : 'pass';
window.testResults = results;
