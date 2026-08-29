using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.Donate.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Donate;

/// <summary>
/// Entry point. Adds a donation prompt to the web client and a configurable donate page.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Donations";

    public override Guid Id => Guid.Parse("b1f0a5c2-3d7e-4a91-9c5f-2e8d4a6b7c30");

    public override string Description =>
        "Asks users at login whether they would like to donate to whoever hosts the server, "
        + "with a donate page listing the payment methods you configure.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Configuration.configPage.html",
                GetType().Namespace)
        };
    }
}
