using Fab.Contracts;

namespace Fab.Orchestration.Application;

public interface IRunService
{
    RunSummary Submit(CreateRunRequest request, string principal, string key);
    RunSummary? Get(Guid id);
    RunSummary[] List();
    RunResult? GetResults(Guid id);
}

public interface ISimulationExecutionPort
{
    FabSimulationResult Execute(ScenarioDefinition scenario, string fabId, CancellationToken token);
}

public sealed class IdempotencyConflictException(string message) : InvalidOperationException(message);
public sealed class LeaseLostException(string message) : InvalidOperationException(message);

public sealed record ExecutionLease(Guid RunId, string FabId, string Owner, long Epoch, DateTimeOffset ExpiresAtUtc, ScenarioDefinition Scenario);
