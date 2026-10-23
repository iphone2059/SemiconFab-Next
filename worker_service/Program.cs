using Fab.Orchestration.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);
if (!builder.Environment.IsDevelopment())
    throw new InvalidOperationException("Fab.Worker currently requires DOTNET_ENVIRONMENT=Development; production storage and real OT are not implemented.");
var dataDirectory = builder.Configuration["Fab:DataDirectory"]
    ?? Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, ".data"));
builder.Services.AddLocalOrchestration(dataDirectory);
builder.Services.AddHostedService<SimulationWorker>();
await builder.Build().RunAsync();
