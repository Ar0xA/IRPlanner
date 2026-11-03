# AFSPlanner

A career and character planner for **Tabula Rasa**, built for servers running the final retail client (**1.16.5.0**). You can plan any number of characters, each with any number of builds: level, class path, skill ranks and attribute points. Everything is stored in your browser.

## Features

- **Characters and builds:** several characters, each with its own race and several builds. You can duplicate, rename and delete either.
- **Career tree:** all 15 classes and their unlock levels (1 / 5 / 15 / 30), with checks when a build's level is too low for its class.
- **Skills:** all 73 skills with their real per-rank text from the client, the Logos each ability needs, and skill-point costs.
- **Attributes:** race growth per level, free attribute points, and the derived health, power, regeneration, armor, Logos damage and crit bonuses.
- **Sharing:** share a build as a code or link. You can back up and restore all your plans as a JSON file.
- **Storage:** plans live in `localStorage`, so they stay until you clear site data. If storage is blocked, the app still works but warns you to use Backup.

## Where the numbers come from

| What | Source |
|---|---|
| Classes, tree, unlock levels, races, XP table | Client data modules (`data/game.zip`: `generated/client/*`) |
| Skills, max ranks, names, per-rank and per-pump text, Logos sequences, ability costs | Client data modules plus English language tables |
| Rank cost (rank N costs N points) | Client bytecode: `client/ui/skillsabilitieswindow.pyo`, `OnPlus` |
| Ability tooltip numbers (damage, range, timings) | Client bytecode: the ability classes' `GetAbilityDataDict` (see `tools/`) |
| Skill point budget, attribute points, race growth, derived stats | Server-side rules, which the client never had. These follow the [Rasa.NET](https://github.com/InfiniteRasa/Rasa.NET) server: `ManifestationManager.cs` |

The generated data is in `js/data/gamedata.js` and the server rules are in `js/rules.js`, with a source note on each rule.

## Regenerating the game data

You need Python 3.9 or later; Python 2.4 is not required. `tools/pyo24.py` reads the client's Python 2.4 bytecode directly.

```bash
python -I tools/build_data.py "C:/path/to/Tabula Rasa 1.16.5.0"
```

The script only reads the client files and never runs them.

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

## Disclaimer

This is a fan-made tool. It is not affiliated with NCsoft or Destination Games. Tabula Rasa and its game text belong to their respective owners.
