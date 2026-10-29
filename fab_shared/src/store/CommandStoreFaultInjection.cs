namespace Fab.Contracts;

/// <summary>
/// Named durable-transaction boundaries used by the fault-injection acceptance matrix (ADR-012
/// 2.3 / matrix 3). Production code uses <see cref="NoCommandStoreFaultInjector"/> only.
/// </summary>
public static class CommandStoreFaultPoints
{
    public const string AfterCommandInsert = "after-command-insert";
    public const string AfterIdempotencyInsert = "after-idempotency-insert";
    public const string AfterJournalInsert = "after-journal-insert";
    public const string BeforeCommit = "before-commit";
    public const string AfterCommitBeforeResponse = "after-commit-before-response";
    public const string BeforeCommitReturn = "before-commit-return";
    public const string DuringPrune = "during-prune";
}

/// <summary>
/// Test/Development seam that throws at a named boundary to simulate a process crash. Implementations
/// must throw from <see cref="Reach"/>; the store rolls back the open transaction and rethrows, which
/// models SQLite's own recovery of an uncommitted transaction after a crash.
/// </summary>
public interface ICommandStoreFaultInjector
{
    void Reach(string point);
}

/// <summary>Thrown by test fault injectors to simulate a crash at a durable-transaction boundary.</summary>
public sealed class InjectedCommandStoreFaultException : Exception
{
    public InjectedCommandStoreFaultException(string point)
        : base($"Injected command store fault at '{point}'.")
    {
        Point = point;
    }

    public string Point { get; }
}

/// <summary>Production injector: never throws.</summary>
public sealed class NoCommandStoreFaultInjector : ICommandStoreFaultInjector
{
    public static readonly NoCommandStoreFaultInjector Instance = new();

    private NoCommandStoreFaultInjector()
    {
    }

    public void Reach(string point)
    {
    }
}
