"""Derive per-pump ability tooltip token specs, mirroring the TR 1.16.5.0 client.

Reads the JSON dumps of the client's generated data modules (made with pyo24.py dump) and
writes ability_tokens.json. Logic ported from bytecode; see ABILITY_TOOLTIPS.md.

  python -I tools/ability_tokens.py <scratch dir containing dump/> [out.json]

Output:
  { "abilities": { "<abilityId>": { "<pump>": { "<token>": "<display string>"
                                                | {"scale": <scaleTypeId>, "base": <int>} } } },
    "maxPump": { "<abilityId>": <max trainable pump from skilldata> },
    "leftVerbatim": [[abilityId, pump, token, reason], ...],   # client prints "${token}" as-is
    "unresolved": [[abilityId, pump, token, reason], ...] }
Only tokens that occur in the pump's description text are emitted.
"""
import json
import os
import re
import sys

# shared/scaling.pyo
SCALE_ACTOR_LINEAR = 1
SCALE_ACTOR_EXP = 2

# client/system/string.pyo: Template.delimiter='$', idpattern='[_a-z][_a-z0-9]*',
# compiled with re.IGNORECASE | re.VERBOSE.
TEMPLATE_RE = re.compile(r'\$(?:(?P<escaped>\$)|(?P<named>[_a-z][_a-z0-9]*)|'
                         r'\{(?P<braced>[_a-z][_a-z0-9]*)\}|(?P<invalid>))', re.I)


# ---- Python 2.4 value semantics (the dumps were loaded with Python 3) ----

def py2_div(a, b):
    """Python 2 '/' : floor division when both operands are ints."""
    if isinstance(a, int) and isinstance(b, int):
        return a // b
    return a / b


def py24_str(v):
    """'%s' % v as Python 2.4 on Windows would print it."""
    if v is None:
        return 'None'
    if isinstance(v, bool):
        return 'True' if v else 'False'
    if isinstance(v, int):
        return '%d' % v
    if isinstance(v, float):
        # floatobject.c format_float: "%.12g", then append ".0" if only digits remain.
        s = '%.12g' % v
        m = re.match(r'^(.*e[+-])(\d+)$', s)
        if m:  # MSVC CRT prints at least 3 exponent digits (inferred, not in bytecode)
            s = m.group(1) + m.group(2).rjust(3, '0')
        body = s[1:] if s.startswith('-') else s
        if body.isdigit():
            s += '.0'
        return s
    return str(v)


def py24_pct_d(v):
    """'%d' % v (floats truncate toward zero)."""
    return '%d' % int(v)


def long_form(t):
    """'%(H)d:%(M)02d' % {'H': int(t / 60), 'M': int(t) % 60}   (baseactorability.pyo)"""
    return '%d:%02d' % (int(py2_div(t, 60)), int(t) % 60)


# ---- client logic ----

def none_fix(v):
    return None if v == 'None' else v   # pyo24 dump renders LOAD_NAME None as the string 'None'


class Scaled:
    def __init__(self, base, scale):
        self.base, self.scale = base, scale


def scale_actor_amount(base, scale):
    """shared.scaling.ScaleActorAmount, deferred when it depends on the actor's level."""
    if base is None:
        return None
    if scale in (SCALE_ACTOR_LINEAR, SCALE_ACTOR_EXP):
        if base == 0:
            return 0          # int(0 * anything) == 0
        return Scaled(base, scale)
    return base               # any other scale type: amount returned unchanged


def ability_data_dict(module, args, attr_cost, props, prop_names, POWER):
    """BaseActorAbility.GetAbilityDataDict + the two subclass overrides (lightning, sprint)."""
    d = {}
    # TargetedAction.checkRange = 1 (no player ability class overrides it)
    # BaseActorAction.GetMaxRange -> actions.GetMaxRange: info.maxRange (actionArguments[4]);
    # rangeEffects is a hard-coded empty tuple.
    d['range'] = args[4]
    # BaseActorAction.GetWindupTimeMs: max(0, info.windupDelayMs = actionArguments[0])
    # (Python 2: max(0, None) == 0, since None sorts below every number)
    w = 0 if args[0] is None else max(0, args[0])
    d['activationTime'] = py2_div(w, 1000.0)
    # GetReuseTimeMs -> Actor.GetActorActionReuseTimeMs: actionArguments[5] times the reuse
    # modifier of any CALLED_SHOT_ARM effects on the actor (assumed none).
    r = args[5]
    if r is None or r < 0:
        r = 0
    d['cooldownTime'] = py2_div(r, 1000.0)
    # info.GetPowerCost(): first attributeCost entry with attrId == POWER, else None
    base_cost = next((c for a, c in attr_cost if a == POWER), None)
    d['powerCost'] = scale_actor_amount(base_cost, props.get(prop_names['CONSUMABLE_SCALE_TYPE']))
    for pid, v in props.items():
        d[prop_names['byvalue'][str(pid)]] = v   # _abilityproperty.byvalue[propertyId]
    st = props.get(prop_names['DAMAGE_SCALE_TYPE'])
    g = lambda name: props.get(prop_names[name], 0)
    d['scaledDamageMin'] = scale_actor_amount(g('DAMAGE_AMOUNT_MIN'), st)
    d['scaledDamageMax'] = scale_actor_amount(g('DAMAGE_AMOUNT_MAX'), st)
    d['scaledHealingMin'] = scale_actor_amount(g('HEAL_AMOUNT_MIN'), st)   # uses DAMAGE_SCALE_TYPE
    d['scaledHealingMax'] = scale_actor_amount(g('HEAL_AMOUNT_MAX'), st)
    ed = props.get(prop_names['EFFECT_DURATION_MS'])
    if ed is not None:
        ed = py2_div(ed, 1000)
        d['effectDurationLongForm'] = long_form(ed)
        d['effectDurationShortForm'] = py24_pct_d(ed)
    dur = props.get(prop_names['DURATION'])
    dms = props.get(prop_names['DURATION_MS'])
    if dms is not None:
        dur = py2_div(dms, 1000)
    if dur is not None:
        d['durationLongForm'] = long_form(dur)
        d['durationShortForm'] = py24_pct_d(dur)
    cl = props.get(prop_names['CREATURE_LIFETIME_MS'])
    if cl is not None:
        cl = py2_div(cl, 1000.0)
        d['creatureLifetimeLongForm'] = long_form(cl)
        d['creatureLifetimeShortForm'] = py24_pct_d(cl)

    if module == 'abilities.lightning':            # LightningAbility.GetAbilityDataDict
        si = props.get(prop_names['EFFECT_INTERVAL_MS'])
        if si is not None:
            d['stormInterval'] = py2_div(si, 1000)
        d['stormDamageMin'] = scale_actor_amount(g('EFFECT_DAMAGE_MIN'), st)
        d['stormDamageMax'] = scale_actor_amount(g('EFFECT_DAMAGE_MAX'), st)
        d['arcDamage'] = scale_actor_amount(g('ARC_DAMAGE'), st)
    elif module == 'abilities.sprint':             # SprintAction.GetAbilityDataDict
        drain = props.get(prop_names['DRAIN_PER_TICK_ADRENALINE'])
        interval = props.get(prop_names['INTERVAL'])
        if drain is None or interval is None:
            d['__keyerror__'] = 'SprintAction: p[DRAIN_PER_TICK_ADRENALINE]/p[INTERVAL] missing'
        else:
            d['adrenPerSec'] = py2_div(drain, interval * 10.0)
    return d


def main(S=None, out=None):
    S = S or sys.argv[1]
    out = out or (sys.argv[2] if len(sys.argv) > 2 else os.path.join(S, 'ability_tokens.json'))
    ld = lambda n: json.load(open(os.path.join(S, 'dump', n), encoding='utf-8'))
    abd, acd = ld('abilitydata.json'), ld('actiondata.json')
    prop_names = ld('abilityproperty.json')
    POWER = ld('actor.json')['POWER']
    skills = ld('skilldata.json')['skillData']
    lookup = ld('language_english_uielementlanguage.json')['lookup']

    players = abd['skillRequirements']           # abilityId -> [skillId]
    result, left, unresolved, maxpump = {}, [], [], {}
    for aid_s, sk in sorted(players.items(), key=lambda kv: int(kv[0])):
        aid = int(aid_s)
        maxpump[aid_s] = skills[str(sk[0])][4]
        module = acd['actionModules'][aid_s][1]
        pumps = sorted(eval(k)[1] for k in abd['abilities'] if eval(k)[0] == aid)
        for pump in pumps:
            key = '(%d, %d)' % (aid, pump)
            desc_id = abd['abilities'][key][2]
            # BuildModuleText: uielementlanguage is gender-keyed (textKey, g_Gender);
            # both genders are identical in this dump.
            text = lookup.get('(%d, 1)' % desc_id, [None])[0]
            if text is None:
                unresolved.append([aid, pump, None, 'description text %d missing' % desc_id])
                continue
            tokens = []
            for m in TEMPLATE_RE.finditer(text):
                t = m.group('named') or m.group('braced')
                if t and t not in tokens:
                    tokens.append(t)
            if not tokens:
                continue
            args = acd['actionArguments'].get(key)
            if args is None:
                args = [0, None, 0, None, 1, 0, 0, 0]  # GetActorActionInfo fallback
                props, cost = {}, []
            else:
                args = [none_fix(x) for x in args]
                # JSON object keys are strings; the client dict is keyed by int property id
                props = {int(k): v for k, v in acd['abilityData'].get(key, {}).items()}
                cost = acd['actionAttributeCost'].get(key, [])
            d = ability_data_dict(module, args, cost, props, prop_names, POWER)
            spec = {}
            for t in tokens:
                if '__keyerror__' in d:
                    unresolved.append([aid, pump, t, d['__keyerror__'] +
                                       ' -> GetAbilityDescription returns an error text'])
                    continue
                if t not in d:
                    left.append([aid, pump, t, 'not in GetAbilityDataDict for this pump; '
                                 'safe_substitute leaves it verbatim'])
                    continue
                v = d[t]
                if isinstance(v, Scaled):
                    spec[t] = {'scale': v.scale, 'base': v.base}
                elif isinstance(v, str):
                    spec[t] = v
                else:
                    spec[t] = py24_str(v)
            result.setdefault(aid_s, {})[str(pump)] = spec

    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'abilities': result, 'maxPump': maxpump, 'leftVerbatim': left,
                   'unresolved': unresolved}, f, indent=1, ensure_ascii=False)
    n_tok = sum(len(s) for p in result.values() for s in p.values())
    n_scaled = sum(isinstance(v, dict) for p in result.values() for s in p.values() for v in s.values())
    print('abilities %d, pumps %d, resolved tokens %d (%d level-scaled), left verbatim %d, '
          'unresolved %d -> %s' % (len(result), sum(len(p) for p in result.values()), n_tok,
                                   n_scaled, len(left), len(unresolved), out))


if __name__ == '__main__':
    main()
