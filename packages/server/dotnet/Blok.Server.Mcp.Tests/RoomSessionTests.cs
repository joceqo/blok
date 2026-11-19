using System.Text.Json.Nodes;
using Blok.Server.Agent;
using Blok.Server.Collab;
using Blok.Server.Mcp.Core;
using Blok.Server.Mcp.Outbound;
using Xunit;

namespace Blok.Server.Mcp.Tests;

/// <summary>The library form: live handles on rooms this app hosts, in process.</summary>
public sealed class RoomSessionTests : IClassFixture<BundleFixture>, IDisposable
{
  private const string Locked = """
      {"blocks":[{"id":"db","type":"database","content":[],"data":{"title":"Payroll","activeViewId":"v",
      "schema":[{"id":"t","name":"Name","type":"title","position":"a0","databaseLocked":true}],
      "views":[{"id":"v","name":"Table","type":"table","position":"a0","sorts":[],"filters":[],"visibleProperties":[]}]}}]}
      """;

  private readonly string dir = Directory.CreateTempSubdirectory("blok-mcp-rooms-").FullName;
  private readonly BundleFixture fixture;

  public RoomSessionTests(BundleFixture fixture)
  {
    this.fixture = fixture;
  }

  public void Dispose()
  {
    Directory.Delete(dir, recursive: true);
  }

  private sealed class OneDocument(string json) : IDocEndpointClient
  {
    public Task<LoadedDocument> LoadAsync(string docId, CancellationToken cancellationToken)
    {
      return Task.FromResult(new LoadedDocument(JsonNode.Parse(json), null));
    }

    public Task<string?> SaveAsync(string docId, JsonNode outputData, string? version, DocProjection? projection, CancellationToken cancellationToken)
    {
      return Task.FromResult<string?>(null);
    }
  }

  private McpServerCore Core(string document, IBlokPageCreator? creator = null, McpAuthorize? authorize = null, bool pageMap = false)
  {
    var runtime = fixture.Host.Bundle.Runtime;
    var converter = new CollabDocConverter(TimeProvider.System, new RuntimeRichTextHtmlReader(runtime));
    var rooms = new CollabRoomManager(
        new LocalCollabStore(Path.Combine(dir, "rooms")), new OneDocument(document), converter, new CollabRoomOptions(), TimeProvider.System,
        null, new LocalCollabOperationStore(Path.Combine(dir, "journal")));

    return new McpServerCore(fixture.Host.Bundle, new McpConfig { Rooms = new BlokAgentExecutor(runtime, rooms, converter), PageTitles = pageMap ? "page-map" : null, PageCreator = creator, Authorize = authorize }, new McpHttpCaller());
  }

  private static async Task<JsonObject> CallAsync(McpServerCore core, McpCaller caller, string name, JsonObject arguments, JsonNode? replies = null)
  {
    var outcome = await core.CallToolAsync(name, arguments, caller, new McpApproval(new JsonObject { ["elicitation"] = new JsonObject() }, replies, caller.ClientName), CancellationToken.None);

    return outcome.Ask ?? (JsonObject)outcome.Answer!["structuredContent"]!;
  }

  private static JsonObject InsertPage(string id) => new()
  {
    ["name"] = "block.insert", ["args"] = new JsonObject { ["type"] = "page", ["id"] = id, ["position"] = "end" },
  };

  [Fact]
  public async Task HostCreatedRoomPagesCanBeInsertedRenamedAndOpenedWithTheAuthenticatedPrincipal()
  {
    var creator = new HostPageCreatorTests.FakeCreator("child");
    var checkedAccess = new List<(string Principal, string Document, bool Write)>();
    await using var core = Core("""{"blocks":[]}""", creator, (principal, document, write, _) =>
    {
      checkedAccess.Add((principal, document, write));
      return Task.FromResult(true);
    }, pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = true }))["handle"];
    var otherClient = await core.CallerAsync("alice", "phone", null, CancellationToken.None);
    var inserted = await CallAsync(core, otherClient, "blok_execute", new JsonObject { ["handle"] = handle, ["commands"] = new JsonArray(InsertPage("pg")) });

    Assert.True((bool?)inserted["ok"] == true, inserted.ToJsonString());
    var request = Assert.Single(creator.Requests);
    Assert.Equal("alice", request.Principal);
    Assert.Equal("parent", request.ParentDocumentId);
    Assert.Equal((string?)caller.Actor["id"], request.Actor.Id);
    Assert.Matches("^[A-Za-z0-9_-]{10}$", request.SuggestedPageId);

    var renamed = await CallAsync(core, caller, "blok_execute", new JsonObject
    {
      ["handle"] = handle,
      ["commands"] = new JsonArray(new JsonObject { ["name"] = "page.rename", ["args"] = new JsonObject { ["id"] = "pg", ["title"] = "Commits" } }),
    });
    Assert.True((bool?)renamed["ok"] == true, renamed.ToJsonString());
    Assert.Contains(("alice", "child", true), checkedAccess);
    var child = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "child" }))["handle"];
    var read = await CallAsync(core, caller, "blok_read", new JsonObject { ["handle"] = child });
    Assert.Equal("Commits", (string?)read["page"]?["title"]);
  }

  [Fact]
  public async Task ALinkedRoomCannotBeRenamedWithoutTheOpenersWriteAccess()
  {
    var access = new List<(string Principal, string Document, bool Write)>();
    await using var core = Core("""{"blocks":[{"id":"pg","type":"page","data":{"pageId":"secret"}}]}""", authorize: (principal, document, write, _) =>
    {
      access.Add((principal, document, write));
      return Task.FromResult(document == "parent");
    }, pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    caller.Actor["onBehalfOf"] = "mallory";
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = true }))["handle"];
    var ran = await CallAsync(core, caller, "blok_execute", new JsonObject
    {
      ["handle"] = handle,
      ["commands"] = new JsonArray(new JsonObject { ["name"] = "page.rename", ["args"] = new JsonObject { ["id"] = "pg", ["title"] = "Denied" } }),
    });
    Assert.Equal("FORBIDDEN", (string?)ran["error"]?["code"]);
    Assert.Contains(access, item => item.Principal == "alice" && item.Document == "secret");
    Assert.DoesNotContain(access, item => item.Principal == "mallory");
  }

  [Fact]
  public async Task HostedRoomsWithoutACreatorRefusePageInsertion()
  {
    await using var core = Core("""{"blocks":[]}""", pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = true }))["handle"];
    var ran = await CallAsync(core, caller, "blok_execute", new JsonObject { ["handle"] = handle, ["commands"] = new JsonArray(InsertPage("pg")) });
    Assert.NotEqual(true, (bool?)ran["ok"]);
    var read = await CallAsync(core, caller, "blok_read", new JsonObject { ["handle"] = handle });
    Assert.Empty(read["blocks"]!.AsArray());
  }

  [Fact]
  public async Task AReadOnlyRoomNeverCallsTheHostCreator()
  {
    var creator = new HostPageCreatorTests.FakeCreator("child");
    await using var core = Core("""{"blocks":[]}""", creator, pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = false }))["handle"];
    var ran = await CallAsync(core, caller, "blok_execute", new JsonObject { ["handle"] = handle, ["commands"] = new JsonArray(InsertPage("pg")) });
    Assert.Equal("READ_ONLY", (string?)ran["error"]?["code"]);
    Assert.Empty(creator.Requests);
  }

  [Fact]
  public async Task AReadOnlyRoomCannotResolveOrRenameALinkedPage()
  {
    var access = new List<string>();
    await using var core = Core("""{"blocks":[{"id":"pg","type":"page","data":{"pageId":"child"}}]}""", authorize: (_, document, _, _) =>
    {
      access.Add(document);
      return Task.FromResult(true);
    }, pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = false }))["handle"];
    var ran = await CallAsync(core, caller, "blok_execute", new JsonObject
    {
      ["handle"] = handle,
      ["commands"] = new JsonArray(new JsonObject { ["name"] = "page.rename", ["args"] = new JsonObject { ["id"] = "pg", ["title"] = "Denied" } }),
    });
    Assert.Equal("READ_ONLY", (string?)ran["error"]?["code"]);
    Assert.DoesNotContain("child", access);
  }

  [Theory]
  [InlineData(false)]
  [InlineData(true)]
  public async Task AHostRefusalLeavesTheParentUntouchedAndReportsAnyCreatedRoom(bool afterFirst)
  {
    var creator = afterFirst ? new HostPageCreatorTests.FakeCreator("child", null) : new HostPageCreatorTests.FakeCreator((object?)null);
    await using var core = Core("""{"blocks":[]}""", creator, pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = true }))["handle"];
    var commands = new JsonArray(InsertPage("pg"));
    if (afterFirst) commands.Add(InsertPage("pg2"));
    var ran = await CallAsync(core, caller, "blok_execute", new JsonObject { ["handle"] = handle, ["commands"] = commands });
    Assert.Equal(afterFirst ? "ORPHANED_SIDE_EFFECT" : "FORBIDDEN", (string?)ran["error"]?["code"]);
    if (afterFirst)
    {
      Assert.Equal("child", (string?)ran["error"]?["details"]?["orphaned"]?[0]?["prepared"]?["pageId"]);
      Assert.Equal("FORBIDDEN", (string?)ran["error"]?["details"]?["cause"]?["code"]);
    }
    var read = await CallAsync(core, caller, "blok_read", new JsonObject { ["handle"] = handle });
    Assert.Empty(read["blocks"]!.AsArray());
  }

  [Theory]
  [InlineData(false)]
  [InlineData(true)]
  public async Task HostErrorsAreSanitizedAndReportEarlierCreatedRooms(bool afterFirst)
  {
    var secret = new InvalidOperationException("private backend credentials");
    var creator = afterFirst ? new HostPageCreatorTests.FakeCreator("child", secret) : new HostPageCreatorTests.FakeCreator(secret);
    await using var core = Core("""{"blocks":[]}""", creator, pageMap: true);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "parent", ["write"] = true }))["handle"];
    var commands = new JsonArray(InsertPage("pg"));
    if (afterFirst) commands.Add(InsertPage("pg2"));
    var ran = await CallAsync(core, caller, "blok_execute", new JsonObject { ["handle"] = handle, ["commands"] = commands });
    Assert.Equal(afterFirst ? "ORPHANED_SIDE_EFFECT" : "SOURCE_UNAVAILABLE", (string?)ran["error"]?["code"]);
    Assert.DoesNotContain("private backend credentials", ran.ToJsonString(), StringComparison.Ordinal);
    if (afterFirst)
    {
      Assert.Equal("child", (string?)ran["error"]?["details"]?["orphaned"]?[0]?["prepared"]?["pageId"]);
      Assert.Equal("APPLY_FAILED", (string?)ran["error"]?["details"]?["cause"]?["code"]);
    }
  }

  [Fact]
  public async Task OpensLiveOnTheHostsRoomWithTheLiveContract()
  {
    await using var core = Core("""{"blocks":[]}""");
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var surface = await core.SurfaceAsync();

    var opened = await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "doc", ["write"] = true });

    Assert.Equal("live", (string?)opened["mode"]);
    Assert.Equal("acknowledged", (string?)opened["durability"]);
    Assert.Equal((string?)surface["contractRevision"]?["live"], (string?)opened["contractRevision"]);
  }

  [Fact]
  public async Task WritesIntoTheRoomAndReadsItBack()
  {
    await using var core = Core("""{"blocks":[]}""");
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var handle = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "doc", ["write"] = true }))["handle"];

    var wrote = await CallAsync(core, caller, "blok_execute", new JsonObject
    {
      ["handle"] = handle,
      ["commands"] = new JsonArray(new JsonObject { ["name"] = "doc.setTitle", ["args"] = new JsonObject { ["title"] = "Plan" } }),
    });
    var read = await CallAsync(core, caller, "blok_read", new JsonObject { ["handle"] = handle });

    Assert.True((bool?)wrote["ok"] == true, wrote.ToJsonString());
    Assert.Equal(true, (bool?)wrote["delivery"]?["durable"]);
    Assert.NotNull((string?)wrote["delivery"]?["serverSequence"]);
    Assert.Equal("Plan", (string?)read["page"]?["title"]);
  }

  [Fact]
  public async Task AnUnlockAsksAndAReadOnlyHandleIsRefused()
  {
    await using var core = Core(Locked);
    var caller = await core.CallerAsync("alice", "desk", null, CancellationToken.None);
    var writer = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "doc", ["write"] = true }))["handle"];
    var reader = (string?)(await CallAsync(core, caller, "blok_open", new JsonObject { ["documentId"] = "doc" }))["handle"];
    var unlock = new JsonArray(new JsonObject { ["name"] = "database.setLock", ["args"] = new JsonObject { ["id"] = "db", ["locked"] = false } });

    var asked = await CallAsync(core, caller, "blok_execute", new JsonObject { ["handle"] = writer, ["commands"] = unlock.DeepClone() });
    var refused = await CallAsync(core, caller, "blok_execute", new JsonObject { ["handle"] = reader, ["commands"] = unlock.DeepClone() });

    Assert.Equal("""["database.unlock","db","Payroll"]""", (string?)asked["key"]);
    Assert.Equal("READ_ONLY", (string?)refused["error"]?["code"]);
  }
}
