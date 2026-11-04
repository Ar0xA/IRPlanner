import { GAME } from './data/gamedata.js';
import { store, encodeShare, decodeShare } from './storage.js';
import {
  MAX_LEVEL, rankCost, skillPointBudget, attributePointBudget, baseAttributes, derivedStats,
  lineage, availableSkills, rankOf, minRank, skillCost, spentSkillPoints, spentAttributePoints, validate,
  displayName, skillKind, isSignatureSkill, RULES,
} from './rules.js';
import {
  DEFAULT_SOURCE, serverRules, initServerRules, refreshServerRules, useSource, describeRules,
  parseRepoInput, isValidRef, shortCommit,
} from './serverrules.js';
import { listCopies } from './sourcestore.js';
import { abilityText } from './abilitytext.js';

const $ = sel => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
};

const ATTRS = [
  { key: 'body', name: 'Body', hint: 'Health, armor' },
  { key: 'mind', name: 'Mind', hint: 'Power, Logos damage' },
  { key: 'spirit', name: 'Spirit', hint: 'Regeneration, crits' },
];
const ROMAN = ['', 'I', 'II', 'III', 'IV'];

// Icons extracted from the client (see tools/extract_icons.py). All paths stay relative so the
// site works under a sub-path on GitHub Pages.
const classIcon = id => `img/classes/${id}.webp`;
const skillIcon = (id, rank) => rank > 0 ? `img/skills/ranks/${id}_${rank}.webp` : `img/skills/${id}.webp`;
const icon = (src, size, cls) => el('img', { src, width: size, height: size, alt: '', loading: 'lazy', decoding: 'async', class: cls });

// Session-only UI state (not persisted): the viewed skill rank, which collapsibles are closed,
// and whether the phone layout shows the full career tree.
let selected = null; // { skillId, rank }
const collapsed = new Set(); // 'tier:<classId>' | 'attrs'
let careerTreeOpen = false;
const phoneMq = matchMedia('(max-width: 719px)');
const isPhone = () => phoneMq.matches;

// ---- state helpers --------------------------------------------------------------------------

function ensureCharacter() {
  if (!store.activeCharacter()) {
    const first = store.characters()[0];
    if (first) store.selectCharacter(first.id);
    else store.createCharacter('My character');
  }
}

function current() {
  const character = store.activeCharacter();
  const build = store.activeBuild();
  return { character, build };
}

function editBuild(mutate) {
  const { build } = current();
  const copy = structuredClone(build);
  mutate(copy);
  store.updateBuild(copy);
}

function clampLevel(n) {
  return Math.min(MAX_LEVEL, Math.max(1, Math.round(Number(n) || 1)));
}

function setRank(build, skillId, rank) {
  const min = minRank(skillId);
  const r = Math.max(min, Math.min(GAME.skills[skillId].maxRank, rank));
  if (r === min) delete build.skills[skillId];
  else build.skills[skillId] = r;
}

// Attribute points: delta from the +/- buttons, or a typed total; both clamp to the budget.
function adjustAttribute(key, delta) {
  editBuild(b => {
    const spent = b.attributes[key] || 0;
    const room = attributePointBudget(b.level) - spentAttributePoints(b);
    b.attributes[key] = Math.max(0, spent + Math.min(delta, Math.max(0, room)));
  });
}

function setAttributeTotal(key, total) {
  const { character, build } = current();
  const base = baseAttributes(character.race, build.level)[key];
  if (total === '' || !Number.isFinite(Number(total))) { render(); return; }
  total = Number(total);
  adjustAttribute(key, Math.round(total) - base - (build.attributes[key] || 0));
}

// Press-and-hold on a +/- button repeats it. Rendering replaces the button mid-hold, so the
// repeat is stopped by a document-level pointerup, and the click that would follow is skipped.
let holdTimer = null;
let holding = false;
function startHold(e, step) {
  if (e.button !== 0) return;
  stopHold();
  holdTimer = setTimeout(function repeat() {
    holding = true;
    step();
    holdTimer = setTimeout(repeat, 70);
  }, 400);
}
function stopHold() {
  clearTimeout(holdTimer);
  holdTimer = null;
  setTimeout(() => { holding = false; }, 0); // after the click event of this release
}
for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, stopHold);

// Choosing a class keeps skills of classes still on the path and drops the rest.
function setCareer(build, classId) {
  build.career = classId;
  const allowed = new Set(availableSkills(classId));
  for (const id of Object.keys(build.skills)) if (!allowed.has(Number(id))) delete build.skills[id];
}

// Skills in the order the skill panels show them: class by class down the path.
function visibleSkills(build) {
  return lineage(build.career).flatMap(classId =>
    Object.keys(GAME.skills).map(Number).filter(id => GAME.skills[id].class === classId));
}

function raceName(raceKey) {
  const id = Object.keys(GAME.races).find(k => GAME.races[k].key === raceKey);
  return GAME.races[id]?.name ?? raceKey;
}

// ---- rendering -----------------------------------------------------------------------------

function render() {
  // Rendering replaces the controls; put keyboard focus back on the same one afterwards.
  const focusKey = document.activeElement?.dataset?.focusKey;
  ensureCharacter();
  const { character, build } = current();
  $('#storage-warning').hidden = store.isPersistent();
  renderCharacterSelect(character);
  renderBuildTabs(character, build);
  renderSheet(character, build);
  renderBudgetBar(build);
  renderSkills(build);
  renderDetail(build, character);
  $('#data-source').textContent = `Game data from client ${GAME.clientVersion}. ${describeRules()}`;
  if (focusKey) {
    const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
}

function renderCharacterSelect(character) {
  const sel = $('#character-select');
  sel.replaceChildren(...store.characters().map(c =>
    el('option', { value: c.id, selected: c.id === character.id }, `${c.name} · ${raceName(c.race)}`)));
  $('#char-del').disabled = store.characters().length <= 1;
}

function renderBuildTabs(character, build) {
  $('#build-tabs').replaceChildren(...character.builds.map(b => el('button', {
    type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(b.id === build.id), 'data-focus-key': `tab:${b.id}`,
    'aria-label': `${b.name}, level ${b.level} ${GAME.classes[b.career]?.name ?? ''}`,
    onclick: () => { store.selectBuild(b.id); selected = null; },
  }, el('span', { class: 'tab-name' }, b.name),
     el('span', { class: 'tab-meta' }, `L${b.level} ${GAME.classes[b.career]?.name ?? ''}`))));
  $('#build-del').disabled = character.builds.length <= 1;
}

function syncInput(input, value) {
  if (document.activeElement !== input && input.value !== String(value)) input.value = value;
}

function renderSheet(character, build) {
  syncInput($('#char-name'), character.name);
  syncInput($('#build-name'), build.name);
  syncInput($('#build-notes'), build.notes || '');

  const raceSel = $('#race-select');
  if (!raceSel.options.length) {
    raceSel.append(...Object.entries(GAME.races)
      .sort((a, b) => a[0] - b[0])
      .map(([, r]) => el('option', { value: r.key }, r.name)));
  }
  raceSel.value = character.race;

  syncInput($('#level-input'), build.level);
  $('#level-range').value = build.level;
  $('#level-down').disabled = build.level <= 1;
  $('#level-up').disabled = build.level >= MAX_LEVEL;
  $('#build-sum-level').textContent = `Level ${build.level} · ${raceName(character.race)}`;
  $('#build-sum-class').textContent = GAME.classes[build.career]?.name ?? '';

  renderCareer(build);

  const skillTotal = skillPointBudget(build.level);
  const skillSpent = spentSkillPoints(build);
  const attrTotal = attributePointBudget(build.level);
  const attrSpent = spentAttributePoints(build);
  // Budget readout: label, what is left, used of total, and a fill bar. Over budget flips it red.
  const budget = (label, spent, total) => {
    const over = spent > total;
    const pct = total > 0 ? Math.min(100, (spent / total) * 100) : (spent > 0 ? 100 : 0);
    return el('div', { class: `stat budget${over ? ' over' : ''}`, role: 'group', 'aria-label': label },
      el('span', { class: 'stat-label' }, label),
      el('span', { class: 'stat-value' }, el('b', {}, String(Math.abs(total - spent))), el('small', {}, over ? 'over' : 'left')),
      el('span', { class: 'stat-sub' }, `${spent} used of ${total}`),
      el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: `width:${pct}%` })));
  };
  $('#points').replaceChildren(
    budget('Training points', skillSpent, skillTotal),
    budget('Attribute points', attrSpent, attrTotal));
  $('#xp-line').textContent = `Experience for level ${build.level}: ${GAME.xp[build.level - 1].toLocaleString()}`;

  // Attributes: −10 / − / typed total / + / +10 per attribute; shift-click or hold ± to go faster.
  const base = baseAttributes(character.race, build.level);
  const room = Math.max(0, attrTotal - attrSpent);
  $('#attributes').replaceChildren(...ATTRS.map(a => {
    const spent = build.attributes[a.key] || 0;
    const step = (delta, label, key, hold) => el('button', {
      type: 'button', class: `step${Math.abs(delta) > 1 ? ' big' : ''}`, 'data-focus-key': `attr${key}:${a.key}`,
      'aria-label': `${delta < 0 ? 'Remove' : 'Add'} ${Math.abs(delta)} ${a.name} point${Math.abs(delta) > 1 ? 's' : ''}`,
      title: hold ? 'Shift-click or hold to step faster' : null,
      disabled: delta < 0 ? spent <= 0 : room <= 0,
      onclick: e => { if (!holding) adjustAttribute(a.key, e.shiftKey && Math.abs(delta) === 1 ? delta * 10 : delta); },
      onpointerdown: hold ? e => startHold(e, () => adjustAttribute(a.key, delta)) : null,
    }, label);
    return el('div', { class: 'attr', 'data-attr': a.key },
      el('div', { class: 'name' }, a.name, el('small', {}, `${base[a.key]} base + ${spent} · ${a.hint}`)),
      el('div', { class: 'attr-ctl' },
        step(-10, '−10', '-10'),
        step(-1, '−', '-', true),
        el('input', {
          type: 'number', class: `value${spent > 0 ? ' boosted' : ''}`, inputmode: 'numeric',
          min: base[a.key], max: base[a.key] + spent + room, value: base[a.key] + spent,
          'aria-label': `${a.name} total`, 'data-focus-key': `attrv:${a.key}`,
          onchange: e => setAttributeTotal(a.key, e.target.value),
        }),
        step(1, '+', '+', true),
        step(10, '+10', '+10')));
  }));
  $('#attr-hint').hidden = attrTotal === 0;
  const d = derivedStats(character.race, build.level, build.attributes);
  $('#attrs-summary').textContent = `Body ${d.body} · Mind ${d.mind} · Spirit ${d.spirit}`;
  // Attributes collapse only on the phone layout; wider layouts always show them.
  $('#attrs-sec').open = !isPhone() || !collapsed.has('attrs');

  const fmt = n => (Math.round(n * 100) / 100).toLocaleString();
  const stat = (label, value, unit, title) => el('div', { class: 'stat', title },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, el('b', {}, String(value)), unit ? el('small', {}, unit) : null));
  $('#derived').replaceChildren(
    stat('Health', d.health.toLocaleString()),
    stat('Power', d.power.toLocaleString()),
    stat('Regen', `${d.regen}%`, ` ${d.regenPerSecond}/s`),
    stat('Armor', `+${fmt(d.armorBonus)}`, '%', 'Bonus to the armor you wear, from all your Body'),
    stat('Logos dmg', `+${fmt(d.logosBonus)}`, '%', RULES.logosApplied ? 'Logos damage bonus, applied by this server' : 'Retail rate from the client. This server does not apply it yet.'),
    stat('Crit', fmt(d.critChance), '%', 'Crit chance: 5% base plus Spirit above your level\'s base'));

  const issues = validate(build, character.race);
  $('#issues').replaceChildren(...issues.map(i => el('li', { class: i.level }, i.text)));
}

// Career: a top-down emblem tree (1 → 2 → 4 → 8 classes) on an 8-column grid, so every class sits
// centred above its descendants; connector bands between the rows highlight the chosen branch.
// The phone layout shows a strip of the four path emblems instead and reveals the tree on demand.
function renderCareer(build) {
  const path = lineage(build.career);
  const onPath = new Set(path);
  const nodes = [];
  let leaf = 0;
  const place = id => {
    const c = GAME.classes[id];
    const kids = (c.children || []).filter(k => GAME.classes[k]);
    let start, span;
    if (!kids.length) { start = ++leaf; span = 1; } else {
      const placed = kids.map(place);
      start = placed[0].start;
      span = placed.reduce((n, p) => n + p.span, 0);
    }
    nodes.push({ id, c, start, span, kids, side: onPath.has(kids[0]) ? 'left' : onPath.has(kids[1]) ? 'right' : null });
    return { start, span };
  };
  Object.keys(GAME.classes).map(Number).filter(id => !GAME.classes[id].parent).forEach(place);
  nodes.sort((a, b) => a.c.tier - b.c.tier || a.start - b.start);

  const tree = $('#career-tree');
  tree.style.setProperty('--leaves', leaf);
  tree.replaceChildren(
    ...nodes.filter(n => n.kids.length).map(({ id, c, start, span, side }) => el('span', {
      class: 'branch', 'aria-hidden': 'true',
      style: `grid-column:${start} / span ${span};grid-row:${c.tier * 2}`,
      'data-on': onPath.has(id) ? 'true' : null, 'data-side': side,
    })),
    ...nodes.map(({ id, c, start, span }) => {
      const parentOk = !c.parent || onPath.has(c.parent) || onPath.has(id);
      const locked = build.level < c.level;
      const active = id === build.career;
      return el('button', {
        type: 'button', class: 'plain career-btn', 'aria-pressed': String(onPath.has(id)), 'data-focus-key': `class:${id}`,
        style: `grid-column:${start} / span ${span};grid-row:${c.tier * 2 - 1}`,
        title: locked ? `${c.name} · requires level ${c.level}`
          : active && c.parent ? `${c.name} · active class, click to go back to ${GAME.classes[c.parent].name}`
          : c.parent ? `${c.name} · from ${GAME.classes[c.parent].name}` : c.name,
        'aria-label': `${c.name}, tier ${c.tier}, level ${c.level}${c.parent ? `, from ${GAME.classes[c.parent].name}` : ''}${locked ? ', locked' : ''}${active ? ', active class' : ''}`,
        disabled: locked,
        'data-tier': c.tier,
        'data-offpath': parentOk ? null : 'true',
        'data-active': active ? 'true' : null,
        onclick: () => editBuild(b => setCareer(b, onPath.has(id) && id === b.career && c.parent ? c.parent : id)),
      },
      icon(classIcon(id), 64, 'emblem'),
      locked ? el('span', { class: 'node-req', 'aria-hidden': 'true' }, `L${c.level}`) : null);
    }));

  $('#career-path').replaceChildren(...path.flatMap((id, i) => [
    ...(i ? [el('span', { class: 'sep', 'aria-hidden': 'true' }, '›')] : []),
    el('span', { class: i === path.length - 1 ? 'active' : null }, GAME.classes[id].name),
  ]));

  // Phone strip: one slot per tier; empty tiers show the level they unlock at.
  const tierLevel = [, 1, 5, 15, 30];
  $('#career-strip').replaceChildren(...[1, 2, 3, 4].map(tier => {
    const id = path[tier - 1];
    const c = id ? GAME.classes[id] : null;
    return el('button', {
      type: 'button', class: `plain strip-node${c ? '' : ' empty'}`, 'data-active': id === build.career ? 'true' : null,
      'data-focus-key': `strip:${tier}`,
      'aria-label': c ? `${c.name}, tier ${tier}. Change class path` : `Tier ${tier} not chosen, unlocks at level ${tierLevel[tier]}. Change class path`,
      onclick: () => { careerTreeOpen = true; render(); $('#career-tree')?.querySelector('.career-btn[data-active="true"]')?.focus({ preventScroll: true }); },
    },
    c ? icon(classIcon(id), 64, 'emblem') : el('span', { class: 'emblem slot', 'aria-hidden': 'true' }, `L${tierLevel[tier]}`),
    el('span', { class: 'strip-name' }, c ? c.name : `Tier ${ROMAN[tier]}`));
  }));
  const toggle = $('#career-toggle');
  toggle.setAttribute('aria-expanded', String(careerTreeOpen));
  toggle.textContent = careerTreeOpen ? 'Hide class tree' : 'Change class path';
  tree.dataset.open = String(careerTreeOpen);
}

// Sticky readout above the skills, so the budget stays in view while pumping ranks.
function renderBudgetBar(build) {
  const item = (label, spent, total) => {
    const over = spent > total;
    const pct = total > 0 ? Math.min(100, (spent / total) * 100) : (spent > 0 ? 100 : 0);
    return el('div', { class: `budget-item${over ? ' over' : ''}` },
      el('span', { class: 'budget-label' }, label),
      el('span', { class: 'budget-value' }, el('b', {}, String(Math.abs(total - spent))), over ? ' over' : ' left'),
      el('span', { class: 'budget-left' }, `${spent} / ${total}`),
      el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: `width:${pct}%` })));
  };
  $('#budget-bar').replaceChildren(
    el('span', { class: 'budget-build' }, `L${build.level} ${GAME.classes[build.career]?.name ?? ''}`),
    item('Training points', spentSkillPoints(build), skillPointBudget(build.level)),
    item('Attribute points', spentAttributePoints(build), attributePointBudget(build.level)));
}

// One collapsible panel per class on the path. Collapsed state lives in memory for the session.
function renderSkills(build) {
  const groups = lineage(build.career).map(classId => {
    const c = GAME.classes[classId];
    const skills = Object.keys(GAME.skills).map(Number).filter(id => GAME.skills[id].class === classId);
    const spent = skills.reduce((n, id) => n + skillCost(id, rankOf(build, id)), 0);
    const key = `tier:${classId}`;
    return el('details', {
      class: 'panel tier', 'data-tier': c.tier, open: !collapsed.has(key),
      ontoggle: e => { if (e.target.open) collapsed.delete(key); else collapsed.add(key); },
    },
    el('summary', { class: 'tierhead', 'data-focus-key': key },
      el('span', { class: 'tier-no' }, `Tier ${ROMAN[c.tier]}`),
      el('span', { class: 'tier-name' }, c.name),
      el('span', { class: 'tier-from' }, `from level ${c.level}`),
      el('span', { class: 'tier-pts', title: 'Training points spent in this class' }, el('b', {}, String(spent)), ' pts')),
    el('div', { class: 'skill-list' }, ...skills.map(id => skillCard(id, build))));
  });
  $('#skill-groups').replaceChildren($('#skills-title'), ...groups);
}

function skillCard(skillId, build) {
  const s = GAME.skills[skillId];
  const name = displayName(s);
  const rank = rankOf(build, skillId);
  const min = minRank(skillId);
  const isSel = selected?.skillId === skillId;
  const kind = skillKind(s);
  const left = skillPointBudget(build.level) - spentSkillPoints(build);
  const open = () => select(skillId, Math.max(1, rank));
  return el('article', { class: `skill${isSel ? ' selected' : ''}${rank > min ? ' trained' : ''}${rank > 0 ? ' owned' : ''}`, 'data-kind': kind.toLowerCase() },
    el('button', { type: 'button', class: 'plain skill-icon', tabindex: '-1', 'aria-hidden': 'true', onclick: open },
      icon(skillIcon(skillId, rank), 64)),
    el('div', { class: 'skill-head' },
      el('span', { class: 'skill-kind' }, kind),
      el('button', { type: 'button', class: 'skill-name plain', 'data-focus-key': `name:${skillId}`, onclick: open }, name)),
    el('div', { class: 'ranks', role: 'group', 'aria-label': `${name} rank, ${rank} of ${s.maxRank}` },
      ...Array.from({ length: s.maxRank }, (_, i) => {
        const r = i + 1;
        // A rank above the current one that the remaining points cannot pay for.
        const cant = r > rank && rankCost(r) - rankCost(rank) > left;
        return el('button', {
          type: 'button', class: `rank${r <= rank ? ' on' : ''}${r <= min ? ' base' : ''}${cant ? ' cant' : ''}`, 'data-focus-key': `rank:${skillId}:${r}`,
          'aria-pressed': String(r <= rank),
          'aria-label': isSignatureSkill(skillId) ? `${name}, granted with the class` : `${name} rank ${r}${r <= min ? ', free starting rank' : ''}${cant ? ', not enough points' : ''}`,
          onclick: () => {
            editBuild(b => setRank(b, skillId, r === rank ? r - 1 : r));
            select(skillId, r);
          },
          onmouseenter: () => preview(skillId, r),
          onfocus: () => preview(skillId, r),
        }, isSignatureSkill(skillId) ? 'Granted' : s.maxRank === 1 ? 'Train' : String(r));
      }),
      el('span', { class: 'rank-readout', 'aria-hidden': 'true' }, `${rank}/${s.maxRank}`),
      rank > min ? el('button', { type: 'button', class: 'clear ghost', 'data-focus-key': `clear:${skillId}`, title: 'Reset this skill', 'aria-label': `Reset ${name}`,
        onclick: () => editBuild(b => setRank(b, skillId, min)) }, '×') : null));
}

function select(skillId, rank) {
  selected = { skillId, rank };
  setDetailOpen(true);
  render();
}

// Below the wide layout the detail panel is a bottom sheet, opened by selecting a skill.
function setDetailOpen(open) {
  document.body.classList.toggle('detail-open', open);
}

let previewTimer;
function preview(skillId, rank) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const { build, character } = current();
    renderDetail(build, character, { skillId, rank });
  }, 60);
}

function renderDetail(build, character, override) {
  const target = override || selected;
  const box = $('#skill-detail');
  if (!target || !GAME.skills[target.skillId]) {
    box.replaceChildren(el('p', { class: 'muted' }, 'Select a skill or hover a rank to see its details.'));
    return;
  }
  const id = target.skillId;
  const s = GAME.skills[id];
  const name = displayName(s);
  const rank = Math.min(s.maxRank, Math.max(1, target.rank));
  const owned = rankOf(build, id);
  const min = minRank(id);
  const kind = skillKind(s);
  const kids = [
    el('div', { class: 'detail-head' },
      icon(skillIcon(id, rank), 64, 'detail-icon'),
      el('div', { class: 'detail-title' },
        el('span', { class: 'lbl' }, `${kind} · ${GAME.classes[s.class].name} · level ${s.level}`),
        el('h2', {}, name))),
    el('div', { class: 'vranks', role: 'group', 'aria-label': `${name}: rank to view` },
      ...Array.from({ length: s.maxRank }, (_, i) => {
        const r = i + 1;
        return el('button', {
          type: 'button', class: `rank${r <= owned ? ' on' : ''}${r <= min ? ' base' : ''}${r === rank ? ' viewing' : ''}`,
          'aria-pressed': String(r === rank), 'aria-label': `View rank ${r}${r <= owned ? ', owned' : ''}`, 'data-focus-key': `view:${id}:${r}`,
          onclick: () => select(id, r),
        }, isSignatureSkill(id) ? 'Granted' : s.maxRank === 1 ? 'Train' : String(r));
      })),
    el('p', { class: 'meta' },
      el('span', { class: 'tag', 'data-kind': kind.toLowerCase() }, kind),
      el('span', { class: 'tag' }, `Rank ${rank} / ${s.maxRank}`),
      owned >= rank ? el('span', { class: 'tag owned' }, 'Owned') : null),
  ];

  const stats = derivedStats(character.race, build.level, build.attributes);
  if (s.abilities.length) {
    for (const abilityId of s.abilities) {
      const a = GAME.abilities[abilityId];
      const pump = a.pumps[rank] || a.pumps[1];
      if (pump) {
        kids.push(el('p', { class: 'rank-title' }, pump.name));
        kids.push(el('pre', { class: 'desc' }, abilityText(abilityId, rank, pump.desc, build.level, stats)));
      }
      if (a.logos.length) kids.push(el('div', { class: 'chips', role: 'group', 'aria-label': 'Logos required' },
        el('span', { class: 'chips-label' }, 'Logos'), ...a.logos.map(l => el('span', { class: 'chip' }, l))));
    }
  } else {
    const r = s.ranks[rank - 1];
    if (r) {
      kids.push(el('p', { class: 'rank-title' }, r.name));
      kids.push(el('pre', { class: 'desc' }, r.desc));
    }
  }

  // Cost line plus a train/untrain action, so the rank can be changed from the detail sheet too.
  const left = skillPointBudget(build.level) - spentSkillPoints(build);
  let costText, action = null;
  if (isSignatureSkill(id)) {
    costText = `Granted free with the ${GAME.classes[s.class].name} class`;
  } else if (owned >= rank) {
    costText = `Owned · rank ${owned}` + (owned < s.maxRank ? ` · rank ${owned + 1} costs ${owned + 1} more point${owned + 1 > 1 ? 's' : ''}` : ' · maximum rank');
    if (rank > min) action = el('button', { type: 'button', class: 'detail-act', 'data-focus-key': `act:${id}`,
      onclick: () => { editBuild(b => setRank(b, id, rank - 1)); select(id, Math.max(1, rank - 1)); } }, `Untrain to rank ${rank - 1}`);
  } else {
    const need = rankCost(rank) - rankCost(owned);
    costText = `Rank ${rank} costs ${need} more point${need > 1 ? 's' : ''} from rank ${owned}` + (need > left ? ` · only ${Math.max(0, left)} left` : '');
    action = el('button', { type: 'button', class: `detail-act${need > left ? ' cant' : ''}`, 'data-focus-key': `act:${id}`,
      onclick: () => { editBuild(b => setRank(b, id, rank)); select(id, rank); } }, `Train to rank ${rank}`);
  }
  kids.push(el('div', { class: `cost${owned >= rank ? ' owned' : ''}` }, el('span', {}, costText), action));

  kids.push(...overview(s.desc, rank));

  // Previous / next skill in the order the panels show them (used on the bottom-sheet layouts).
  const order = visibleSkills(build);
  const i = order.indexOf(id);
  const navBtn = (j, dir) => {
    const other = order[j];
    const label = other ? displayName(GAME.skills[other]) : '';
    return el('button', {
      type: 'button', class: `nav-${dir}`, disabled: !other, 'data-focus-key': `nav:${dir}`,
      'aria-label': other ? `${dir === 'prev' ? 'Previous' : 'Next'} skill: ${label}` : `No ${dir === 'prev' ? 'previous' : 'next'} skill`,
      onclick: () => { const { build: b } = current(); select(other, Math.max(1, rankOf(b, other))); },
    }, dir === 'prev' ? '‹ ' : '', el('span', { class: 'nav-name' }, label || '—'), dir === 'next' ? ' ›' : '');
  };
  kids.push(el('div', { class: 'detail-nav' }, navBtn(i - 1, 'prev'), navBtn(i + 1, 'next')));
  box.replaceChildren(...kids);
}

// The client's skill overview ends with "Pump N: effect" lines; show those as an all-ranks table
// with the viewed rank highlighted, and the intro prose in a collapsed block.
function overview(text, rank) {
  const pumps = [];
  const prose = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^Pump (\d+):\s*(.*)$/);
    if (m) pumps.push([Number(m[1]), m[2]]);
    else prose.push(line);
  }
  const out = [];
  if (pumps.length) {
    out.push(el('p', { class: 'lbl all-ranks' }, 'All ranks'));
    out.push(el('table', { class: 'pump-table' }, el('tbody', {}, ...pumps.map(([n, effect]) =>
      el('tr', { class: n === rank ? 'current' : null }, el('th', { scope: 'row' }, String(n)), el('td', {}, effect))))));
  }
  const intro = prose.join('\n').trim();
  if (intro) out.push(el('details', { class: 'about' }, el('summary', {}, 'About this skill'), el('pre', { class: 'desc' }, intro)));
  return out;
}

// ---- events -------------------------------------------------------------------------------

function wire() {
  $('#character-select').addEventListener('change', e => { store.selectCharacter(e.target.value); selected = null; });
  $('#char-new').addEventListener('click', () => { store.createCharacter(); selected = null; });
  $('#char-dup').addEventListener('click', () => store.duplicateCharacter(store.activeCharacter().id));
  $('#char-del').addEventListener('click', () => {
    const c = store.activeCharacter();
    if (confirm(`Delete character "${c.name}" and all ${c.builds.length} build(s)?`)) store.removeCharacter(c.id);
  });

  $('#char-name').addEventListener('input', e => store.updateCharacter(store.activeCharacter().id, { name: e.target.value || 'Unnamed' }));
  $('#race-select').addEventListener('change', e => store.updateCharacter(store.activeCharacter().id, { race: e.target.value }));
  $('#build-name').addEventListener('input', e => editBuild(b => { b.name = e.target.value || 'Unnamed build'; }));
  $('#build-notes').addEventListener('input', e => editBuild(b => { b.notes = e.target.value; }));

  $('#build-new').addEventListener('click', () => { store.createBuild(); selected = null; });
  $('#build-dup').addEventListener('click', () => store.duplicateBuild(store.activeBuild().id));
  $('#build-del').addEventListener('click', () => {
    const b = store.activeBuild();
    if (confirm(`Delete build "${b.name}"?`)) store.removeBuild(b.id);
  });
  $('#build-reset').addEventListener('click', () => {
    if (confirm('Reset this build\'s class, skills and attributes?')) editBuild(b => { b.career = 1; b.skills = {}; b.attributes = { body: 0, mind: 0, spirit: 0 }; });
  });

  const setLevel = n => editBuild(b => { b.level = clampLevel(n); });
  $('#level-down').addEventListener('click', () => setLevel(store.activeBuild().level - 1));
  $('#level-up').addEventListener('click', () => setLevel(store.activeBuild().level + 1));
  $('#level-range').addEventListener('input', e => setLevel(e.target.value));
  $('#level-input').addEventListener('change', e => { if (e.target.value === '') render(); else setLevel(e.target.value); });

  // Phone: the career tree is hidden behind the path strip until asked for.
  $('#career-toggle').addEventListener('click', () => { careerTreeOpen = !careerTreeOpen; render(); });
  $('#attrs-sec').addEventListener('toggle', e => {
    if (!isPhone()) return;
    if (e.target.open) collapsed.delete('attrs'); else collapsed.add('attrs');
  });
  phoneMq.addEventListener('change', render);

  // The "···" menu is a <details>; close it after an item is used, on Escape, or on a click outside.
  const menu = $('#more-menu');
  menu.querySelector('.menu-list').addEventListener('click', e => {
    if (e.target.closest('button, label')) menu.open = false;
  });
  document.addEventListener('click', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.open) { e.preventDefault(); menu.open = false; menu.querySelector('summary').focus(); }
  });

  wireServerRules();

  // Share / import.
  const dialog = $('#share-dialog');
  const msg = t => { $('#share-msg').textContent = t; };
  $('#share-open').addEventListener('click', () => {
    const { character, build } = current();
    $('#share-code').value = encodeShare(character, build);
    $('#import-code').value = '';
    msg('');
    dialog.showModal();
  });
  const copy = async text => {
    try { await navigator.clipboard.writeText(text); msg('Copied.'); } catch { msg('Copy failed; select the text and copy it manually.'); }
  };
  $('#share-copy').addEventListener('click', () => copy($('#share-code').value));
  $('#share-link').addEventListener('click', () => {
    const url = new URL(location.href);
    url.hash = `b=${$('#share-code').value}`;
    copy(url.toString());
  });
  const doImport = asNewCharacter => {
    try {
      store.importShared(decodeShare($('#import-code').value), { asNewCharacter });
      msg('Imported.');
    } catch (e) {
      msg(`Could not read that code: ${e.message}`);
    }
  };
  $('#import-build').addEventListener('click', () => doImport(false));
  $('#import-char').addEventListener('click', () => doImport(true));

  // Detail bottom sheet (narrow layouts).
  $('#detail-close').addEventListener('click', () => setDetailOpen(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('detail-open') && !$('#share-dialog').open) setDetailOpen(false);
  });

  // Restore is a label around a hidden file input; make it work from the keyboard too.
  $('#restore-btn').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#backup-import').click(); }
  });

  // Backup / restore of everything.
  $('#backup-export').addEventListener('click', () => {
    const blob = new Blob([store.exportAll()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `irplanner-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#backup-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const n = store.importAll(await file.text());
      alert(`Restored ${n} character(s).`);
    } catch (err) {
      alert(`Could not restore: ${err.message}`);
    }
  });
}

// Server rules dialog: which repository, and which branch, tag or commit, the numbers come from.
function renderServerStatus(message, isError) {
  const { source, result } = serverRules;
  const rows = [el('p', { class: isError ? 'server-msg error' : 'server-msg' }, message || describeRules())];
  if (source && result) {
    const list = (label, items, cls) => (items.length ? el('p', { class: `server-list ${cls}` }, el('b', {}, `${label}: `), items.join(', ')) : null);
    rows.push(
      el('p', { class: 'server-list' }, el('b', {}, 'Commit: '), result.commit ? shortCommit(result.commit) : 'unknown (GitHub rate limit)',
        el('b', {}, ' · Read: '), new Date(result.at).toLocaleString()),
      list('Read from the server', result.read, ''),
      list('Different from the built-in numbers', result.changed, 'changed'),
      list('Could not read, kept the last good value or the built-in table', result.missed, 'missed'));
  }
  $('#server-status').replaceChildren(...rows.filter(Boolean));
  renderSavedCopies();
}

// Copies saved on this device: these still load with no connection.
async function renderSavedCopies() {
  const copies = await listCopies();
  $('#server-saved').replaceChildren(...(copies.length ? [el('span', { class: 'lbl' }, 'Saved on this device')] : []),
    ...copies.map(c => el('button', {
      type: 'button',
      title: `Saved ${new Date(c.at).toLocaleString()}`,
      onclick: () => {
        $('#server-repo').value = c.source.repo;
        $('#server-ref').value = c.source.ref;
        $('#server-load').click();
      },
    }, `${c.source.repo} @ ${c.source.ref}`)));
}

function wireServerRules() {
  const dialog = $('#server-dialog');
  const busy = on => { for (const b of dialog.querySelectorAll('.server-actions button')) b.disabled = on; };
  const fill = source => {
    $('#server-repo').value = (source || DEFAULT_SOURCE).repo;
    $('#server-ref').value = (source || DEFAULT_SOURCE).ref;
  };
  const load = async source => {
    busy(true);
    renderServerStatus('Loading…');
    try {
      await useSource(source);
      renderServerStatus();
      render();
    } catch (e) {
      renderServerStatus(`${e.message} The current rules were not changed.`, true);
    } finally {
      busy(false);
    }
  };
  $('#server-open').addEventListener('click', () => {
    fill(serverRules.source);
    renderServerStatus();
    dialog.showModal();
  });
  $('#server-load').addEventListener('click', () => {
    const parsed = parseRepoInput($('#server-repo').value);
    const ref = parsed?.ref || $('#server-ref').value.trim();
    if (!parsed) return renderServerStatus('Enter a repository as owner/name or a GitHub link.', true);
    if (!isValidRef(ref)) return renderServerStatus('Enter a branch, tag or commit.', true);
    fill({ repo: parsed.repo, ref });
    return load({ repo: parsed.repo, ref });
  });
  $('#server-default').addEventListener('click', () => { fill(DEFAULT_SOURCE); load({ ...DEFAULT_SOURCE }); });
  $('#server-builtin').addEventListener('click', () => load(null));
  for (const b of dialog.querySelectorAll('[data-ref]')) b.addEventListener('click', () => { $('#server-ref').value = b.dataset.ref; });
}

// A shared link (#b=<code>) imports its build once, as a new character.
function importFromHash() {
  const m = location.hash.match(/^#b=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    store.importShared(decodeShare(m[1]), { asNewCharacter: true });
  } catch { /* ignore bad links */ }
  history.replaceState(null, '', location.pathname + location.search);
}

initServerRules();
store.subscribe(render);
wire();
importFromHash();
render();
// A branch can move, so its rules are fetched on every visit; the page is usable meanwhile.
refreshServerRules().then(render);

// Lets the site open with no connection. Icons are fetched once, in small batches, so a build
// looks right offline even if those skills were never viewed.
async function keepIconsOffline() {
  const KEY = 'irplanner.iconsSaved';
  try {
    if (localStorage.getItem(KEY) === GAME.clientVersion) return;
    const urls = Object.keys(GAME.classes).map(id => `img/classes/${id}.webp`);
    for (const [id, s] of Object.entries(GAME.skills)) {
      urls.push(`img/skills/${id}.webp`);
      for (let r = 1; r <= s.maxRank; r++) urls.push(`img/skills/ranks/${id}_${r}.webp`);
    }
    const cache = await caches.open('irplanner-site-v1');
    for (let i = 0; i < urls.length; i += 24) await cache.addAll(urls.slice(i, i + 24));
    localStorage.setItem(KEY, GAME.clientVersion);
  } catch { /* tried again next visit */ }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(keepIconsOffline).catch(() => {});
}
