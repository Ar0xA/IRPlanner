// Fills an ability pump's tooltip template (${token}) at a character level, as the client does:
// token specs come from tools/ability_tokens.py (embedded in gamedata), scaling and formatting
// from abilityscale.js (ports of the client's GetAbilityDataDict / ScaleActorAmount).
import { GAME } from './data/gamedata.js';
import { resolveTokens, fillTemplate } from './abilityscale.js';

export function abilityText(abilityId, pump, text, level) {
  const spec = GAME.abilities[abilityId]?.pumps[pump]?.tokens;
  return fillTemplate(text, resolveTokens(spec, level));
}
