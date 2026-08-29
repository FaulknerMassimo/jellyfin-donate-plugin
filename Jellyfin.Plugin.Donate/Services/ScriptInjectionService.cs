using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Donate.Services;

/// <summary>
/// Jellyfin has no supported hook for adding scripts to the web client, so - like
/// Jellyscrub and friends - we patch a single tagged script tag into index.html on
/// startup and whenever the settings change. The tag is removed and rewritten each
/// time, so a server or web-client upgrade just gets it re-applied.
/// </summary>
public sealed class ScriptInjectionService : IHostedService
{
    private const string PluginMarker = "Jellyfin.Plugin.Donate";

    private static readonly Regex _existingTag = new(
        "\\s*<script[^>]*plugin=\"" + PluginMarker + "\"[^>]*>\\s*</script>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly IServerApplicationPaths _paths;
    private readonly ILogger<ScriptInjectionService> _logger;

    public ScriptInjectionService(IServerApplicationPaths paths, ILogger<ScriptInjectionService> logger)
    {
        _paths = paths;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Apply();

        if (Plugin.Instance is not null)
        {
            Plugin.Instance.ConfigurationChanged += OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (Plugin.Instance is not null)
        {
            Plugin.Instance.ConfigurationChanged -= OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    private void OnConfigurationChanged(object? sender, BasePluginConfiguration e) => Apply();

    private void Apply()
    {
        try
        {
            var indexPath = Path.Combine(_paths.WebPath, "index.html");
            if (!File.Exists(indexPath))
            {
                _logger.LogWarning(
                    "Donations: could not find the web client at {Path}. The donation popup will not load. "
                    + "If you use a separate web client (Docker image, reverse proxy, or a client app), add "
                    + "this to its index.html manually: <script plugin=\"{Marker}\" src=\"Donate/ClientScript\" defer></script>",
                    indexPath,
                    PluginMarker);
                return;
            }

            var original = File.ReadAllText(indexPath);
            var inject = Plugin.Instance?.Configuration.AutoInjectClientScript == true;
            var version = Plugin.Instance?.Version?.ToString() ?? "1.0.0.0";

            var wanted = PatchIndexHtml(original, inject, version);
            if (wanted is null)
            {
                _logger.LogWarning("Donations: index.html has no </body> tag, skipping script injection.");
                return;
            }

            if (string.Equals(wanted, original, StringComparison.Ordinal))
            {
                return;
            }

            File.WriteAllText(indexPath, wanted);
            _logger.LogInformation(
                "Donations: {Action} the client script in {Path}. Users may need a hard refresh (Ctrl+Shift+R).",
                Plugin.Instance?.Configuration.AutoInjectClientScript == true ? "installed" : "removed",
                indexPath);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogError(
                ex,
                "Donations: no write permission on the web client directory, so the popup script could not be "
                + "installed. Either make {Path} writable by the Jellyfin user, or add "
                + "<script plugin=\"{Marker}\" src=\"Donate/ClientScript\" defer></script> to index.html yourself.",
                _paths.WebPath,
                PluginMarker);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Donations: failed to update the web client index.html.");
        }
    }

    /// <summary>
    /// Removes any previously injected tag and, when <paramref name="inject"/> is set,
    /// adds a fresh one before &lt;/body&gt;. Pure and idempotent so repeated startups,
    /// version bumps and web-client upgrades all converge on the same output.
    /// Returns null when the document has no &lt;/body&gt; to insert into.
    /// </summary>
    internal static string? PatchIndexHtml(string html, bool inject, string version)
    {
        var stripped = _existingTag.Replace(html, string.Empty);

        if (!inject)
        {
            return stripped;
        }

        var bodyEnd = stripped.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (bodyEnd < 0)
        {
            return null;
        }

        var tag = "<script plugin=\"" + PluginMarker + "\" version=\"" + version
            + "\" src=\"Donate/ClientScript?v=" + version + "\" defer></script>";

        return stripped.Insert(bodyEnd, tag);
    }
}
