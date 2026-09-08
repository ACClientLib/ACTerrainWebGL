# Spawn count analyzer

Reads an ACE `ace_world.db` database and estimates the world-map spawn count if encounters and generator initial spawns are included.

Dungeon cells are excluded. Existing exterior generator children are treated as already represented, so the final total is an addition beyond the current map snapshot.

```text
dotnet run --project .\tools\SpawnCountAnalyzer\SpawnCountAnalyzer.csproj -- C:\Data\ace_world.db 1000 1337
```

Arguments are world database path, sample count, and random seed. The sampler follows ACE's generator profile probability, `InitCreate`, `MaxCreate`, and profile limits for the initial generation pass.
