# Ability tooltip templates: how the TR 1.16.5.0 client fills them

Everything here was read from the client's Python 2.4 bytecode (disassembled with `tools/pyo24.py dis`).
Statements marked **(inferred)** were not read from bytecode. File paths are relative to the extracted
client (`client_tr/`, generated data in `client_game/generated/client/`).

## Call chain

`client/ui/tooltipwindow.pyo` → `gameuiutil.GetAbilityDescription(abilityId, pumpLevel=1, args=None)`
(`client/gameuiutil.pyo`):

1. `descriptionId = abilitydata.abilities[(abilityId, pump)][2]`
2. `description = clientlanguagemanager.BuildUIElement(descriptionId, None)`, which calls
   `BuildModuleText('uielementlanguage', id, None, None)`. The text comes from `lookup[(id, g_Gender)][0]`
   (uielementlanguage is gender-keyed, and genders 1 and 2 are identical in this dump). No `%` formatting
   runs, because args is None. `textfilter.FilterStaticText` only applies the profanity filter.
3. `actor = GetManifestation()` (the local player).
4. `ability = actions.CreateAbilityAction(actor, abilityId, pump, None)`
5. `return PerformTemplatedTokenSubstitution(description, ability.GetAbilityDataDict(actor))`.
   A `KeyError` anywhere in this chain returns the `ID_ERR_INVALID_ABILITY` error text instead.

## Picking the class (`client/actions/__init__.pyo`)

- `CreateAbilityAction` first applies `actor.GetAbilityOverride(abilityId)`, which looks the ID up in
  `Actor.__abilityOverrides` and falls back to `abilityId`. That table is runtime state set by
  `AddAbilityOverride`. **The planner assumes there are no overrides.** It then calls
  `CreateAction(actor.entityId, abilityId, pump, None, ...)`.
- `GetActionClass(id)` → `GetActionModule(id)`. It imports `'client.actions.' + actiondata.actionModules[id][1]`
  and reads the module attribute `ActionClass`. A missing module or class falls back to `client.actions.disabled`.
- `BaseActorAction.__init__` sets `self.info = GetActorActionInfo(actionId, argId)` with key `(id, pump)`:
  - `actionArguments[key]` = `[windupDelayMs, windupAnim, recoveryDelayMs, recoveryAnim, maxRange, reuseTimeMs, preload, startReuseTimerOnPerform]`.
    If the key is missing, the code uses `(0, None, 0, None, 1, 0, 0, 0)` with empty props and costs.
    Every player pump has an entry.
  - `attributeCost = actionAttributeCost.get(key, [])`, `props = abilityData.get(key, {})`.
- All 53 player ability classes (the keys of `abilitydata.skillRequirements`) derive from
  `BaseActorAbility` (`client/actions/abilities/baseactorability.pyo`), either directly or through `DamageBase`.
  - Only `lightning.pyo` and `sprint.pyo` override `GetAbilityDataDict`.
  - No player class overrides `ScaleActorAmount`, `GetWindupTimeMs`, `GetReuseTimeMs`, `GetMaxRange` or
    `checkRange`. Only `qaknowledge` overrides `checkRange`, and it is not a player ability.
  - The `__init__` overrides in `cure`, `firesupport` and `tacticalevasion` only set `canTargetDead`,
    `targetType` or `isHostile`.
  - `rushingblow` rewrites `windupTimeMs` only inside `Windup()`, which does not run for tooltips.

## `BaseActorAbility.GetAbilityDataDict(actor)`

`p = self.info.props`. The dict is built in this order:

| token | value |
|---|---|
| `range` | `GetMaxRange(actor)` → `actions.GetMaxRange`: `info.maxRange` (`actionArguments[4]`). The `rangeEffects` it loops over is a hard-coded empty tuple. Only written when `checkRange` is true, which holds for every player class. |
| `activationTime` | `max(0, info.windupDelayMs) / 1000.0` (`BaseActorAction.GetWindupTimeMs`), always a float |
| `cooldownTime` | `actor.GetActorActionReuseTimeMs(info) / 1000.0` = `reuseTimeMs` × the `GetReuseModifier` of any `CALLED_SHOT_ARM` effects on the actor (**assumed none**); `None` or negative becomes 0 |
| `powerCost` | `ScaleActorAmount(actor, info.GetPowerCost(), p.get(CONSUMABLE_SCALE_TYPE))`. `GetPowerCost` is the first cost with attr `POWER` (6), else `None`. No player pump has a `CONSUMABLE_SCALE_TYPE`, so this is the raw cost. With no Power cost (chi-only or free) it is `None`, which prints as `"None"`; that only happens on pumps 6–7 above the trainable max. The `GetAbilityCostModifier` and `MODULE_POWER_COST_MOD` adjustments only run in `CheckConsumables`, never in the tooltip. |
| `<PROPERTY_NAME>` | every prop, as `dataDict[abilityproperty.byvalue[id]] = rawValue` (for example `${EFFECT_RADIUS}`, `${DURATION}`) |
| `scaledDamageMin/Max` | `ScaleActorAmount(actor, p.get(DAMAGE_AMOUNT_MIN/MAX, 0), p.get(DAMAGE_SCALE_TYPE))` |
| `scaledHealingMin/Max` | same, from `HEAL_AMOUNT_MIN/MAX`. It **also uses `DAMAGE_SCALE_TYPE`**. |
| `effectDurationLongForm/ShortForm` | if `EFFECT_DURATION_MS`: `t = ms / 1000` (Python 2 int division) |
| `durationLongForm/ShortForm` | `t = DURATION`, overridden by `DURATION_MS / 1000` (int division) when that is present |
| `creatureLifetimeLongForm/ShortForm` | if `CREATURE_LIFETIME_MS`: `t = ms / 1000.0` (float) |

The forms are: LongForm `'%(H)d:%(M)02d' % {H: int(t / 60), M: int(t) % 60}` (so actually minutes:seconds),
and ShortForm `'%d' % t`.

Subclass additions:
- `LightningAbility` (`lightning.pyo`):
  - `stormInterval = EFFECT_INTERVAL_MS / 1000` (int division, only when the prop is present)
  - `stormDamageMin/Max` = scaled `EFFECT_DAMAGE_MIN/MAX`
  - `arcDamage` = scaled `ARC_DAMAGE`
  - all three use `DAMAGE_SCALE_TYPE`.
- `SprintAction` (`sprint.pyo`): `adrenPerSec = p[DRAIN_PER_TICK_ADRENALINE] / (p[INTERVAL] * 10.0)`. This
  raises `KeyError` if either prop is missing; every sprint pump has both.

## `shared/scaling.pyo`, `ScaleActorAmount(actor, base, scaleTypeId)`

The only actor input is `actor.GetExperienceLevel()`, which returns `Actor.__level`. **No attributes
(body, mind, spirit, etc.) are read anywhere on this path.**

- `base is None` → `None`
- `scaleTypeId == 1` (`SCALE_ACTOR_LINEAR`) → `int(base / 100.0 * (100 + (L - 1) * 100.0 / 3.0))`
- `scaleTypeId == 2` (`SCALE_ACTOR_EXP`) → `ScaleExponentialAmount(base, L - 1, 8.0)` = `int(base * pow(2, (L - 1) / 8.0))`
- otherwise → `base` unchanged

In player data, only `DAMAGE_SCALE_TYPE = 2` occurs, on 113 pumps. `int()` truncates toward zero.

## `clientlanguagemanager.PerformTemplatedTokenSubstitution(text, tokens)`

`unicode(string.Template(text).safe_substitute(tokens))`. `client/system/string.pyo` is the stock 2.4
stdlib:

- delimiter `$`, idpattern `[_a-z][_a-z0-9]*`, compiled with `re.IGNORECASE | re.VERBOSE`
- `$$` → `$`; both `$name` and `${name}` are replaced; unknown names and malformed `$` stay verbatim
- each value is printed with `'%s' % value`, which gives:
  - int → decimal digits
  - None → `None`
  - float → Python 2.4 `str(float)`: `%.12g`, then `.0` appended when only digits remain (so `0.0`, `1.2`, `5.0`, `1.35`)
  - **(inferred)** on the Windows build, exponents print with three digits (`1e+016`); tooltip values never reach that range.

## Planner data and code

- `tools/ability_tokens.py <scratch>` reads `<scratch>/dump/*.json` and writes `<scratch>/ability_tokens.json`:
  - `abilities[id][pump][token]` is either a display string (computed in Python with 2.4 semantics) or
    `{"scale": t, "base": n}` for level-dependent values.
  - It also writes `maxPump` (from `skilldata.skillData[skillId][4]`), plus `leftVerbatim` and `unresolved`.
  - The pyo24 dump writes `LOAD_NAME None` as the string `'None'`; the script converts it back.
- `js/abilityscale.js` provides `resolveTokens(spec, level, attributes)` and `fillTemplate(text, values)`.
  `attributes` is unused. It also exports `scaleActorAmount`, `pyStr` and `pyFloatStr`.
- Current numbers:
  - 53 abilities and 253 pumps with tokens (233 of them within the trainable max); 1585 token slots.
  - 244 slots are level-scaled.
  - 0 tokens are left verbatim and 0 are unresolved.
- Float safety: across levels 1–80 and every scaled base, the closest any `base * 2^((L-1)/8)` comes to an
  integer is 1.5e-8 relative. A 1-ulp difference in `pow` between the MSVC CRT and JS therefore cannot change
  any truncated result.
- The JS output was checked in headless Edge (V8) against Python on 1630 cases (scaling, float formatting,
  Template edge cases, full Lightning, Sprint and other renders), with 0 mismatches.

## Runtime state the tooltip can depend on but the planner ignores

- `actor.GetAbilityOverride` (polymorph-style swaps)
- `CALLED_SHOT_ARM` effects that change cooldown
- the actual character level (the planner supplies the level instead)
