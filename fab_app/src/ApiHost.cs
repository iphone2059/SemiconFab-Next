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
        // The current deployment defaults to one FAB, while the architecture supports 1..32
        // independent FABs via explicit Fab:FabCount. Every FAB-scoped endpoint must therefore
        // carry/cross-check a fabId and never substitute FAB-01 silently.
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
        builder.Services.AddSingleton(_ => new EquipmentStatusService(Path.Combine(data, "equipment-status")));
        // Durable command recovery (ADR-012): one transactional SQLite WAL database under Fab:DataDirectory.
        builder.Services.AddSingleton<ICommandStore>(_ => new SqliteCommandStore(Path.Combine(data, "commands.db")));
        builder.Services.AddSingleton(provider => new EquipmentCommandService(
            provider.GetRequiredService<ICommandStore>(),
            provider.GetRequiredService<SiteDirectory>(),
            provider.GetRequiredService<TimeProvider>(),
            provider.GetRequiredService<EquipmentCommandOptions>(),
            provider.GetRequiredService<IEquipmentCommandValidator>()));
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
        // Fail fast when the durable command store cannot be recovered: there is no memory fallback.
        _ = app.Services.GetRequiredService<EquipmentCommandService>();
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
            catch (CommandStoreException)
            {
                // Durable command storage is unavailable: fail explicitly instead of serving from memory.
                await Results.Problem(statusCode: 503, title: "Command store unavailable",
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "COMMAND_STORE_UNAVAILABLE" }).ExecuteAsync(context);
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
        // Model-level legacy catalog (not Site/FAB-scoped): catalog records describe equipment models
        // and vendors, so no fabId applies.
        api.MapGet("/catalog", (string? domain, string? category, string? q, CatalogService catalog) => catalog.Query(domain, category, q));
        api.MapGet("/catalog/{id:guid}", (Guid id, CatalogService catalog) =>
            catalog.Find(id) is { } entry ? Results.Ok(entry) : Results.Problem(statusCode: 404, title: "Catalog record not found"));
        // Site-level catalog: returns the Site and every FAB identity it owns. Site aggregates never
        // substitute FAB-01 for a specific FAB; FAB-scoped data uses the /fabs/{fabId}/... routes.
        api.MapGet("/sites", (SiteDirectory catalog) => catalog.GetSites());
        // FAB-level equipment status and stream. The former Site-level aliases that silently
        // substituted FAB-01 were removed; clients must pass an explicit fabId (multi-FAB safe).
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/equipment-status", (Guid siteId, Guid fabId, EquipmentStatusService status, SiteDirectory directory, IFabAuthorization authorization, HttpContext context) =>
            directory.TryGetFab(siteId, fabId, out var fab) && authorization.IsAuthorized(siteId, fab.Id, context.User)
                ? Results.Ok(status.Get(siteId, fabId))
                : Results.Problem(statusCode: 404, title: "Site or FAB not found"));
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/equipment-status/stream", async (Guid siteId, Guid fabId, EquipmentStatusService status, SiteDirectory directory, IFabAuthorization authorization, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!directory.TryGetFab(siteId, fabId, out var fab) || !authorization.IsAuthorized(siteId, fab.Id, context.User))
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
        // FAB-level command submission: siteId is the ownership/authorization scope and the body
        // carries the required target FAB identity; there is no Site-wide command target.
        api.MapPost("/sites/{siteId:guid}/commands", (Guid siteId, EquipmentCommandRequest? request, HttpContext context,
            EquipmentCommandService commands, SiteDirectory directory, IFabAuthorization authorization) =>
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
            var principal = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "";
            // The service owns the single atomic path: idempotency replay/conflict is decided
            // before the capability/state validator runs for brand-new commands only.
            var result = commands.Submit(siteId, command, principal, idempotencyKey);
            return result.Status switch
            {
                EquipmentCommandSubmitStatus.UnknownSite => Results.Problem(statusCode: 404, title: "Site not found"),
                EquipmentCommandSubmitStatus.UnknownFab => Results.Problem(statusCode: 404, title: "FAB not found in Site"),
                EquipmentCommandSubmitStatus.IdempotencyConflict => Results.Problem(statusCode: 409,
                    title: "Idempotency-Key conflicts with an earlier request",
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "IDEMPOTENCY_CONFLICT" }),
                EquipmentCommandSubmitStatus.InvalidCommand => Results.Problem(statusCode: 400,
                    title: result.Validation!.Title, detail: result.Validation.Detail,
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "INVALID_COMMAND" }),
                EquipmentCommandSubmitStatus.StoreUnavailable => Results.Problem(statusCode: 503,
                    title: "Command store unavailable",
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "COMMAND_STORE_UNAVAILABLE" }),
                _ => Results.Accepted($"/api/v1/commands/{result.Command!.CommandId}", result.Command)
            };
        });
        // FAB-level authoritative command lookup: the command identity is (siteId, fabId, commandId)
        // and both parent identities are encoded in the stored command instead of the path.
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
        // Authoritative FAB-scoped command listing: the browser-refresh / severe-gap recovery entry point.
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/commands", (Guid siteId, Guid fabId, string? status, int? afterRevision,
            EquipmentCommandService commands, SiteDirectory directory, IFabAuthorization authorization, HttpContext context) =>
        {
            if (!directory.TryGetFab(siteId, fabId, out var fab) || !authorization.IsAuthorized(siteId, fab.Id, context.User))
                return Results.Problem(statusCode: 404, title: "Site or FAB not found");
            var normalizedStatus = status ?? EquipmentCommandService.StatusAll;
            if (normalizedStatus is not (EquipmentCommandService.StatusActive or EquipmentCommandService.StatusTerminal or EquipmentCommandService.StatusAll))
                return Results.Problem(statusCode: 400, title: "Invalid status filter",
                    detail: "status must be active, terminal or all.",
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "INVALID_QUERY" });
            var revision = afterRevision ?? -1;
            if (revision < -1)
                return Results.Problem(statusCode: 400, title: "Invalid afterRevision filter",
                    detail: "afterRevision must be -1 or greater.",
                    extensions: new Dictionary<string, object?> { ["errorCode"] = "INVALID_QUERY" });
            if (commands.StoreUnavailable) return StoreUnavailableProblem();
            return Results.Ok(commands.ListFabCommands(siteId, fab.Id, normalizedStatus, revision));
        });
        // Epoch-aware durable journal replay page (ADR-010 3): epoch is mandatory; a stale epoch is a
        // 409 journal-epoch-mismatch that forces authoritative reconciliation, never sequence guessing.
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/command-journal", (Guid siteId, Guid fabId, string? epoch,
            long? afterSequence, int? limit, EquipmentCommandService commands, SiteDirectory directory,
            IFabAuthorization authorization, HttpContext context) =>
        {
            if (!directory.TryGetFab(siteId, fabId, out var fab) || !authorization.IsAuthorized(siteId, fab.Id, context.User))
                return Results.Problem(statusCode: 404, title: "Site or FAB not found");
            if (string.IsNullOrWhiteSpace(epoch) || !Guid.TryParse(epoch, out var requestedEpoch))
                return Results.Problem(statusCode: 400, title: "Invalid journal cursor",
                    detail: "The epoch query parameter is required and must be a UUID.",
                    extensions: new Dictionary<string, object?> { ["code"] = "journal-cursor-invalid" });
            var cursor = afterSequence ?? 0;
            var pageLimit = limit ?? EquipmentCommandService.DefaultJournalPageLimit;
            if (cursor < 0)
                return Results.Problem(statusCode: 400, title: "Invalid journal cursor",
                    detail: "afterSequence must be 0 or greater.",
                    extensions: new Dictionary<string, object?> { ["code"] = "journal-cursor-invalid" });
            if (pageLimit is < 1 or > EquipmentCommandService.MaxJournalPageLimit)
                return Results.Problem(statusCode: 400, title: "Invalid journal cursor",
                    detail: $"limit must be 1..{EquipmentCommandService.MaxJournalPageLimit}.",
                    extensions: new Dictionary<string, object?> { ["code"] = "journal-cursor-invalid" });
            if (commands.StoreUnavailable) return StoreUnavailableProblem();
            var result = commands.ReadCommandJournalPage(siteId, fab.Id, requestedEpoch, cursor, pageLimit);
            if (result.EpochMismatch is { } mismatch)
                return Results.Problem(statusCode: 409, title: "Journal epoch mismatch",
                    detail: "The requested journal epoch is no longer current; reconcile authoritative command state.",
                    extensions: new Dictionary<string, object?>
                    {
                        ["code"] = "journal-epoch-mismatch",
                        ["currentEpoch"] = mismatch.CurrentEpoch.ToString("D"),
                        ["firstRetainedSequence"] = mismatch.FirstRetainedSequence,
                        ["latestSequence"] = mismatch.LatestSequence
                    });
            return Results.Ok(result.Page!);
        });
        // FAB-scoped command SSE: the fabId query parameter is required; there is deliberately no
        // Site-wide command stream that could silently mix or pick one FAB's events.
        api.MapGet("/sites/{siteId:guid}/commands/stream", async (Guid siteId, string? fabId, EquipmentCommandService commands,
            SiteDirectory directory, IFabAuthorization authorization, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!Guid.TryParse(fabId, out var requestedFabId))
            {
                await Results.Problem(statusCode: 400, title: "A valid fabId query parameter is required",
                    detail: "The command stream is FAB-scoped; pass ?fabId={guid} for a member FAB.").ExecuteAsync(context);
                return;
            }
            if (!directory.TryGetFab(siteId, requestedFabId, out var fab) || !authorization.IsAuthorized(siteId, fab.Id, context.User))
            {
                await Results.Problem(statusCode: 404, title: "Site or FAB not found").ExecuteAsync(context);
                return;
            }
            if (commands.StoreUnavailable)
            {
                await StoreUnavailableProblem().ExecuteAsync(context);
                return;
            }
            var fabScope = fab.Id.ToString("D");
            var header = context.Request.Headers["Last-Event-ID"].ToString();
            string? lastEventId = string.IsNullOrWhiteSpace(header) ? null : header;
            var replay = commands.ReadJournal(siteId, lastEventId, fabScope);
            var epoch = replay.Epoch;
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
                    // Events may be missing (retention trim / epoch replacement): require authoritative reconcile.
                    if (commands.CreateDirty(replay, lastEventId) is { } initialDirty)
                        await WriteDirtyAsync(context.Response, initialDirty, cancellationToken);
                }
                foreach (var envelope in replay.Events)
                    await WriteCommandEventAsync(context.Response, epoch, envelope, cancellationToken);
                cursor = replay.LatestSequence;
                if (replay.HasGap || replay.Events.Length > 0) await context.Response.Body.FlushAsync(cancellationToken);
                while (!cancellationToken.IsCancellationRequested)
                {
                    if (commands.StoreUnavailable)
                    {
                        // The durable journal can no longer be trusted: the client must reconcile.
                        await WriteDirtyAsync(context.Response, new CommandDirtyDto("store-fault", 0,
                            epoch.ToString("D"), cursor, DateTimeOffset.UtcNow.ToString("O")), cancellationToken);
                        await context.Response.Body.FlushAsync(cancellationToken);
                        return;
                    }
                    var pending = commands.ReadJournalSince(siteId, cursor, fabScope, epoch);
                    if (pending.HasGap)
                    {
                        // Never silently continue: tell the client its cursor is unusable, then replay retained events.
                        var requestedCursor = $"{epoch:D}:{cursor}";
                        var gapJson = System.Text.Json.JsonSerializer.Serialize(commands.CreateReplayGap(pending, requestedCursor), SseJsonOptions);
                        await context.Response.WriteAsync($"event: replay-gap\ndata: {gapJson}\n\n", cancellationToken);
                        if (commands.CreateDirty(pending, requestedCursor) is { } liveDirty)
                            await WriteDirtyAsync(context.Response, liveDirty, cancellationToken);
                        foreach (var envelope in pending.Events)
                            await WriteCommandEventAsync(context.Response, epoch, envelope, cancellationToken);
                        cursor = pending.LatestSequence;
                        await context.Response.Body.FlushAsync(cancellationToken);
                    }
                    else
                    {
                        foreach (var envelope in pending.Events)
                            await WriteCommandEventAsync(context.Response, epoch, envelope, cancellationToken);
                        cursor = pending.LatestSequence;
                        if (pending.Events.Length > 0)
                            await context.Response.Body.FlushAsync(cancellationToken);
                    }
                    await Task.Delay(TimeSpan.FromMilliseconds(EquipmentCommandService.StreamPollMilliseconds), cancellationToken);
                }
            }
            catch (OperationCanceledException)
            {
                // Client disconnected.
            }
        });
        // FAB-scoped telemetry SSE (the fabId path segment is the telemetry identity).
        api.MapGet("/sites/{siteId:guid}/fabs/{fabId:guid}/telemetry/stream", async (Guid siteId, Guid fabId, TelemetrySimulationService telemetry,
            IFabAuthorization authorization, HttpContext context, CancellationToken cancellationToken) =>
        {
            if (!telemetry.TryGetFab(siteId, fabId, out var fab) || !authorization.IsAuthorized(siteId, fab.Id, context.User))
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
                    var frame = telemetry.CreateFrame(siteId, fabId, sequence);
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
        // Model-level capability descriptor: not Site/FAB-scoped and intentionally identical for all FABs.
        api.MapGet("/capabilities", () => new { contractVersion = 1, model = "SYNTHETIC_FIFO_SINGLE_TOOL_V1", independent = true, sharedCapacity = false, otControl = false, postgresql = false, binaryRealtime = false, productionReady = false });
        // Site-level Run resources: a Run scenario validates a non-empty, duplicate-free subset of the
        // configured Site's FABs (1..32 explicit via Fab:FabCount; current deployment default one),
        // never an implicit FAB-01.
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
        // Run resources are Site-level: a Run's frozen scenario carries its Site identity, and each
        // execution inside it is FAB-scoped by fabId (never collapsed to FAB-01).
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
        // Site-level KPI: SiteKpiCalculator aggregates every FAB execution of the requested Run and
        // validates a common observation boundary; it never substitutes FAB-01 for the Site.
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

    /// <summary>Writes one non-journaled <c>event: dirty</c> control frame (no id line).</summary>
    private static async Task WriteDirtyAsync(HttpResponse response, CommandDirtyDto dirty, CancellationToken cancellationToken)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(dirty, SseJsonOptions);
        await response.WriteAsync($"event: dirty\ndata: {json}\n\n", cancellationToken);
    }

    /// <summary>Explicit 503 when durable command storage is unavailable; never a memory-only success.</summary>
    private static IResult StoreUnavailableProblem() =>
        Results.Problem(statusCode: 503, title: "Command store unavailable",
            extensions: new Dictionary<string, object?> { ["errorCode"] = "COMMAND_STORE_UNAVAILABLE" });
}
