using System.Globalization;
using System.Numerics;
using Fab.Contracts;

namespace Fab.Analytics.Application;

public static class SiteKpiCalculator
{
    public static SiteKpiDto Calculate(RunSummary run, RunResult result)
    {
        if (run.RunId != result.RunId || run.Status != "COMPLETED" || result.Fabs.Length == 0 ||
            !run.Executions.Select(e => e.FabId).Order().SequenceEqual(result.Fabs.Select(f => f.FabId).Order()))
            throw new ArgumentException("A complete result for the same Run is required.");
        if (result.Fabs.Select(f => f.SimulationTimeUs).Distinct().Count() != 1)
            throw new ArgumentException("Site KPI requires a common observation boundary.");
        static string Sum(IEnumerable<string> values) => values.Aggregate(BigInteger.Zero,
            (sum, value) => sum + BigInteger.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture)).ToString(CultureInfo.InvariantCulture);
        return new(run.SiteId, run.RunId, Sum(result.Fabs.Select(f => f.CompletedLots)),
            Sum(result.Fabs.Select(f => f.TotalLots)), Sum(result.Fabs.Select(f => f.BusyTimeUs)),
            result.Fabs[0].SimulationTimeUs, result.Fabs.Length);
    }
}
