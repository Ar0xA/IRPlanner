"""Generate js/data/gamedata.js from a local Tabula Rasa client install.

Every value in the output comes from the client's own data modules (game.zip and
trpython.zip); nothing is typed in by hand. Re-run after pointing it at a client:

  python -I tools/build_data.py "C:/path/to/Tabula Rasa 1.16.5.0"

Server-side rules the client does not contain (skill point budget, attribute
points, derived stats) live in js/rules.js, with their sources noted there.
"""
import configparser
import json
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyo24  # noqa: E402
import ability_tokens  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'js', 'data', 'gamedata.js')

GAME_MODULES = {
    'skilldata': 'generated/client/skilldata.pyo',
    'abilityproperty': 'generated/client/abilityproperty.pyo',
    'actor': 'generated/client/actor.pyo',
    'abilitydata': 'generated/client/abilitydata.pyo',
    'actiondata': 'generated/client/actiondata.pyo',
    'character': 'generated/client/character.pyo',
    'characterclass': 'generated/client/characterclass.pyo',
    'race': 'generated/client/constant/race.pyo',
    'logosstone': 'generated/client/logosstone.pyo',
    'ui_text': 'generated/client/language/english/uielementlanguage.pyo',
    'class_text': 'generated/client/language/english/characterclasslanguage.pyo',
    'race_text': 'generated/client/language/english/racelanguage.pyo',
    'logos_text': 'generated/client/language/english/logosstonelanguage.pyo',
}
CLIENT_MODULES = {
    'gameuiutil': 'client/gameuiutil.pyo',
}

# Actor attribute ids used by actionAttributeCost (client actorattributes).
COST_ATTR = {5: 'adrenaline', 6: 'power'}


def evaluate(archive, member):
    with zipfile.ZipFile(archive) as z:
        code = pyo24.loads(z.read(member), member)
    ns = pyo24.evaluate(code)
    if '__unsupported__' in ns:
        print(f'note: {member}: evaluation stopped early ({ns["__unsupported__"][:1]})')
    return ns


def suffix(ref):
    # Unresolved names evaluate to Ref objects; used as dict keys they become their repr string.
    return (ref if isinstance(ref, str) else repr(ref)).rsplit('.', 1)[-1]


def clean(text):
    if text is None:
        return None
    if isinstance(text, (list, tuple)):
        text = text[0] if text else ''
    return str(text).replace('\r\n', '\n').replace('\r', '\n').strip()


def main(client_dir):
    game_zip = os.path.join(client_dir, 'data', 'game.zip')
    tr_zip = os.path.join(client_dir, 'trpython.zip')
    m = {k: evaluate(game_zip, v) for k, v in GAME_MODULES.items()}
    m.update({k: evaluate(tr_zip, v) for k, v in CLIENT_MODULES.items()})

    ver = configparser.ConfigParser()
    ver.read(os.path.join(client_dir, 'version.ini'))
    client_version = ver.get('Settings', 'Version', fallback='unknown')

    ui = m['ui_text']['lookup']

    def text(text_id):
        v = ui.get((text_id, 1))
        return clean(v)

    # Classes: ids/keys from characterclass, names from the language table,
    # parent/children from gameuiutil.g_ClassTree, unlock level from skillCharacter.
    cc = m['characterclass']
    class_names = m['class_text']['lookup']
    tree = m['gameuiutil']['g_ClassTree']
    key_to_id = {k: v for k, v in cc['bystring'].items()}
    classes = {}
    for ref, (name, parent, *children) in tree.items():
        key = suffix(ref)
        cid = key_to_id[key]
        classes[cid] = {
            'key': key.lower(),
            'name': class_names.get(cid, name),
            'parent': key_to_id.get(suffix(parent)) if repr(parent) != 'None' and parent is not None else None,
            'children': [key_to_id[suffix(c)] for c in children if c is not None and repr(c) != 'None'],
        }

    sd = m['skilldata']
    skill_class = sd['skillCharacter']  # skillId -> [classId, level]
    for cid in classes:
        levels = {lvl for (c, lvl) in skill_class.values() if c == cid}
        classes[cid]['level'] = min(levels) if levels else None
    for cid, c in classes.items():
        depth, p = 1, c['parent']
        while p:
            depth += 1
            p = classes[p]['parent']
        c['tier'] = depth

    # Races.
    race_names = m['race_text']['lookup']
    races = {rid: {'key': key.lower(), 'name': race_names.get(rid, key)} for key, rid in m['race']['bystring'].items()}

    # Abilities linked to skills.
    ad = m['abilitydata']
    act = m['actiondata']
    logos_names = m['logos_text']['lookup']
    logos_seq = m['logosstone']['logosSequences']
    ability_skill = {aid: skills[0] for aid, skills in ad['skillRequirements'].items() if skills}

    abilities = {}
    for aid, sid in ability_skill.items():
        pumps = {}
        for (a, pump), row in ad['abilities'].items():
            if a != aid:
                continue
            cost = {COST_ATTR.get(attr, str(attr)): amt for attr, amt in act['actionAttributeCost'].get((aid, pump), [])}
            pumps[pump] = {'name': text(row[1]), 'desc': text(row[2]), 'cost': cost}
        seq = sorted(logos_seq.get(aid, []))
        abilities[aid] = {
            'skill': sid,
            'pumps': dict(sorted(pumps.items())),
            'logos': [logos_names.get(lid, str(lid)) for _, lid in seq],
        }

    skills = {}
    for sid, row in sd['skillData'].items():
        key, name_id, desc_id, _entity, max_rank = row
        cls, level = skill_class.get(sid, (None, None))
        if cls is None:
            continue  # not a player-trainable skill
        ranks = []
        for r in range(1, max_rank + 1):
            lv = sd['skillLevel'].get((sid, r))
            ranks.append({'name': text(lv[1]), 'desc': text(lv[2])} if lv else None)
        skill_abilities = sorted(a for a, s in ability_skill.items() if s == sid)
        skills[sid] = {
            'key': key.lower(),
            'name': text(name_id),
            'desc': text(desc_id),
            'class': cls,
            'level': level,
            'maxRank': max_rank,
            'signature': '_SIG_' in key,
            'abilities': skill_abilities,
            'ranks': ranks,
        }

    # Ability tooltip tokens (ability_tokens.py ports the client's GetAbilityDataDict).
    # It works on JSON dumps of the modules, so write those to a temp dir first.
    dumps = {'abilitydata': 'abilitydata.json', 'actiondata': 'actiondata.json',
             'abilityproperty': 'abilityproperty.json', 'actor': 'actor.json',
             'skilldata': 'skilldata.json', 'ui_text': 'language_english_uielementlanguage.json'}
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, 'dump'))
        for key, name in dumps.items():
            with open(os.path.join(tmp, 'dump', name), 'w', encoding='utf-8') as f:
                json.dump(pyo24.to_jsonable(m[key]), f, ensure_ascii=False, default=repr)
        out_tokens = os.path.join(tmp, 'ability_tokens.json')
        ability_tokens.main(tmp, out_tokens)
        tokens = json.load(open(out_tokens, encoding='utf-8'))
    if tokens['unresolved'] or tokens['leftVerbatim']:
        print(f"note: {len(tokens['unresolved'])} unresolved, {len(tokens['leftVerbatim'])} verbatim ability tokens")
    for aid, a in abilities.items():
        for pump, p in a['pumps'].items():
            spec = tokens['abilities'].get(str(aid), {}).get(str(pump))
            if spec:
                p['tokens'] = spec

    xp = m['character']['experienceTable']
    data = {
        'clientVersion': client_version,
        'maxLevel': max(xp),
        'xp': [xp[lvl] for lvl in sorted(xp)],
        'classes': classes,
        'races': races,
        'skills': dict(sorted(skills.items())),
        'abilities': dict(sorted(abilities.items())),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'// Generated by tools/build_data.py from Tabula Rasa client {client_version}. Do not edit by hand.\n')
        f.write('export const GAME = ')
        json.dump(data, f, ensure_ascii=False, indent=1, default=str)
        f.write(';\n')
    print(f'{len(classes)} classes, {len(races)} races, {len(skills)} skills, {len(abilities)} abilities -> {OUT}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
