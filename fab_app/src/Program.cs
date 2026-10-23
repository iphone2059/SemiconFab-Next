using Fab.App;

var mode = args.FirstOrDefault(argument => argument.StartsWith("--mode=", StringComparison.Ordinal))?["--mode=".Length..]
    ?? (args.Contains("--worker") ? "worker"
        : args.Contains("--realtime") ? "realtime"
        : args.Contains("--ot") ? "ot"
        : "api");

if (mode == "api")
{
    await ApiHost.RunAsync(args);
}
else if (mode == "worker")
{
    await WorkerHost.RunAsync(args);
}
else
{
    Console.Error.WriteLine(mode == "realtime"
        ? "Binary realtime transport is not implemented in this slice. Use the authenticated development API for full results."
        : "OT Gateway is intentionally unavailable: no approved endpoint/Profile or real-device capability is configured.");
    Environment.Exit(2);
}

public partial class Program;
