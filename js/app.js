import { GAME } from './data/gamedata.js';
import { store, encodeShare, decodeShare } from './storage.js';
import {
  MAX_LEVEL, rankCost, skillPointBudget, attributePointBudget, baseAttributes, derivedStats,
  lineage, availableSkills, rankOf, minRank, spentSkillPoints, spentAttributePoints, validate,
  displayName, skillKind,
} from './rules.js';
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

let selected = null; // { skillId, rank }

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
  if (!Number.isFinite(total)) { render(); return; }
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
  renderSkills(build, character);
  renderDetail(build, character);
  if (focusKey) {
    const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
}

function renderCharacterSelect(character) {
  const sel = $('#character-select');
  sel.replaceChildren(...store.characters().map(c =>
    el('option', { value: c.id, selected: c.id === character.id }, `${c.name} (${GAME.races[raceId(c.race)]?.name ?? c.race})`)));
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

function raceId(raceKey) {
  return Object.keys(GAME.races).find(id => GAME.races[id].key === raceKey);
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

  renderCareerTree(build);

  const skillTotal = skillPointBudget(build.level);
  const skillSpent = spentSkillPoints(build);
  const attrTotal = attributePointBudget(build.level);
  const attrSpent = spentAttributePoints(build);
  const xp = GAME.xp[build.level - 1];
  // Budget readout: label, spent / total, a fill bar and the remainder. Over budget flips the tile red.
  const budget = (label, spent, total) => {
    const over = spent > total;
    const pct = total > 0 ? Math.min(100, (spent / total) * 100) : (spent > 0 ? 100 : 0);
    return el('div', { class: `stat budget${over ? ' over' : ''}`, role: 'group', 'aria-label': label },
      el('span', { class: 'stat-label' }, label),
      el('span', { class: 'stat-value' }, el('b', {}, String(spent)), el('small', {}, ` / ${total}`)),
      el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: `width:${pct}%` })),
      el('span', { class: 'stat-sub' }, over ? `${spent - total} over budget` : `${total - spent} left`));
  };
  $('#points').replaceChildren(
    budget('Skill points', skillSpent, skillTotal),
    budget('Attribute points', attrSpent, attrTotal),
    el('div', { class: 'stat xp' },
      el('span', { class: 'stat-label' }, 'Experience for level'),
      el('span', { class: 'stat-value' }, el('b', {}, xp.toLocaleString()))),
  );
  const row = (label, value, unit) => el('div', { class: 'stat' },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, el('b', {}, String(value)), unit ? el('small', {}, unit) : null));

  const base = baseAttributes(character.race, build.level);
  $('#attributes').replaceChildren(...ATTRS.map(a => {
    const spent = build.attributes[a.key] || 0;
    const room = Math.max(0, attrTotal - attrSpent);
    return el('div', { class: 'attr', 'data-attr': a.key },
      el('div', { class: 'name' }, a.name, el('small', {}, `${base[a.key]} base + ${spent} · ${a.hint}`)),
      el('button', { type: 'button', class: 'step', 'data-focus-key': `attr-:${a.key}`, 'aria-label': `Remove ${a.name} point`,
        title: 'Shift-click or hold to remove faster', disabled: spent <= 0,
        onclick: e => { if (!holding) adjustAttribute(a.key, e.shiftKey ? -10 : -1); },
        onpointerdown: e => startHold(e, () => adjustAttribute(a.key, -1)) }, '−'),
      el('input', {
        type: 'number', class: `value${spent > 0 ? ' boosted' : ''}`, inputmode: 'numeric',
        min: base[a.key], max: base[a.key] + spent + room, value: base[a.key] + spent,
        'aria-label': `${a.name} total`, 'data-focus-key': `attrv:${a.key}`,
        onchange: e => setAttributeTotal(a.key, Number(e.target.value)),
      }),
      el('button', { type: 'button', class: 'step', 'data-focus-key': `attr+:${a.key}`, 'aria-label': `Add ${a.name} point`,
        title: 'Shift-click or hold to add faster', disabled: room <= 0,
        onclick: e => { if (!holding) adjustAttribute(a.key, e.shiftKey ? 10 : 1); },
        onpointerdown: e => startHold(e, () => adjustAttribute(a.key, 1)) }, '+'));
  }));
  $('#attr-hint').hidden = attrTotal === 0;

  const d = derivedStats(character.race, build.level, build.attributes);
  const fmt = n => (Math.round(n * 100) / 100).toLocaleString();
  $('#derived').replaceChildren(
    row('Health', d.health.toLocaleString()),
    row('Power', d.power.toLocaleString()),
    row('Regen', `${d.regen}%`, ` ${d.regenPerSecond}/s`),
    row('Armor', fmt(d.armorBonus), '%'),
    row('Logos dmg', fmt(d.logosBonus), '%'),
    row('Crit', fmt(d.critBonus), '%'),
  );

  const issues = validate(build, character.race);
  $('#issues').replaceChildren(...issues.map(i => el('li', { class: i.level }, i.text)));
}

// The career tree is a binary tree (1 → 2 → 4 → 8 classes). It is laid out on a CSS grid with one
// column per tier and one row per leaf; a class spans the rows of its descendants, so its node sits
// centred between its children and connectors can be drawn with plain borders.
function renderCareerTree(build) {
  const path = new Set(lineage(build.career));
  const roots = Object.keys(GAME.classes).map(Number).filter(id => !GAME.classes[id].parent);
  const nodes = [];
  const tiers = new Map();
  let leaf = 0;
  const place = (id) => {
    const c = GAME.classes[id];
    const kids = (c.children || []).filter(k => GAME.classes[k]);
    let start, span;
    if (!kids.length) { start = ++leaf; span = 1; } else {
      const placed = kids.map(place);
      start = placed[0].start;
      span = placed.reduce((n, p) => n + p.span, 0);
    }
    nodes.push({ id, c, start, span, kids: kids.length, side: path.has(kids[0]) ? 'up' : path.has(kids[1]) ? 'down' : null });
    if (!tiers.has(c.tier)) tiers.set(c.tier, c.level);
    return { start, span };
  };
  roots.forEach(place);
  const tierCount = tiers.size;

  const tree = $('#career-tree');
  tree.style.setProperty('--tiers', tierCount);
  tree.style.setProperty('--leaves', leaf);
  tree.replaceChildren(
    ...[...tiers.entries()].sort((a, b) => a[0] - b[0]).map(([tier, level]) =>
      el('span', { class: 'tier-label', style: `grid-column:${tier}`, 'aria-hidden': 'true' },
        el('small', {}, 'Lvl '), String(level))),
    ...nodes.filter(n => n.kids).map(({ c, start, span, side, id }) => el('span', {
      class: 'branch', 'aria-hidden': 'true',
      style: `grid-column:${c.tier};grid-row:${start + 1} / span ${span}`,
      'data-on': path.has(id) ? 'true' : null,
      'data-side': side,
    })),
    ...nodes.sort((a, b) => a.c.tier - b.c.tier || a.start - b.start).map(({ id, c, start, span, kids }) => {
      const parentOk = !c.parent || path.has(c.parent) || path.has(id);
      const locked = build.level < c.level;
      const onPath = path.has(id);
      return el('button', {
        type: 'button', class: 'career-btn', 'aria-pressed': String(onPath), 'data-focus-key': `class:${id}`,
        style: `grid-column:${c.tier};grid-row:${start + 1} / span ${span}`,
        title: locked ? `Requires level ${c.level}`
          : id === build.career && c.parent ? `Active class · click to go back to ${GAME.classes[c.parent].name}`
          : (c.parent ? `From ${GAME.classes[c.parent].name}` : ''),
        'aria-label': `${c.name}, level ${c.level}${c.parent ? `, from ${GAME.classes[c.parent].name}` : ''}${locked ? ', locked' : ''}${id === build.career ? ', active class' : ''}`,
        disabled: locked,
        'data-offpath': parentOk ? null : 'true',
        'data-tier': c.tier,
        'data-leaf': kids ? null : 'true',
        'data-active': id === build.career ? 'true' : null,
        'data-parent-on': c.parent && path.has(c.parent) ? 'true' : null,
        onclick: () => editBuild(b => setCareer(b, path.has(id) && id === b.career && c.parent ? c.parent : id)),
      },
      el('span', { class: 'node-label' }, c.name),
      locked ? el('span', { class: 'node-req' }, `L${c.level}`) : null);
    }));
}

// Sticky readout above the skills, so the budget stays in view while pumping ranks.
function renderBudgetBar(build) {
  const item = (label, spent, total) => {
    const over = spent > total;
    const pct = total > 0 ? Math.min(100, (spent / total) * 100) : (spent > 0 ? 100 : 0);
    return el('div', { class: `budget-item${over ? ' over' : ''}` },
      el('span', { class: 'budget-label' }, label),
      el('span', { class: 'budget-value' }, el('b', {}, String(spent)), ` / ${total}`),
      el('span', { class: 'budget-left' }, over ? `${spent - total} over` : `${total - spent} left`),
      el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: `width:${pct}%` })));
  };
  $('#budget-bar').replaceChildren(
    el('span', { class: 'budget-build' }, `L${build.level} ${GAME.classes[build.career]?.name ?? ''}`),
    item('Skill points', spentSkillPoints(build), skillPointBudget(build.level)),
    item('Attributes', spentAttributePoints(build), attributePointBudget(build.level)));
}

function renderSkills(build, character) {
  const groups = lineage(build.career).map(classId => {
    const c = GAME.classes[classId];
    const skills = Object.entries(GAME.skills).filter(([, s]) => s.class === classId).map(([id]) => Number(id));
    const spent = skills.reduce((n, id) => n + rankCost(rankOf(build, id)), 0);
    return el('section', { class: 'skill-group', 'data-tier': c.tier },
      el('h3', {},
        el('span', { class: 'group-name' }, c.name),
        el('span', { class: 'unlock muted' }, `unlocks at level ${c.level}`),
        el('span', { class: 'group-spent', title: 'Skill points spent in this class' }, el('b', {}, String(spent)), ' pts')),
      el('div', { class: 'skill-list' }, ...skills.map(id => skillCard(id, build))));
  });
  $('#skill-groups').replaceChildren(...groups);
}

function skillCard(skillId, build) {
  const s = GAME.skills[skillId];
  const rank = rankOf(build, skillId);
  const min = minRank(skillId);
  const isSel = selected?.skillId === skillId;
  const kind = skillKind(s);
  const left = skillPointBudget(build.level) - spentSkillPoints(build);
  return el('article', { class: `skill${isSel ? ' selected' : ''}${rank > min ? ' trained' : ''}`, 'data-kind': kind.toLowerCase() },
    el('div', { class: 'skill-head' },
      el('button', { type: 'button', class: 'skill-name plain', onclick: () => select(skillId, Math.max(1, rank)) }, displayName(s)),
      el('span', { class: 'skill-kind' }, kind)),
    el('div', { class: 'ranks', role: 'group', 'aria-label': `${displayName(s)} rank, ${rank} of ${s.maxRank}` },
      ...Array.from({ length: s.maxRank }, (_, i) => {
        const r = i + 1;
        // A rank above the current one that the remaining points cannot pay for.
        const cant = r > rank && rankCost(r) - rankCost(rank) > left;
        return el('button', {
          type: 'button', class: `rank${r <= rank ? ' on' : ''}${r <= min ? ' base' : ''}${cant ? ' cant' : ''}`, 'data-focus-key': `rank:${skillId}:${r}`,
          'aria-pressed': String(r <= rank),
          'aria-label': `Rank ${r}${r <= min ? ', free starting rank' : ''}${cant ? ', not enough points' : ''}`,
          onclick: () => {
            editBuild(b => setRank(b, skillId, r === rank ? r - 1 : r));
            select(skillId, r);
          },
          onmouseenter: () => preview(skillId, r),
          onfocus: () => preview(skillId, r),
        }, s.maxRank === 1 ? 'Train' : String(r));
      }),
      el('span', { class: 'rank-readout', 'aria-hidden': 'true' }, `${rank}/${s.maxRank}`),
      rank > min ? el('button', { type: 'button', class: 'clear ghost', 'data-focus-key': `clear:${skillId}`, title: 'Reset this skill', 'aria-label': `Reset ${displayName(s)}`,
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
  const s = GAME.skills[target.skillId];
  const rank = Math.min(s.maxRank, Math.max(1, target.rank));
  const owned = rankOf(build, target.skillId);
  const kids = [
    el('h2', {}, displayName(s)),
    el('p', { class: 'meta' },
      el('span', { class: 'tag', 'data-kind': skillKind(s).toLowerCase() }, skillKind(s)),
      el('span', { class: 'tag' }, GAME.classes[s.class].name),
      el('span', { class: 'tag' }, `Level ${s.level}`),
      el('span', { class: 'tag' }, `Rank ${rank} / ${s.maxRank}`)),
  ];

  if (s.abilities.length) {
    for (const abilityId of s.abilities) {
      const a = GAME.abilities[abilityId];
      const pump = a.pumps[rank] || a.pumps[1];
      if (pump) {
        kids.push(el('p', { class: 'rank-title' }, pump.name));
        kids.push(el('pre', { class: 'desc' }, abilityText(abilityId, rank, pump.desc, build.level, derivedStats(character.race, build.level, build.attributes))));
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

  const step = owned >= rank ? `Owned (rank ${owned}).` : `Rank ${rank} costs ${rank} point(s); ${rankCost(rank) - rankCost(owned)} more from rank ${owned}.`;
  kids.push(el('p', { class: `cost${owned >= rank ? ' owned' : ''}` }, step));
  kids.push(el('details', {}, el('summary', {}, 'Skill overview'), ...overview(s.desc, rank)));
  box.replaceChildren(...kids);
}

// The client's skill overview ends with "Pump N: effect" lines; show those as a table with the
// viewed rank highlighted, and anything else as text.
function overview(text, rank) {
  const lines = text.split('\n');
  const pumps = [];
  const prose = [];
  for (const line of lines) {
    const m = line.match(/^Pump (\d+):\s*(.*)$/);
    if (m) pumps.push([Number(m[1]), m[2]]);
    else prose.push(line);
  }
  const out = [];
  const intro = prose.join('\n').trim();
  if (intro) out.push(el('pre', { class: 'desc' }, intro));
  if (pumps.length) {
    out.push(el('table', { class: 'pump-table' }, el('tbody', {}, ...pumps.map(([n, effect]) =>
      el('tr', { class: n === rank ? 'current' : null }, el('th', { scope: 'row' }, String(n)), el('td', {}, effect))))));
  }
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
  $('#level-input').addEventListener('change', e => setLevel(e.target.value));

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

// A shared link (#b=<code>) imports its build once, as a new character.
function importFromHash() {
  const m = location.hash.match(/^#b=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    store.importShared(decodeShare(m[1]), { asNewCharacter: true });
  } catch { /* ignore bad links */ }
  history.replaceState(null, '', location.pathname + location.search);
}

$('#data-source').textContent = `Game data from client ${GAME.clientVersion}. Progression rules follow the Rasa.NET server.`;
store.subscribe(render);
wire();
importFromHash();
render();
