namespace Fab.Ids;

public static class StableId
{
    public static string Normalize(string? value, string parameterName)
    {
        if (value is null || !Guid.TryParseExact(value, "D", out var parsed) || parsed == Guid.Empty)
            throw new ArgumentException("A nonzero UUID in D format is required.", parameterName);
        return parsed.ToString("D");
    }
}
