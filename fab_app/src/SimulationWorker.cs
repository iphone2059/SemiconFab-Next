using Fab.Contracts;
using Fab.Orchestration;
using Fab.Simulation;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Fab.Orchestration;

public sealed class SimulationWorker(FileRunStore store, ISimulationExecutionPort engine, IHostEnvironment environment, ILogger<SimulationWorker> logger) : BackgroundService
{
    private readonly string owner = Environment.MachineName + ":" + Environment.ProcessId + ":" + Guid.NewGuid().ToString("N");

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        EnsureDevelopment();
        // Repair any index write lost to a crash between publishing a Run and publishing an index
        // before the worker starts claiming, instead of waiting for a fallback repair interval.
        store.RecoverIndexes();
        return base.StartAsync(cancellationToken);
    }

    public async Task<bool> ProcessNextAsync(CancellationToken token)
    {
        EnsureDevelopment();
        token.ThrowIfCancellationRequested();
        var lease = store.TryClaim(owner);
        if (lease is null) return false;
        using var executionCancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
        using var heartbeatCancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
        var heartbeat = HeartbeatAsync(lease, executionCancellation, heartbeatCancellation.Token);
        try
        {
            // The synchronous engine holds no storage lock and runs independently of heartbeat I/O.
            var result = await Task.Run(() => engine.Execute(lease.Scenario, lease.FabId, executionCancellation.Token), executionCancellation.Token);
            token.ThrowIfCancellationRequested();
            store.Complete(lease, result);
        }
        catch (OperationCanceledException) when (executionCancellation.IsCancellationRequested) { }
        catch (LeaseLostException) { logger.LogWarning("Lease lost for Run {RunId}, FAB {FabId}.", lease.RunId, lease.FabId); }
        catch (Exception error)
        {
            logger.LogError(error, "Simulation failed for Run {RunId}, FAB {FabId}.", lease.RunId, lease.FabId);
            try { store.Fail(lease, error.Message); }
            catch (LeaseLostException) { logger.LogWarning("Failure ignored for stale execution epoch {Epoch}.", lease.Epoch); }
        }
        finally
        {
            await heartbeatCancellation.CancelAsync();
            try { await heartbeat; } catch (OperationCanceledException) when (heartbeatCancellation.IsCancellationRequested) { }
        }
        return true;
    }

    private async Task HeartbeatAsync(ExecutionLease lease, CancellationTokenSource executionCancellation, CancellationToken token)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromTicks(store.LeaseDuration.Ticks / 3));
            while (await timer.WaitForNextTickAsync(token))
                if (!store.Renew(lease)) { await executionCancellation.CancelAsync(); return; }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            logger.LogError(error, "Heartbeat failed for Run {RunId}.", lease.RunId);
            await executionCancellation.CancelAsync();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Wake on the coalesced Submit notification (at most one pending); the 1 s timeout
                // still lets idle workers discover leases that expired without an in-process signal.
                if (!await ProcessNextAsync(stoppingToken)) await store.WaitForWorkAsync(TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    private void EnsureDevelopment()
    {
        if (!environment.IsDevelopment()) throw new InvalidOperationException("Local orchestration is only available in Development. Real OT is not supported.");
    }
}

public static class LocalOrchestrationRegistration
{
    public static IServiceCollection AddLocalOrchestration(this IServiceCollection services, string dataDirectory)
    {
        services.AddSingleton(provider =>
        {
            if (!provider.GetRequiredService<IHostEnvironment>().IsDevelopment())
                throw new InvalidOperationException("The local file adapter is Development-only.");
            return new FileRunStore(dataDirectory);
        });
        services.AddSingleton<IRunService>(provider => provider.GetRequiredService<FileRunStore>());
        services.AddSingleton<ISimulationExecutionPort, LocalSimulationExecution>();
        return services;
    }
}

public sealed class LocalSimulationExecution : ISimulationExecutionPort
{
    public FabSimulationResult Execute(ScenarioDefinition scenario, string fabId, CancellationToken token) => new FabSimulation().Execute(scenario, fabId, token);
}
