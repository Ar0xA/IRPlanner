"""Generate tests/expected_stats.json: an independent reference for js/rules.js.

Repeats Rasa.NET's UpdateStatsValues with real 32-bit floats (numpy) and reads the health table
from the server source itself, so the JavaScript is not being checked against itself.

  python -I tools/gen_expected_stats.py <path to ManifestationManager.cs>
"""
import json
import os
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GROWTH = {'human': (2, 2, 2), 'forean_hybrid': (1, 3, 2), 'brann_hybrid': (1, 1, 4), 'thrax_hybrid': (3, 1, 2)}
SPENDS = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), (3, 5, 7), (20, 10, 5), (0, 100, 0), (147, 0, 0), (49, 49, 49)]
f32 = np.float32


def half_even(x):
    return int(np.round(x))  # numpy rounds midpoints to even, like C# Math.Round


def main(source):
    text = open(source, encoding='utf-8').read()
    block = re.search(r'HealthBaselinePerLevel\s*=\s*\{(.*?)\}', text, re.S).group(1)
    table = [f32(v) for v in re.findall(r'([0-9.]+)f', block)]
    assert len(table) == 50, len(table)
    rows = []
    for race, (gb, gm, gs) in GROWTH.items():
        for level in range(1, 51):
            for sb, sm, ss in SPENDS:
                if sb + sm + ss > 3 * (level - 1):
                    continue
                body = gb * (level - 1) + 10 + sb
                mind = gm * (level - 1) + 10 + sm
                spirit = gs * (level - 1) + 10 + ss
                human = 2 * (level - 1) + 10
                divisor = 2 * (level - 1) + 2 * human + 10
                per_health = f32(table[level - 1] / f32(divisor))
                health = max(1, int(f32(per_health * f32(spirit + 2 * body))))
                per_regen = f32(f32(2 * level + 100) / f32(divisor))
                regen = int(f32(per_regen * f32(mind + 2 * spirit)))
                rows.append({
                    'race': race, 'level': level, 'spent': [sb, sm, ss],
                    'body': body, 'mind': mind, 'spirit': spirit, 'health': health,
                    'power': 100 + (level - 1) * 2 * 4 + sm * 3,
                    'regen': regen, 'regenPerSecond': half_even(2.0 * regen / 100),
                    'armorBonus': body * 0.0066666 * 100,
                    'logosBonus': max(0, mind - human) / 3.0,
                    'critChance': 5 + max(0, spirit - human) / 15.0,
                })
    out = os.path.join(ROOT, 'tests', 'expected_stats.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(rows, f, separators=(',', ':'))
    print(len(rows), 'rows ->', out)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
