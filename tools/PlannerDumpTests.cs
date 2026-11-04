using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Rasa.Test.Gameplay
{
    using Rasa.Data;
    using Rasa.Managers;

    // Temporary: records what the real server code produces, for comparison with IRPlanner.
    [TestClass, DoNotParallelize]
    public class PlannerDumpTests
    {
        [TestMethod]
        public void Dump()
        {
            var races = new (string Key, Race Race)[] {
                ("human", Race.Human), ("forean_hybrid", Race.Forean), ("brann_hybrid", Race.Brann), ("thrax_hybrid", Race.Thrax) };
            var spends = new[] { (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), (3, 5, 7), (20, 10, 5), (0, 100, 0), (147, 0, 0), (49, 49, 49), (0, 0, 147), (13, 37, 2) };
            var rows = new List<object>();

            foreach (var (key, race) in races)
                for (byte level = 1; level <= 50; level++)
                    foreach (var (b, m, s) in spends)
                    {
                        if (b + m + s > 3 * (level - 1))
                            continue;

                        using var context = new ProgressionTestContext();
                        var client = context.CreateClient(level, race);
                        var player = client.Player;
                        player.SpentBody = b;
                        player.SpentMind = m;
                        player.SpentSpirit = s;
                        ManifestationManager.Instance.UpdateStatsValues(client, true);
                        var a = player.Attributes;
                        rows.Add(new {
                            race = key, level = (int)level, spent = new[] { b, m, s },
                            body = a[Attributes.Body].Current, mind = a[Attributes.Mind].Current, spirit = a[Attributes.Spirit].Current,
                            health = a[Attributes.Health].CurrentMax, power = a[Attributes.Power].CurrentMax,
                            regen = a[Attributes.Regen].CurrentMax, regenPerSecond = (int)player.HealthRegenRate,
                            adrenaline = a[Attributes.Chi].CurrentMax,
                            critChance = CriticalHits.AttackerChance(player, false),
                            trainingLeft = ManifestationManager.Instance.GetSkillPointsAvailable(player),
                            attrLeft = ManifestationManager.Instance.GetAvailableAttributePoints(player),
                        });
                    }

            var scales = new List<object>();
            foreach (var baseAmount in new[] { 60, 90, 180, 210, 240, 300, 450, 600, 1000 })
                for (var level = 1; level <= 50; level++)
                    scales.Add(new { baseAmount, level, type2 = AbilityManager.Scale(level, baseAmount, 2), type1 = AbilityManager.Scale(level, baseAmount, 1) });

            var path = Environment.GetEnvironmentVariable("PLANNER_DUMP") ?? "planner_dump.json";
            File.WriteAllText(path, JsonSerializer.Serialize(new { rows, scales }));
        }
    }
}
