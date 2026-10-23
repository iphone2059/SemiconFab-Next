using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Fab.Tests;

public sealed class CatalogApiTests
{
    private const string Key = "catalog-test-development-key-32-characters";
    private static string CatalogDirectory
    {
        get
        {
            var path = new DirectoryInfo(AppContext.BaseDirectory);
            while (path is not null && !Directory.Exists(Path.Combine(path.FullName, "contracts"))) path = path.Parent;
            return Path.Combine(path!.FullName, "assets", "legacy");
        }
    }

    [Fact]
    public async Task CatalogRetainsRawRecordProvenanceAndPriceWithoutChangingSiteState()
    {
        using var factory = Factory();
        using var client = Client(factory);
        using var response = await client.GetAsync("/api/v1/catalog");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var data = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var page = data.RootElement;
        Assert.Equal(253, page.GetProperty("totalCount").GetInt32());
        Assert.Equal(253, page.GetProperty("matchedCount").GetInt32());
        Assert.Equal(24, page.GetProperty("categories").GetArrayLength());
        var first = page.GetProperty("items")[0];
        Assert.Equal("3acd7b05-e6e8-5312-bb5b-045e7dd3074b", first.GetProperty("recordId").GetString());
        Assert.Equal("Canon", first.GetProperty("record").GetProperty("identity").GetProperty("vendor").GetProperty("value").GetString());
        Assert.Equal("vendor_confirmed", first.GetProperty("record").GetProperty("identity").GetProperty("vendor").GetProperty("provenance").GetProperty("tier").GetString());
        Assert.Equal(3500000, first.GetProperty("price").GetProperty("low_usd").GetInt32());
        Assert.Equal("draft", first.GetProperty("legacy").GetProperty("record").GetProperty("record_status").GetString());
        using var detail = await client.GetAsync("/api/v1/catalog/3acd7b05-e6e8-5312-bb5b-045e7dd3074b");
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        using var detailJson = JsonDocument.Parse(await detail.Content.ReadAsStringAsync());
        Assert.Equal(first.GetRawText(), detailJson.RootElement.GetRawText());
        Assert.Equal("[]", await client.GetStringAsync("/api/v1/runs"));
    }

    [Theory]
    [InlineData("domain=OSAT", 86)]
    [InlineData("domain=FAB", 167)]
    [InlineData("q=FPA-5550iZ2", 1)]
    [InlineData("q=not-a-real-tool-12345", 0)]
    public async Task FiltersDoNotLoseRecordsOrReplaceMissingPriceWithZero(string query, int count)
    {
        using var factory = Factory();
        using var client = Client(factory);
        using var response = await client.GetAsync("/api/v1/catalog?" + query);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var data = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(count, data.RootElement.GetProperty("matchedCount").GetInt32());
        Assert.Equal(count, data.RootElement.GetProperty("items").GetArrayLength());
        if (query == "domain=OSAT")
            Assert.All(data.RootElement.GetProperty("items").EnumerateArray(), item =>
            {
                Assert.Equal("OSAT", item.GetProperty("domain").GetString());
                Assert.Equal(JsonValueKind.Null, item.GetProperty("price").ValueKind);
            });
    }

    [Fact]
    public async Task InvalidQueriesAndUnknownRecordsReturnProblems()
    {
        using var factory = Factory();
        using var client = Client(factory);
        foreach (var query in new[] { "domain=private", "q=" + new string('x', 201) })
            Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/v1/catalog?" + query)).StatusCode);
        using var missing = await client.GetAsync("/api/v1/catalog/00000000-0000-0000-0000-000000000000");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task MissingAssetsReturnUnavailableInsteadOfSuccessfulEmptyCatalog()
    {
        using var factory = Factory(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")));
        using var client = Client(factory);
        using var response = await client.GetAsync("/api/v1/catalog");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task CorruptAssetReturnsUnavailableInsteadOfServingUnverifiedData()
    {
        var temporary = Path.Combine(Path.GetTempPath(), "fab-catalog-corruption-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        try
        {
            foreach (var source in Directory.EnumerateFiles(CatalogDirectory, "*", SearchOption.AllDirectories))
            {
                var target = Path.Combine(temporary, Path.GetRelativePath(CatalogDirectory, source));
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(source, target);
            }
            using var pointer = JsonDocument.Parse(File.ReadAllText(Path.Combine(temporary, "current.json")));
            var id = pointer.RootElement.GetProperty("importId").GetString()!;
            File.WriteAllText(Path.Combine(temporary, id, "raw", "catalog.json"), "[]");
            using var factory = Factory(temporary);
            using var client = Client(factory);
            using var response = await client.GetAsync("/api/v1/catalog");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        }
        finally { Directory.Delete(temporary, recursive: true); }
    }

    [Fact]
    public async Task CatalogRequiresExistingDevelopmentIdentity()
    {
        using var factory = Factory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/catalog")).StatusCode);
    }

    private static WebApplicationFactory<Program> Factory(string? directory = null) => new WebApplicationFactory<Program>().WithWebHostBuilder(host =>
    {
        host.UseEnvironment("Development");
        host.UseSetting("Fab:DevelopmentKey", Key);
        host.UseSetting("Fab:DataDirectory", Path.Combine(Path.GetTempPath(), "fab-catalog-tests", Guid.NewGuid().ToString("N")));
        host.UseSetting("Fab:CatalogDirectory", directory ?? CatalogDirectory);
        host.UseSetting("Fab:EmbeddedWorker", "false");
    });

    private static HttpClient Client(WebApplicationFactory<Program> factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Fab-Dev-Key", Key);
        return client;
    }
}
