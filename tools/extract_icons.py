"""Extract Tabula Rasa skill and class UI icons from a local client install.

Read-only on the client: archives are opened for reading, nothing is executed.
Every mapping comes from the client's own data/bytecode:

  skills window row icon   client/ui/skillsabilitieswindow.pyo _LoadSkills
                             -> gameuiutil.LoadSkillIcon(skillId, 0, ...)
                             -> GetSkillLevelIcon(skillId, 0) -> GetSkillIcon(skillId)
                             -> stringtable.lookup[skilldata.skillData[skillId][3]]
  per-rank pump icons      _LoadSkills, for idx in 1..maxSkillLvl:
                             ability skill (GetAbilityFromSkill != None):
                               LoadAbilityIcon(abilityId, idx) -> GetAbilityIcon
                               -> stringtable.lookup[abilitydata.abilities[(abilityId, idx)][0]]
                             otherwise LoadSkillIcon(skillId, idx) -> GetSkillLevelIcon
                               -> stringtable.lookup[skilldata.skillLevel[(skillId, idx)][0]]
  class emblem             _ShowClass -> gameuiutil.LoadCharacterClassIcon(classId, ClassTree.ClassIcon)
                             -> kCharacterClassIcons[classId] (a UI textureDef id)
                             -> <textureDef id=... name=... regionL/T/R/B> in data/xml/Tabula_Rasa_UI_EXPORT.xml
  class tree node states   _UpdateClassTree: button_blue (current class / lineage),
                             button_red (not reachable), button_grey (reachable);
                             textureDefs skills_tree_{blue,red,grey}[_hl,_down,_disabled]
                             (generic, identical for every class)

Texture files are looked up by file name across every *.glm archive under data/.

GLM archive format (little endian):
  file  = <entry data ...> <string table> <footer> <u32 footerOffset>
  footer: "CHNKBLXX" u32 stringTableOffset, u32 stringTableSize, u32 entryCount,
          entryCount x 22-byte entries:
            u32 dataOffset, u32 storedSize, u32 size, u32 nameOffset (into string table),
            u16 compression (0 = stored, 1 = zlib), u32 timestamp (unix)
  The string table is NUL-terminated file names. Names are unique across archives.

Catalog files (*.cat inside catalogs.glm) are per-entity asset dependency lists:
  "CHNKBLXX" "GLTC" u32 size ... followed by "RTSI" string records
  (u32 len, u32 ?, u32 ?, char[len] NUL-terminated) and "NONI" records.
  They are not used for UI icon lookup; parse_catalog_strings() lists their names.

Usage:
  python -I extract_icons.py "C:/path/to/Tabula Rasa 1.16.5.0" OUT_DIR [--pyo24 DIR] [--no-ranks]
"""
import argparse
import glob
import io
import json
import os
import re
import struct
import sys
import zipfile
import zlib

# --------------------------------------------------------------------------- GLM


class GlmEntry:
    __slots__ = ('archive', 'name', 'offset', 'stored_size', 'size', 'compression', 'timestamp')

    def __init__(self, archive, name, offset, stored_size, size, compression, timestamp):
        self.archive, self.name = archive, name
        self.offset, self.stored_size, self.size = offset, stored_size, size
        self.compression, self.timestamp = compression, timestamp


class GlmArchive:
    FOOTER_MAGIC = b'CHNKBLXX'
    ENTRY = struct.Struct('<IIIIHI')

    def __init__(self, path):
        self.path = path
        self.entries = []
        with open(path, 'rb') as f:
            f.seek(0, 2)
            n = f.tell()
            f.seek(n - 4)
            footer_off, = struct.unpack('<I', f.read(4))
            f.seek(footer_off)
            head = f.read(20)
            if head[:8] != self.FOOTER_MAGIC:
                raise ValueError(f'{path}: not a GLM archive (footer {head[:8]!r})')
            str_off, str_size, count = struct.unpack('<III', head[8:20])
            raw = f.read(self.ENTRY.size * count)
            f.seek(str_off)
            strings = f.read(str_size)
        for i in range(count):
            off, stored, size, name_off, comp, ts = self.ENTRY.unpack_from(raw, i * self.ENTRY.size)
            name = strings[name_off:strings.index(b'\0', name_off)].decode('latin-1')
            self.entries.append(GlmEntry(self, name, off, stored, size, comp, ts))

    def read(self, entry):
        with open(self.path, 'rb') as f:
            f.seek(entry.offset)
            data = f.read(entry.stored_size)
        if entry.compression == 1:
            data = zlib.decompress(data)
        elif entry.compression != 0:
            raise ValueError(f'{entry.name}: unknown compression {entry.compression}')
        return data


class GlmIndex:
    """File name (lower case) -> GlmEntry across all *.glm under a data directory."""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.files = {}
        for p in sorted(glob.glob(os.path.join(data_dir, '**', '*.glm'), recursive=True)):
            try:
                arc = GlmArchive(p)
            except ValueError as e:
                print('skip:', e, file=sys.stderr)
                continue
            for e in arc.entries:
                self.files.setdefault(e.name.lower(), e)

    def find(self, name):
        """Exact name, else same stem with .dds/.tga (the engine stores converted textures)."""
        n = name.lower()
        stem = os.path.splitext(n)[0]
        for cand in (n, stem + '.dds', stem + '.tga'):
            if cand in self.files:
                return self.files[cand]
        return None

    def read(self, name):
        e = self.find(name)
        return (e, e.archive.read(e)) if e else (None, None)

    def archive_name(self, entry):
        return os.path.relpath(entry.archive.path, self.data_dir).replace('\\', '/')


def parse_catalog_strings(data):
    """Return the RTSI strings (asset names) of a .cat catalog file."""
    out, i = [], 0
    while True:
        i = data.find(b'RTSI', i)
        if i < 0:
            return out
        ln, = struct.unpack_from('<I', data, i + 4)
        s = data[i + 16:i + 16 + ln].split(b'\0', 1)[0]
        out.append(s.decode('latin-1'))
        i += 16 + ln


# --------------------------------------------------------------------------- client data


def load_pyo24(path_hint):
    here = os.path.dirname(os.path.abspath(__file__))
    for d in (path_hint, here, os.path.join(os.path.dirname(here), 'tools')):
        if d and os.path.exists(os.path.join(d, 'pyo24.py')):
            sys.path.insert(0, d)
            import pyo24
            return pyo24
    sys.exit('pyo24.py not found; pass --pyo24 DIR')


def evaluate(pyo24, archive, member):
    with zipfile.ZipFile(archive) as z:
        code = pyo24.loads(z.read(member), member)
    return pyo24.evaluate(code)


def suffix(ref):
    return (ref if isinstance(ref, str) else repr(ref)).rsplit('.', 1)[-1]


def parse_texture_defs(xml_path):
    """textureDef id -> dict(name, region=(l, t, r, b)) from the UI export XML."""
    defs = {}
    pat = re.compile(r'<textureDef\s([^>]*)/?>')
    attr = re.compile(r'(\w+)="([^"]*)"')
    with open(xml_path, encoding='utf-8', errors='replace') as f:
        for m in pat.finditer(f.read()):
            a = dict(attr.findall(m.group(1)))
            if 'id' in a and 'name' in a:
                try:
                    region = tuple(int(a[k]) for k in ('regionL', 'regionT', 'regionR', 'regionB'))
                except (KeyError, ValueError):
                    region = None
                defs[a['id']] = {'name': a['name'], 'region': region}
    return defs


# --------------------------------------------------------------------------- images


def decode(data, region=None):
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert('RGBA')
    if region:
        im = im.crop(region)
    return im


class Exporter:
    def __init__(self, index, out_dir, fmt='png'):
        self.index, self.out_dir, self.fmt = index, out_dir, fmt
        self.cache = {}

    def export(self, texture, rel_path, region=None):
        """Write texture (optionally cropped) to out_dir/rel_path; returns manifest info or None."""
        entry = self.index.find(texture)
        if entry is None:
            return None
        if entry.name not in self.cache:
            self.cache[entry.name] = entry.archive.read(entry)
        im = decode(self.cache[entry.name], region)
        if self.fmt != 'png':
            rel_path = os.path.splitext(rel_path)[0] + '.' + self.fmt
        path = os.path.join(self.out_dir, rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if self.fmt == 'webp':
            im.save(path, 'WEBP', quality=90, method=6)  # keeps alpha; ~3x smaller than PNG
        else:
            im.save(path)
        info = {'file': rel_path.replace('\\', '/'), 'texture': entry.name,
                'archive': self.index.archive_name(entry), 'size': list(im.size)}
        if region:
            info['region'] = list(region)
        return info


# --------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('client_dir')
    ap.add_argument('out_dir')
    ap.add_argument('--pyo24', help='directory containing pyo24.py')
    ap.add_argument('--no-ranks', action='store_true', help='skip per-rank pump icons')
    ap.add_argument('--no-sheet', action='store_true', help='skip the contact sheet')
    ap.add_argument('--format', choices=('png', 'webp'), default='png', help='output image format')
    args = ap.parse_args()

    pyo24 = load_pyo24(args.pyo24)
    data_dir = os.path.join(args.client_dir, 'data')
    game_zip = os.path.join(data_dir, 'game.zip')
    tr_zip = os.path.join(args.client_dir, 'trpython.zip')

    skilldata = evaluate(pyo24, game_zip, 'generated/client/skilldata.pyo')
    abilitydata = evaluate(pyo24, game_zip, 'generated/client/abilitydata.pyo')
    charclass = evaluate(pyo24, game_zip, 'generated/client/characterclass.pyo')
    lookup = evaluate(pyo24, game_zip, 'generated/client/stringtable.pyo')['lookup']
    gameuiutil = evaluate(pyo24, tr_zip, 'client/gameuiutil.pyo')
    texdefs = parse_texture_defs(os.path.join(data_dir, 'xml', 'Tabula_Rasa_UI_EXPORT.xml'))

    index = GlmIndex(data_dir)
    ex = Exporter(index, args.out_dir, args.format)
    manifest = {'skills': {}, 'classes': {}, 'class_tree_states': {}, 'missing': [], 'notes': []}

    # gameuiutil.GetAbilityFromSkill: first ability whose skillRequirements[0] == skillId
    skill_ability = {}
    for ab_id, req in sorted(abilitydata['skillRequirements'].items()):
        if req:
            skill_ability.setdefault(req[0], ab_id)

    # ---- skills
    for sid, row in sorted(skilldata['skillData'].items()):
        key, max_rank, icon_id = row[0], row[4], row[3]
        tex = lookup.get(icon_id)
        info = ex.export(tex, os.path.join('skills', f'{sid}.png')) if tex else None
        ab = skill_ability.get(sid)
        rec = {'key': key, 'maxRank': max_rank, 'abilityId': ab, 'iconStringId': icon_id}
        if info:
            rec.update(info)
            rec['source'] = 'skilldata.skillData[skillId][3] -> stringtable.lookup (gameuiutil.GetSkillIcon)'
        else:
            manifest['missing'].append({'skill': sid, 'texture': tex})
        if not args.no_ranks:
            ranks = []
            for r in range(1, max_rank + 1):
                if ab is not None:
                    a_row = abilitydata['abilities'].get((ab, r))
                    rid, src = (a_row[0] if a_row else None), 'abilitydata.abilities[(abilityId, rank)][0]'
                else:
                    l_row = skilldata['skillLevel'].get((sid, r))
                    rid, src = (l_row[0] if l_row else None), 'skilldata.skillLevel[(skillId, rank)][0]'
                rtex = lookup.get(rid) if rid is not None else None
                rinfo = ex.export(rtex, os.path.join('skills', 'ranks', f'{sid}_{r}.png')) if rtex else None
                if rinfo:
                    rinfo.update({'rank': r, 'source': src})
                    ranks.append(rinfo)
                else:
                    manifest['missing'].append({'skill': sid, 'rank': r, 'texture': rtex})
            rec['ranks'] = ranks
            if ab is not None and ranks:
                rec['sameAsAbilityRank1'] = ranks[0]['texture'] == rec.get('texture')
        manifest['skills'][str(sid)] = rec

    # ---- classes
    class_icons = {suffix(k): v for k, v in gameuiutil.get('kCharacterClassIcons', {}).items()}
    for name, cid in sorted(((k, v) for k, v in charclass.items() if isinstance(v, int)), key=lambda x: x[1]):
        tdef = class_icons.get(name)
        d = texdefs.get(tdef) if tdef else None
        info = ex.export(d['name'], os.path.join('classes', f'{cid}.png'), d['region']) if d else None
        rec = {'key': name, 'textureDef': tdef}
        if info:
            rec.update(info)
            rec['source'] = ('gameuiutil.kCharacterClassIcons[classId] (LoadCharacterClassIcon) -> '
                             'textureDef in Tabula_Rasa_UI_EXPORT.xml')
        else:
            manifest['missing'].append({'class': cid, 'textureDef': tdef})
        manifest['classes'][str(cid)] = rec

    # ---- generic class-tree node states
    for color, meaning in (('blue', 'current class or in its lineage'),
                           ('red', 'not reachable from current class'),
                           ('grey', 'reachable from current class')):
        for variant in ('', '_hl', '_down', '_disabled'):
            tid = f'skills_tree_{color}{variant}'
            d = texdefs.get(tid)
            info = ex.export(d['name'], os.path.join('classes', 'tree_states', f'{tid}.png'), d['region']) if d else None
            if info:
                info['meaning'] = meaning
                manifest['class_tree_states'][tid] = info

    manifest['notes'] = [
        'Skill files are named by numeric skill id (skilldata.skillData keys); "key" is the T#_CLASS_NAME constant.',
        'skills/<id>.png is the row icon the skills window shows (LoadSkillIcon(skillId, 0)). '
        'skills/ranks/<id>_<rank>.png are the per-rank pump icons beside it: for ability skills '
        '(abilityId != null) these are ability icons (LoadAbilityIcon(abilityId, rank)), otherwise skill level icons.',
        'Class emblems are the 64x64 ClassTree.ClassIcon bitmap (Icon_Class_* textureDefs). The class tree itself '
        'draws every class node with the same generic 15x15 buttons; those states are in classes/tree_states/.',
        'Texture names resolve by file name across all data/**/*.glm; catalogs.glm (.cat entity dependency lists) '
        'is not involved in UI icon lookup.',
    ]
    with open(os.path.join(args.out_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1)
    print(f"skills {sum('texture' in v for v in manifest['skills'].values())}/{len(manifest['skills'])}, "
          f"classes {sum('texture' in v for v in manifest['classes'].values())}/{len(manifest['classes'])}, "
          f"missing {len(manifest['missing'])}")
    if not args.no_sheet:
        contact_sheet(manifest, args.out_dir)


def contact_sheet(manifest, out_dir):
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype('arial.ttf', 11)
    except OSError:
        font = ImageFont.load_default()
    cell_w, icon, cols, pad = 150, 64, 8, 6

    def checker(w, h, s=8):
        bg = Image.new('RGBA', (w, h), (40, 40, 40, 255))
        d = ImageDraw.Draw(bg)
        for y in range(0, h, s):
            for x in range(0, w, s):
                if (x // s + y // s) % 2:
                    d.rectangle([x, y, x + s - 1, y + s - 1], fill=(60, 60, 60, 255))
        return bg

    def paste(sheet, path, x, y, size=icon):
        im = Image.open(os.path.join(out_dir, path)).convert('RGBA')
        if im.size[0] > size or im.size[1] > size:
            im.thumbnail((size, size))
        tile = checker(size, size)
        tile.alpha_composite(im, ((size - im.size[0]) // 2, (size - im.size[1]) // 2))
        sheet.paste(tile, (x, y))

    skills = sorted(manifest['skills'].items(), key=lambda kv: int(kv[0]))
    classes = sorted(manifest['classes'].items(), key=lambda kv: int(kv[0]))
    rank_rows = [(k, v) for k, v in skills if v.get('ranks')]
    cell_h = icon + 34
    rows_s = -(-len(skills) // cols)
    rows_c = -(-len(classes) // cols)
    rank_h = 40
    width = cols * cell_w + 2 * pad
    height = 30 + rows_s * cell_h + 30 + rows_c * cell_h + 30 + len(rank_rows) * rank_h + pad
    sheet = Image.new('RGBA', (width, height), (20, 22, 26, 255))
    d = ImageDraw.Draw(sheet)
    y = pad
    d.text((pad, y), 'Skills (skills/<id>.png, as shown in the skills window row)', fill='white', font=font)
    y += 24
    for i, (sid, v) in enumerate(skills):
        x, yy = pad + (i % cols) * cell_w, y + (i // cols) * cell_h
        if 'file' in v:
            paste(sheet, v['file'], x + (cell_w - icon) // 2, yy)
        d.text((x + 2, yy + icon + 2), f"{sid}{' (ability %s)' % v['abilityId'] if v['abilityId'] else ''}",
               fill=(255, 220, 120), font=font)
        d.text((x + 2, yy + icon + 15), v['key'][3:][:24].lower(), fill=(200, 200, 200), font=font)
    y += rows_s * cell_h + 6
    d.text((pad, y), 'Classes (classes/<id>.png)', fill='white', font=font)
    y += 24
    for i, (cid, v) in enumerate(classes):
        x, yy = pad + (i % cols) * cell_w, y + (i // cols) * cell_h
        if 'file' in v:
            paste(sheet, v['file'], x + (cell_w - icon) // 2, yy)
        d.text((x + 2, yy + icon + 2), f'{cid} {v["key"].lower()}', fill=(255, 220, 120), font=font)
    y += rows_c * cell_h + 6
    d.text((pad, y), 'Per-rank pump icons (skills/ranks/<id>_<rank>.png)', fill='white', font=font)
    y += 24
    for sid, v in rank_rows:
        d.text((pad, y + 12), f'{sid} {v["key"][3:][:22].lower()}', fill=(200, 200, 200), font=font)
        for j, r in enumerate(v['ranks']):
            paste(sheet, r['file'], pad + 190 + j * 38, y, 34)
        y += rank_h
    sheet.save(os.path.join(out_dir, 'contact_sheet.png'))


if __name__ == '__main__':
    main()
