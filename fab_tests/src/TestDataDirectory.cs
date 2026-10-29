using Fab.App;

namespace Fab.Tests;

/// <summary>
/// Temporary on-disk command-store roots for tests. Every directory lives under the OS temp
/// directory (never the repository <c>.local/data</c>) and is removed when the test process exits.
/// </summary>
internal static class TestDataDirectory
{
    private static readonly List<string> Roots = [];

    static TestDataDirectory()
    {
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Cleanup();
    }

    public static string Create()
    {
        var root = Path.Combine(Path.GetTempPath(), "fab-command-store-tests", Guid.NewGuid().ToString("N"));
        Register(root);
        return root;
    }

    public static void Register(string root)
    {
        lock (Roots)
        {
            Roots.Add(root);
        }
    }

    public static ICommandStore Store() => new FileCommandStore(Create());

    public static void Delete(string root)
    {
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Best-effort cleanup only; the OS temp directory owns the remainder.
        }
    }

    private static void Cleanup()
    {
        string[] roots;
        lock (Roots)
        {
            roots = Roots.ToArray();
            Roots.Clear();
        }
        foreach (var root in roots) Delete(root);
    }
}
