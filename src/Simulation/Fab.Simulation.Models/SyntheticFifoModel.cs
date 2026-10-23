namespace Fab.Simulation.Models;

/// <summary>One equipment, one operation, all lots released at time zero.</summary>
public sealed record SyntheticFifoModel(string FabId, string Code, int LotCount, long ProcessTimeUs)
{
    public long MaximumJitterUs => ProcessTimeUs / 10;
    public long ServiceTime(ulong random) => checked(ProcessTimeUs + (long)(random % (ulong)(MaximumJitterUs + 1)));
}
