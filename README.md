# IRPlanner

**Infinite Rasa Planner**: a career and character planner for **Tabula Rasa**, built for servers running the final retail client (**1.16.5.0**). You can plan any number of characters, each with any number of builds: level, class path, skill ranks and attribute points. Everything is stored in your browser.

## Features

- **Characters and builds:** several characters, each with its own race and several builds. You can duplicate, rename and delete either.
- **Career tree:** all 15 classes and their unlock levels (1 / 5 / 15 / 30), with checks when a build's level is too low for its class.
- **Skills:** all 73 skills with their real per-rank text from the client, the Logos each ability needs, and skill-point costs.
- **Attributes:** race growth per level, free attribute points, and the derived health, power, regeneration, armor, Logos damage and crit bonuses.
- **Sharing:** share a build as a code or link. You can back up and restore all your plans as a JSON file.
- **Storage:** plans live in `localStorage`, so they stay until you clear site data. If storage is blocked, the app still works but warns you to use Backup.

## Where the data comes from

The planner's data comes from two places:
- **The game client:** everything the in-game skills window can show on its own, plus the retail attribute rates.
- **The server:** the progression rules. The server decides how many points you get and what your stats are, and sends the client the results, so the client doesn't contain them.

### From the client (1.16.5.0)

These are read straight from the client's files and code by the scripts in `tools/`. Nothing is typed in by hand.

| What | Where in the client |
|---|---|
| Career tree: the 15 classes, which class leads to which, unlock levels 1 / 5 / 15 / 30 | `generated/client/characterclass`, `client/gameuiutil` (`g_ClassTree`), `generated/client/skilldata` (`skillCharacter`) |
| Races: Human, Forean, Brann and Thrax hybrids | `generated/client/constant/race` and the English race names |
| Max level (50) and the XP needed for each level | `generated/client/character` (`experienceTable`) |
| The 73 skills: which class they belong to, max rank, names, descriptions and per-rank text | `generated/client/skilldata` and the English UI text (`uielementlanguage`) |
| Abilities: each rank's name and tooltip, power and adrenaline cost, range, activation and cooldown | `generated/client/abilitydata` and `actiondata` |
| Ability damage and healing at the build's level | The client's own tooltip code, ported: `GetAbilityDataDict` and `shared/scaling` (`ScaleActorAmount`); see `tools/ABILITY_TOOLTIPS.md` |
| Logos each ability needs | `generated/client/logosstone` (`logosSequences`) |
| Rank cost: raising a skill to rank N costs N points | The skills window code: `client/ui/skillsabilitieswindow` (`OnPlus`) |
| Retail attribute rates: 1% armor per 1.5 Body, 1% Logos damage per 3 Mind, 1% crit per 15 Spirit, 5% base crit | `shared/gameconstants` (`BODY_ARMOR_DIVISOR`, `MIND_DAMAGE_DIVISOR`, `SPIRIT_CRIT_DIVISOR`, `BASE_CRITICAL_CHANCE`). The client defines these but never reads them; they were for the retail server. |
| Skill, per-rank and class icons | UI textures in `data/*.glm`, picked the way the skills window picks them (`GetSkillIcon`, `GetAbilityIcon`, `LoadCharacterClassIcon`) |

The output is `js/data/gamedata.js`, the icons in `img/`, and the tooltip formatting in `js/abilityscale.js`.

### From the server (Rasa.NET)

These numbers are not in the client at all. The planner follows the [Rasa.NET](https://github.com/InfiniteRasa/Rasa.NET) server (`ManifestationManager.cs`, development branch), because that's what Infinite Rasa runs.

| What | Rule |
|---|---|
| Training points | 2 per level after level 1, plus 5 for the starting Recruit ranks, plus 2 at levels 5, 15 and 30, plus 4 at level 50 (69 at level 30, 113 at level 50) |
| Starting skills | New characters have Firearms, Hand to Hand, Motor Assist Armor, Lightning and Sprint at rank 1. Those ranks can't be removed. |
| Signature skills | Granted free with the Tier IV class. They can't be trained and cost no points. |
| Attribute points | 3 per level after level 1 |
| Race growth per level (Body / Mind / Spirit) | Human 2/2/2, Forean 1/3/2, Brann 1/1/4, Thrax 3/1/2, from a base of 10/10/10 |
| Health and regeneration | Rasa.NET's formulas (`UpdateStatsValues`), with no gear or buffs |
| Power | 100, plus 8 per level after level 1, plus 3 per point spent on Mind. Race Mind growth doesn't count. |
| Armor bonus | Multiplies the armor you wear by 1 + 0.66666% per point of total Body |
| Crit chance | 5% plus 1% per 15 Spirit above a human's base for that level (`CriticalHits.cs`) |
| Logos damage | **Not applied by Rasa.NET yet.** The planner shows the retail rate from the client, above a human's base for that level. |
| Adrenaline | A fixed 1000-point bar for everyone, so it isn't a planner stat |

All of these live in `js/rules.js`, with a source note on each one. Apart from the client's rates, they are the emulator's reconstruction: the original retail server's formulas were never published, and Rasa.NET's Power line is marked as a test in its source. If your server uses different numbers, `js/rules.js` is the only file to change.

## Tests

Open `tests/index.html` from a local server, or at `/tests/` on the live site. It checks the rules against:
- `tests/server_stats.json`: output of the real Rasa.NET code (commit `6394cc3`) for every race and level, covering stats, crit, point budgets and ability scaling.
- `tests/expected_stats.json`: an independent version of the server's 32-bit float math.
- The rows in Rasa.NET's own unit tests.

It also checks the client data, class gating, damaged imports, share codes and ability tooltips.

To refresh after a server change:
1. Copy `tools/PlannerDumpTests.cs` into `src/Rasa.Test/Gameplay/` in a Rasa.NET checkout.
2. From that checkout, run the command below with `PLANNER_DUMP` set to `tests/server_stats.json`.
3. Update the commit named in `tests/tests.js` and in this list.

```bash
dotnet test src/Rasa.Test/Rasa.Test.csproj --filter "FullyQualifiedName~PlannerDumpTests"
```

To rebuild the float reference (it reads the health table from the server source; needs numpy):

```bash
python -I tools/gen_expected_stats.py path/to/ManifestationManager.cs
```

## Regenerating the game data and icons

You need Python 3.9 or later; Python 2.4 is not required. `tools/pyo24.py` reads the client's Python 2.4 bytecode directly. The icon script also needs Pillow (`pip install Pillow`).

```bash
python -I tools/build_data.py "C:/path/to/Tabula Rasa 1.16.5.0"
```

```bash
python -I tools/extract_icons.py "C:/path/to/Tabula Rasa 1.16.5.0" img --format webp --no-sheet
```

The scripts only read the client files and never run them.

## Running locally

ES modules need an HTTP server, so opening the file directly won't work:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Hosting

The site is static with no build step, and every path is relative. It works at a domain root and under a sub-path.

**GitHub Pages**
1. Go to **Settings → Pages**.
2. Set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The repo includes `.nojekyll`, so files are served as-is.

**Cloudflare Pages**
1. Go to **Workers & Pages → Create → Pages → Connect to Git** and pick this repo.
2. Set Framework preset to **None**, leave Build command empty, and set Build output directory to `/`.

## License

Made by [Ar0xA](https://github.com/Ar0xA). The code is under the [MIT License](LICENSE), so other projects (Rasa.NET's website, for example) are welcome to use and adapt it.

If you do, a credit and link back to this repo (https://github.com/Ar0xA/IRPlanner) is appreciated. Keeping the "Made by Ar0xA" line in the footer is the easiest way.

The license covers the planner's code and docs only, not Tabula Rasa game content (the text in `js/data/gamedata.js` and the icons in `img/`).

## Disclaimer

This is a fan-made tool. It is not affiliated with NCsoft or Destination Games. Tabula Rasa, its game text and its icons belong to their respective owners.
