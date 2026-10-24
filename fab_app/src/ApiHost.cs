using System.Globalization;
using System.Security.Claims;
using System.Text.Json.Serialization;
using Fab.Contracts;
using Fab.Analytics;
using Fab.Identity;
using Fab.Orchestration;
using Fab.Site;
using Fab.Catalog;

namespace Fab.App;

internal static class ApiHost
{
    public static async Task RunAsync(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        if (!builder.Environment.IsDevelopment())
            throw new InvalidOperationException("This initial slice runs only in Development. Configure production identity and PostgreSQL before deployment.");
        var key = builder.Configuration["Fab:DevelopmentKey"];
        if (string.IsNullOrWhiteSpace(key) || key.Length < 32)
            throw new InvalidOperationException("Set Fab__DevelopmentKey to a random local key of at least 32 characters, or use scripts/start-dev.ps1.");
        if (string.IsNullOrWhiteSpace(builder.Configuration["urls"]))
            builder.WebHost.UseUrls("http://127.0.0.1:5080");
        var data = Path.GetFullPath(builder.Configuration["Fab:DataDirectory"] ?? Path.Combine(builder.Environment.ContentRootPath, ".local", "data"));
        builder.Services.AddSingleton(new SiteDirectory());
        builder.Services.AddSingleton<EquipmentStatusService>();
        builder.Services.AddSingleton(new CatalogService(Path.GetFullPath(builder.Configuration["Fab:CatalogDirectory"]
            ?? Path.Combine(AppContext.BaseDirectory, "assets", "legacy"))));
        builder.Services.AddLocalOrchestration(data);
        if (builder.Configuration.GetValue("Fab:EmbeddedWorker", true))
            builder.Services.AddHostedService<SimulationWorker>();
        builder.Services.AddAuthentication(DevelopmentIdentityHandler.SchemeName)
            .AddScheme<DevelopmentIdentityOptions, DevelopmentIdentityHandler>(DevelopmentIdentityHandler.SchemeName, options => options.Key = key);
        builder.Services.AddAuthorization();
        builder.Services.AddProblemDetails();
        builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow);
        var app = builder.Build();
        app.UseExceptionHandler();
        app.Use(async (context, next) =>
        {
            var origin = context.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || !uri.IsLoopback))
            {
                await Results.Problem(statusCode: 403, title: "Local development origin required").ExecuteAsync(context);
                return;
            }
            try { await next(context); }
            catch (CatalogUnavailableException)
            {
                await Results.Problem(statusCode: 503, title: "Catalog data unavailable", extensions: new Dictionary<string, object?> { ["errorCode"] = "CATALOG_UNAVAILABLE" }).ExecuteAsync(context);
            }
            catch (IdempotencyConflictException)
            {
                await Results.Problem(statusCode: 409, title: "Idempotency key conflicts with an earlier request", extensions: new Dictionary<string, object?> { ["errorCode"] = "IDEMPOTENCY_CONFLICT" }).ExecuteAsync(context);
            }
            catch (Exception exception) when (exception is ArgumentException or FormatException or OverflowException)
            {
                await Results.Problem(statusCode: 400, title: "Invalid request", detail: exception.Message, extensions: new Dictionary<string, object?> { ["errorCode"] = "INVALID_SCENARIO" }).ExecuteAsync(context);
            }
        });
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
        app.MapGet("/health/ready", () => Results.Ok(new { status = "ready", environment = "Development", metadataStore = "local-file", productionReady = false })).RequireAuthorization();
        var api = app.MapGroup("/api/v1").RequireAuthorization();
        api.MapGet("/catalog", (string? domain, string? category, string? q, CatalogService catalog) => catalog.Query(domain, category, q));
        api.MapGet("/catalog/{id:guid}", (Guid id, CatalogService catalog) =>
            catalog.Find(id) is { } entry ? Results.Ok(entry) : Results.Problem(statusCode: 404, title: "Catalog record not found"));
        api.MapGet("/sites", (SiteDirectory catalog) => catalog.GetSites());
        api.MapGet("/sites/{siteId:guid}/equipment-status", (Guid siteId, EquipmentStatusService status) => status.Get(siteId));
        api.MapGet("/sites/{siteId:guid}/equipment-status/stream", async (Guid siteId, EquipmentStatusService status, HttpContext context, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";
            context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    var snapshot = status.Get(siteId);
                    var json = System.Text.Json.JsonSerializer.Serialize(snapshot, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
                    await context.Response.WriteAsync($"data: {json}\n\n", cancellationToken);
                    await context.Response.Body.FlushAsync(cancellationToken);
                    await Task.Delay(TimeSpan.FromSeconds(4), cancellationToken);
                }
            }
            catch (OperationCanceledException)
            {
                // Client disconnected.
            }
        });
        api.MapGet("/capabilities", () => new { contractVersion = 1, model = "SYNTHETIC_FIFO_SINGLE_TOOL_V1", independent = true, sharedCapacity = false, otControl = false, postgresql = false, binaryRealtime = false, productionReady = false });
        api.MapGet("/runs", (IRunService runs) => runs.List());
        api.MapPost("/runs", (CreateRunRequest request, HttpContext context, IRunService runs, SiteDirectory catalog) =>
        {
            ArgumentNullException.ThrowIfNull(request);
            var idempotency = context.Request.Headers["Idempotency-Key"].ToString();
            if (string.IsNullOrWhiteSpace(idempotency) || idempotency.Length > 128 || idempotency.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_' or '.')))
                return Results.Problem(statusCode: 400, title: "A valid Idempotency-Key is required");
            catalog.ValidateMembership(request.Scenario);
            var run = runs.Submit(request, context.User.FindFirstValue(ClaimTypes.NameIdentifier)!, idempotency);
            context.Response.Headers.ETag = $"\"{run.Version}\"";
            return Results.Accepted($"/api/v1/runs/{run.RunId}", run);
        });
        api.MapGet("/runs/{id:guid}", (Guid id, IRunService runs, HttpContext context) =>
        {
            var run = runs.Get(id);
            if (run is null) return Results.Problem(statusCode: 404, title: "Run not found");
            context.Response.Headers.ETag = $"\"{run.Version}\"";
            return Results.Ok(run);
        });
        api.MapGet("/runs/{id:guid}/results", (Guid id, IRunService runs) =>
        {
            if (runs.Get(id) is null) return Results.Problem(statusCode: 404, title: "Run not found");
            var result = runs.GetResults(id);
            return result is null ? Results.Problem(statusCode: 409, title: "Run results are not committed") : Results.Ok(result);
        });
        api.MapGet("/sites/{siteId:guid}/kpi", (Guid siteId, Guid runId, IRunService runs) =>
        {
            var run = runs.Get(runId);
            if (run is null || !Guid.TryParse(run.SiteId, out var owner) || owner != siteId)
                return Results.Problem(statusCode: 404, title: "Run not found in this Site");
            var result = runs.GetResults(runId);
            return result is null ? Results.Problem(statusCode: 409, title: "Complete results are required for Site KPI")
                : Results.Ok(SiteKpiCalculator.Calculate(run, result));
        });
        await app.RunAsync();
    }
}
