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
    private static readonly System.Text.Json.JsonSerializerOptions SseJsonOptions = new(System.Text.Json.JsonSerializerDefaults.Web);

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
        var fabCount = builder.Configuration.GetValue("Fab:FabCount", SiteDirectory.DefaultFabCount);
        var commandOptions = new EquipmentCommandOptions
        {
            TerminalTtl = TimeSpan.FromSeconds(builder.Configuration.GetValue("Fab:Commands:TerminalTtlSeconds", 300)),
            MaxTerminalCommands = builder.Configuration.GetValue("Fab:Commands:MaxTerminalCommands", 512),
            MaxJournalEventsPerSite = builder.Configuration.GetValue("Fab:Commands:MaxJournalEvents", 4096)
        };
        builder.Services.AddSingleton(new SiteDirectory(fabCount));
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton(commandOptions);
        builder.Services.AddSingleton<EquipmentStatusService>();
        builder.Services.AddSingleton(provider => new EquipmentCommandService(
            provider.GetRequiredService<SiteDirectory>(),
            provider.GetRequiredService<TimeProvider>(),
            provider.GetRequiredService<EquipmentCommandOptions>()));
        builder.Services.AddSingleton<TelemetrySimulationService>();
        builder.Services.Configure<EquipmentCapabilityCatalogOptions>(builder.Configuration.GetSection("Fab:EquipmentCapabilities"));
        builder.Services.AddSingleton<IEquipmentCapabilityCatalog, EquipmentCapabilityCatalog>();
        builder.Services.AddSingleton<IEquipmentStateProvider, SyntheticEquipmentStateProvider>();
        builder.Services.AddSingleton<IEquipmentCommandValidator, EquipmentCommandValidator>();
        builder.Services.AddSingleton<IFabAuthorization, DevelopmentFabAuthorization>();
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
        // Fail fast on an invalid Fab:EquipmentCapabilities catalog instead of silently widening command access.
        _ = app.Services.GetRequiredService<IEquipmentCapabilityCatalog>();
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
        api.MapGet("/sites/{siteId:guid}/equipment-status", (Guid siteId, EquipmentStatusService status, SiteDirectory directory) =>
            directory.TryGetSite(siteId, out var site)
                ? Results.Ok(status.Get(siteId, site.Fabs[0].Id))
                : Results.Problem(statusCode: 404, title: "Site not found"));
        api.MapGet("/sites/{siteId:guid}/equipment-status/stream", async (Guid siteId, EquipmentStatusService status, SiteDirectory directory, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!directory.TryGetSite(siteId, out var site))
            {
                await Results.Problem(statusCode: 404, title: "Site not found").ExecuteAsync(context);
                return;
            }
            var fabId = site.Fabs[0].Id;
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";
            context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    var snapshot = status.Get(siteId, fabId);
                    var json = System.Text.Json.JsonSerializer.Serialize(snapshot, SseJsonOptions);
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
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/equipment-status", (Guid siteId, Guid fabId, EquipmentStatusService status, SiteDirectory directory) =>
            directory.TryGetFab(siteId, fabId, out _)
                ? Results.Ok(status.Get(siteId, fabId))
                : Results.Problem(statusCode: 404, title: "Site or FAB not found"));
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/equipment-status/stream", async (Guid siteId, Guid fabId, EquipmentStatusService status, SiteDirectory directory, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!directory.TryGetFab(siteId, fabId, out _))
            {
                await Results.Problem(statusCode: 404, title: "Site or FAB not found").ExecuteAsync(context);
                return;
            }
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";
            context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    var snapshot = status.Get(siteId, fabId);
                    var json = System.Text.Json.JsonSerializer.Serialize(snapshot, SseJsonOptions);
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
        api.MapPost("/sites/{siteId:guid}/commands", (Guid siteId, EquipmentCommandRequest? request, HttpContext context,
            EquipmentCommandService commands, SiteDirectory directory, IEquipmentCommandValidator validator, IFabAuthorization authorization) =>
        {
            if (!EquipmentCommandService.TryValidateIdempotencyKey(context.Request.Headers["Idempotency-Key"].ToString(), out var idempotencyKey, out var keyError))
                return Results.Problem(statusCode: 400, title: "A valid Idempotency-Key is required", detail: keyError,
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "INVALID_IDEMPOTENCY_KEY" });
            if (!EquipmentCommandService.TryValidate(request, out var error))
                return Results.Problem(statusCode: 400, title: "Invalid command request", detail: error);
            var command = request!;
            if (!directory.TryGetSite(siteId, out _))
                return Results.Problem(statusCode: 404, title: "Site not found");
            if (!Guid.TryParse(command.FabId, out var fabId) || !directory.TryGetFab(siteId, fabId, out var fab))
                return Results.Problem(statusCode: 404, title: "FAB not found in Site");
            // Ownership check: never reveal whether an unauthorized FAB exists.
            if (!authorization.IsAuthorized(siteId, fab.Id, context.User))
                return Results.Problem(statusCode: 404, title: "FAB not found in Site");
            var validation = validator.Validate(siteId, fab, command);
            if (!validation.IsValid)
                return Results.Problem(statusCode: 400, title: validation.Title, detail: validation.Detail,
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "INVALID_COMMAND" });
            var principal = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "";
            var result = commands.Submit(siteId, command, principal, idempotencyKey);
            return result.Status switch
            {
                EquipmentCommandSubmitStatus.UnknownSite => Results.Problem(statusCode: 404, title: "Site not found"),
                EquipmentCommandSubmitStatus.UnknownFab => Results.Problem(statusCode: 404, title: "FAB not found in Site"),
                EquipmentCommandSubmitStatus.IdempotencyConflict => Results.Problem(statusCode: 409,
                    title: "Idempotency-Key conflicts with an earlier request",
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "IDEMPOTENCY_CONFLICT" }),
                _ => Results.Accepted($"/api/v1/commands/{result.Command!.CommandId}", result.Command)
            };
        });
        api.MapGet("/commands/{commandId:guid}", (Guid commandId, EquipmentCommandService commands, IFabAuthorization authorization, HttpContext context) =>
        {
            var command = commands.Get(commandId);
            // Unknown, inconsistent, pruned and unauthorized commands all map to the same 404 so no existence leaks.
            if (command is null ||
                !Guid.TryParse(command.SiteId, out var siteId) ||
                !Guid.TryParse(command.FabId, out var fabId) ||
                !authorization.IsAuthorized(siteId, fabId, context.User))
                return Results.Problem(statusCode: 404, title: "Command not found");
            return Results.Ok(command);
        });
        api.MapGet("/sites/{siteId:guid}/commands/stream", async (Guid siteId, EquipmentCommandService commands, SiteDirectory directory, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!directory.TryGetSite(siteId, out _))
            {
                await Results.Problem(statusCode: 404, title: "Site not found").ExecuteAsync(context);
                return;
            }
            var header = context.Request.Headers["Last-Event-ID"].ToString();
            string? lastEventId = string.IsNullOrWhiteSpace(header) ? null : header;
            var replay = commands.ReadJournal(siteId, lastEventId);
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";
            context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
            var cursor = replay.LatestSequence;
            try
            {
                await context.Response.StartAsync(cancellationToken);
                await context.Response.Body.FlushAsync(cancellationToken);
                if (replay.HasGap)
                {
                    var gapJson = System.Text.Json.JsonSerializer.Serialize(commands.CreateReplayGap(replay, lastEventId), SseJsonOptions);
                    await context.Response.WriteAsync($"event: replay-gap\ndata: {gapJson}\n\n", cancellationToken);
                }
                foreach (var envelope in replay.Events)
                {
                    await WriteCommandEventAsync(context.Response, commands.JournalEpoch, envelope, cancellationToken);
                    cursor = envelope.Sequence;
                }
                if (replay.HasGap || replay.Events.Length > 0) await context.Response.Body.FlushAsync(cancellationToken);
                while (!cancellationToken.IsCancellationRequested)
                {
                    var pending = commands.ReadJournalSince(siteId, cursor);
                    foreach (var envelope in pending)
                    {
                        await WriteCommandEventAsync(context.Response, commands.JournalEpoch, envelope, cancellationToken);
                        cursor = envelope.Sequence;
                    }
                    if (pending.Length > 0) await context.Response.Body.FlushAsync(cancellationToken);
                    await Task.Delay(TimeSpan.FromMilliseconds(EquipmentCommandService.StreamPollMilliseconds), cancellationToken);
                }
            }
            catch (OperationCanceledException)
            {
                // Client disconnected.
            }
        });
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/telemetry/stream", async (Guid siteId, Guid fabId, TelemetrySimulationService telemetry, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!telemetry.TryGetFab(siteId, fabId, out _))
            {
                await Results.Problem(statusCode: 404, title: "Site or FAB not found").ExecuteAsync(context);
                return;
            }
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";
            context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
            var sequence = 0L;
            try
            {
                await context.Response.StartAsync(cancellationToken);
                while (!cancellationToken.IsCancellationRequested)
                {
                    sequence++;
                    var frame = telemetry.CreateFrame(fabId, sequence);
                    var json = System.Text.Json.JsonSerializer.Serialize(frame, SseJsonOptions);
                    await context.Response.WriteAsync($"data: {json}\n\n", cancellationToken);
                    await context.Response.Body.FlushAsync(cancellationToken);
                    await Task.Delay(TimeSpan.FromMilliseconds(TelemetrySimulationService.FrameIntervalMilliseconds), cancellationToken);
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

    /// <summary>Writes one journaled command event as an SSE frame: <c>id: {epoch}:{sequence}</c> plus the unchanged data envelope.</summary>
    private static async Task WriteCommandEventAsync(HttpResponse response, Guid epoch, EquipmentCommandStreamEnvelope envelope, CancellationToken cancellationToken)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(envelope, SseJsonOptions);
        await response.WriteAsync($"id: {epoch:D}:{envelope.Sequence}\n", cancellationToken);
        await response.WriteAsync($"data: {json}\n\n", cancellationToken);
    }
}
