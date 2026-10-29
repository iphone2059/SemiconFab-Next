using Fab.App;
using Fab.Contracts;
using Microsoft.Data.Sqlite;

namespace Fab.Tests;

/// <summary>
/// Temporary on-disk command-store directories for tests. Every directory lives under the OS temp
/// directory (never the repository <c>.local/data</c>) and is removed when the test process exits.
/// SQLite connection pools are cleared before deletion because pooled WAL connections keep file
/// handles open on Windows.
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

    public static string DatabasePath(string root) => Path.Combine(root, "commands.db");

    public static ICommandStore Store(ICommandStoreFaultInjector? faultInjector = null) =>
        new SqliteCommandStore(DatabasePath(Create()), faultInjector);

    /// <summary>Closes pooled SQLite connections so a test can inspect or delete the database file on Windows.</summary>
    public static void ResetDatabasePools() => SqliteConnection.ClearAllPools();

    /// <summary>Deletes <c>commands.db</c> (and its WAL side files) to simulate a Development store reset.</summary>
    public static void ResetDatabase(string root)
    {
        SqliteConnection.ClearAllPools();
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            var path = DatabasePath(root) + suffix;
            if (File.Exists(path)) File.Delete(path);
        }
    }

    public static void Delete(string root)
    {
        SqliteConnection.ClearAllPools();
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(50);
            }
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