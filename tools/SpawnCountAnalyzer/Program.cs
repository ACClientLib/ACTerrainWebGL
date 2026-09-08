using Microsoft.Data.Sqlite;

var database = args.Length > 0 ? args[0] : @"C:\Data\ace_world.db";
var samples = args.Length > 1 && int.TryParse(args[1], out var parsedSamples) ? parsedSamples : 1000;
var seed = args.Length > 2 && int.TryParse(args[2], out var parsedSeed) ? parsedSeed : 1337;
if (samples < 1) throw new ArgumentOutOfRangeException(nameof(samples));

using var connection = new SqliteConnection($"Data Source={Path.GetFullPath(database)};Mode=ReadOnly");
connection.Open();

var instances = ReadInstances(connection);
var links = ReadLinks(connection);
var definitions = ReadGeneratorDefinitions(connection);
var encounters = ReadEncounters(connection);
var childrenByParent = links.GroupBy(link => link.Parent).ToDictionary(g => g.Key, g => g.Select(x => x.Child).ToArray());
var exterior = instances.Values.Where(x => IsExterior(x.Cell)).ToArray();
var generatorRoots = exterior.Where(x => x.IsGenerator).ToArray();
var baseline = exterior.Count(x => !x.IsGenerator);

var currentGeneratorChildren = 0;
foreach (var root in generatorRoots)
    currentGeneratorChildren += CountExteriorChildren(root.Guid, childrenByParent, instances);

var sampleTotals = new long[samples];
for (var sample = 0; sample < samples; sample++)
{
    var random = new Random(unchecked(seed + sample));
    foreach (var root in generatorRoots)
        if (definitions.TryGetValue(root.ClassId, out var definition))
            sampleTotals[sample] += definition.SampleInitialCount(random);
    foreach (var encounter in encounters)
        if (definitions.TryGetValue(encounter.ClassId, out var definition))
            sampleTotals[sample] += definition.SampleInitialCount(random);
}

var totalMean = sampleTotals.Average();
var min = sampleTotals.Min();
var max = sampleTotals.Max();
var encounterMean = 0.0;
foreach (var encounter in encounters)
{
    if (!definitions.TryGetValue(encounter.ClassId, out var definition)) continue;
    var total = 0L;
    for (var sample = 0; sample < samples; sample++)
        total += definition.SampleInitialCount(new Random(unchecked(seed + sample + (int)encounter.Id)));
    encounterMean += (double)total / samples;
}
var generatorMean = totalMean - encounterMean;
var generatorNet = generatorMean - currentGeneratorChildren;
var addedMean = encounters.Count + generatorNet;

Console.WriteLine($"World database: {Path.GetFullPath(database)}");
Console.WriteLine($"Samples: {samples} (seed {seed})");
Console.WriteLine($"Baseline exterior placements already represented: {baseline:N0}");
Console.WriteLine($"Exterior generator roots: {generatorRoots.Length:N0}; current exterior generator children: {currentGeneratorChildren:N0}");
Console.WriteLine($"Encounter rows: {encounters.Count:N0}");
Console.WriteLine($"Sampled initial generated objects (generators + encounters): mean {totalMean:N1}, range {min:N0}-{max:N0}");
Console.WriteLine($"Estimated sampled generator-only net addition after existing children: {generatorNet:N1}");
Console.WriteLine($"Estimated total world-map spawn additions: mean {addedMean:N1}");
Console.WriteLine("Dungeon rows/cells are excluded. Encounter rows with no generator definition contribute one encounter row but zero generated-object estimate.");

static bool IsExterior(uint cell) => (cell & 0xffff) < 0x100;

static int CountExteriorChildren(uint parent, IReadOnlyDictionary<uint, uint[]> children, IReadOnlyDictionary<uint, Instance> instances)
{
    if (!children.TryGetValue(parent, out var childIds)) return 0;
    var count = 0;
    foreach (var childId in childIds)
    {
        if (!instances.TryGetValue(childId, out var child)) continue;
        if (IsExterior(child.Cell)) count++;
        count += CountExteriorChildren(child.Guid, children, instances);
    }
    return count;
}

static Dictionary<uint, Instance> ReadInstances(SqliteConnection connection)
{
    using var command = connection.CreateCommand();
    command.CommandText = """
        SELECT li.guid, li.obj_Cell_Id, li.weenie_Class_Id, li.is_Link_Child,
               CASE WHEN EXISTS (SELECT 1 FROM weenie_properties_generator g WHERE g.object_Id = li.weenie_Class_Id) THEN 1 ELSE 0 END
        FROM landblock_instance li;
        """;
    using var reader = command.ExecuteReader();
    var result = new Dictionary<uint, Instance>();
    while (reader.Read())
    {
        var guid = Convert.ToUInt32(reader.GetInt64(0));
        result.Add(guid, new Instance(guid, Convert.ToUInt32(reader.GetInt64(1)),
            Convert.ToUInt32(reader.GetInt64(2)), Convert.ToInt32(reader.GetValue(3)) != 0,
            Convert.ToInt32(reader.GetValue(4)) != 0));
    }
    return result;
}

static List<Link> ReadLinks(SqliteConnection connection)
{
    using var command = connection.CreateCommand();
    command.CommandText = "SELECT parent_GUID, child_GUID FROM landblock_instance_link;";
    using var reader = command.ExecuteReader();
    var result = new List<Link>();
    while (reader.Read()) result.Add(new Link(Convert.ToUInt32(reader.GetInt64(0)), Convert.ToUInt32(reader.GetInt64(1))));
    return result;
}

static List<Encounter> ReadEncounters(SqliteConnection connection)
{
    using var command = connection.CreateCommand();
    command.CommandText = "SELECT id, weenie_Class_Id FROM encounter;";
    using var reader = command.ExecuteReader();
    var result = new List<Encounter>();
    while (reader.Read()) result.Add(new Encounter(Convert.ToUInt32(reader.GetInt64(0)), Convert.ToUInt32(reader.GetInt64(1))));
    return result;
}

static Dictionary<uint, GeneratorDefinition> ReadGeneratorDefinitions(SqliteConnection connection)
{
    using var command = connection.CreateCommand();
    command.CommandText = """
        SELECT g.object_Id, g.probability, g.init_Create, g.max_Create,
               COALESCE(initObjects.value, 0), COALESCE(maxObjects.value, 0)
        FROM weenie_properties_generator g
        LEFT JOIN weenie_properties_int initObjects ON initObjects.object_Id = g.object_Id AND initObjects.type = 82
        LEFT JOIN weenie_properties_int maxObjects ON maxObjects.object_Id = g.object_Id AND maxObjects.type = 81
        ORDER BY g.object_Id, g.id;
        """;
    using var reader = command.ExecuteReader();
    var result = new Dictionary<uint, GeneratorDefinition>();
    while (reader.Read())
    {
        var classId = Convert.ToUInt32(reader.GetInt64(0));
        if (!result.TryGetValue(classId, out var definition))
        {
            var profileInit = Convert.ToInt32(reader.GetValue(2));
            var profileMax = Convert.ToInt32(reader.GetValue(3));
            var init = Convert.ToInt32(reader.GetValue(4));
            var max = Convert.ToInt32(reader.GetValue(5));
            if (init <= 0) init = profileInit == -1 ? 1 : profileInit;
            if (max <= 0) max = profileMax == -1 ? init : profileMax;
            definition = new GeneratorDefinition(init, max);
            result.Add(classId, definition);
        }
        definition.Profiles.Add(new Profile(Convert.ToDouble(reader.GetValue(1)), Convert.ToInt32(reader.GetValue(2)), Convert.ToInt32(reader.GetValue(3))));
    }
    return result;
}

readonly record struct Instance(uint Guid, uint Cell, uint ClassId, bool IsLinkChild, bool IsGenerator);
readonly record struct Link(uint Parent, uint Child);
readonly record struct Encounter(uint Id, uint ClassId);

sealed class GeneratorDefinition(int initCreate, int maxCreate)
{
    public int InitCreate { get; } = initCreate;
    public int MaxCreate { get; } = maxCreate;
    public List<Profile> Profiles { get; } = [];

    public int SampleInitialCount(Random random)
    {
        if (InitCreate <= 0 || MaxCreate <= 0 || Profiles.Count == 0) return 0;
        var current = 0;
        var counts = new int[Profiles.Count];
        var available = Enumerable.Range(0, Profiles.Count).ToList();
        while (current < InitCreate && current < MaxCreate && available.Count > 0)
        {
            var guaranteed = available.FirstOrDefault(i => Profiles[i].Probability == -1, -1);
            var chosen = guaranteed >= 0 ? guaranteed : SelectProfile(available, random);
            if (chosen < 0) break;
            var profile = Profiles[chosen];
            var count = profile.InitCreate == -1 || profile.MaxCreate == -1 ? 1 : profile.InitCreate;
            count = Math.Min(count, Math.Min(InitCreate - current, MaxCreate - current));
            if (profile.MaxCreate != -1) count = Math.Min(count, profile.MaxCreate - counts[chosen]);
            if (count <= 0) { available.Remove(chosen); continue; }
            current += count;
            counts[chosen] += count;
            if (profile.MaxCreate != -1 && counts[chosen] >= profile.MaxCreate) available.Remove(chosen);
        }
        return current;
    }

    private int SelectProfile(List<int> available, Random random)
    {
        var weights = new double[available.Count];
        var last = 0.0;
        var total = 0.0;
        for (var i = 0; i < available.Count; i++)
        {
            var probability = Profiles[available[i]].Probability;
            if (last > probability) last = 0;
            weights[i] = Math.Max(0, probability - last);
            total += weights[i];
            last = probability;
        }
        if (total <= 0) return -1;
        var roll = random.NextDouble() * total;
        for (var i = 0; i < weights.Length; i++)
        {
            if (roll < weights[i]) return available[i];
            roll -= weights[i];
        }
        return -1;
    }
}

readonly record struct Profile(double Probability, int InitCreate, int MaxCreate);
