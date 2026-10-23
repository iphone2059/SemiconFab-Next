using Fab.Orchestration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Fab.App;

internal static class WorkerHost
{
    public static async Task RunAsync(string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);
        if (!builder.Environment.IsDevelopment())
            throw new InvalidOperationException("Worker mode requires DOTNET_ENVIRONMENT=Development; production storage and real OT are not implemented.");
        var dataDirectory = Path.GetFullPath(builder.Configuration["Fab:DataDirectory"]
            ?? Path.Combine(builder.Environment.ContentRootPath, ".local", "data"));
        builder.Services.AddLocalOrchestration(dataDirectory);
        builder.Services.AddHostedService<SimulationWorker>();
        await builder.Build().RunAsync();
    }
}
