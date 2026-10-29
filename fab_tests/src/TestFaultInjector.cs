using Fab.App;

namespace Fab.Tests;

/// <summary>Deterministic fault injector: throws <see cref="InjectedCommandStoreFaultException"/> at the armed boundary.</summary>
internal sealed class TestFaultInjector : ICommandStoreFaultInjector
{
    private readonly object gate = new();
    private readonly List<string> reached = [];
    private string? throwAt;

    public string? ThrowAt
    {
        get { lock (gate) return throwAt; }
        set { lock (gate) throwAt = value; }
    }

    public string[] Reached
    {
        get { lock (gate) return reached.ToArray(); }
    }

    public void Reach(string point)
    {
        lock (gate) reached.Add(point);
        if (string.Equals(ThrowAt, point, StringComparison.Ordinal))
            throw new InjectedCommandStoreFaultException(point);
    }
}
