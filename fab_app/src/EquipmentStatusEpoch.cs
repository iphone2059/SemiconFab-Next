using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Fab.App;

/// <summary>
/// One durable, JavaScript-safe generation per API service lifetime. The counter
/// is serialized across local processes and does not depend on wall-clock order.
/// Keep this directory with the API's data when restarting the development host.
/// </summary>
internal static class EquipmentStatusEpoch
{
    private const long MaxSafeInteger = 9_007_199_254_740_991L;

    public static long Allocate(string directory)
    {
        Directory.CreateDirectory(directory);
        using var gate = AcquireLock(Path.Combine(directory, ".epoch.lock"));
        var path = Path.Combine(directory, "epoch.txt");
        var text = File.Exists(path) ? File.ReadAllText(path) : "0";
        // Fail closed on corruption/exhaustion: restarting at zero would allow
        // delayed frames from an older process to win again.
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var previous) || previous < 0 || previous >= MaxSafeInteger)
            throw new InvalidDataException("Invalid equipment-status epoch.");
        var next = previous + 1;
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(Encoding.UTF8.GetBytes(next.ToString(CultureInfo.InvariantCulture)));
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return next;
    }

    private static FileStream AcquireLock(string path)
    {
        var timeout = Stopwatch.StartNew();
        while (true)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (timeout.Elapsed < TimeSpan.FromSeconds(10)) { Thread.Sleep(10); }
        }
    }
}
