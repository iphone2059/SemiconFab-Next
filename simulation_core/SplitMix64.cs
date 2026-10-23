using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Fab.Simulation.Core;

/// <summary>Frozen SplitMix64 v1; state advances once per service start.</summary>
public sealed class SplitMix64(ulong state)
{
    public ulong State { get; private set; } = state;
    public ulong Next()
    {
        unchecked
        {
            State += 0x9E3779B97F4A7C15UL;
            var z = State;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return z ^ (z >> 31);
        }
    }

    public static ulong Derive(ulong masterSeed, string normalizedFabId)
    {
        using var data = new MemoryStream();
        using (var writer = new BinaryWriter(data, Encoding.UTF8, true))
        {
            writer.Write(masterSeed);
            foreach (var field in new[] { "synthetic-fifo-seed-v1", normalizedFabId, "equipment-1", "service" })
            {
                var bytes = Encoding.UTF8.GetBytes(field);
                writer.Write(bytes.Length);
                writer.Write(bytes);
            }
        }
        return BinaryPrimitives.ReadUInt64LittleEndian(SHA256.HashData(data.ToArray()));
    }
}
