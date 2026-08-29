using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Security.Claims;
using Jellyfin.Plugin.Donate.Services;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Donate.Api;

/// <summary>
/// Serves the injected client script and handles the per-user reminder state.
/// </summary>
[ApiController]
[Route("Donate")]
public class DonateController : ControllerBase
{
    private const string JellyfinUserIdClaim = "Jellyfin-UserId";

    private readonly IServerApplicationPaths _paths;
    private readonly ScriptInjectionService _injection;
    private readonly ILogger<DonateController> _logger;

    public DonateController(
        IServerApplicationPaths paths,
        ScriptInjectionService injection,
        ILogger<DonateController> logger)
    {
        _paths = paths;
        _injection = injection;
        _logger = logger;
    }

    /// <summary>
    /// The popup script. Anonymous on purpose: index.html is served to signed-out
    /// visitors too, and the script itself does nothing until someone logs in.
    /// </summary>
    [HttpGet("ClientScript")]
    [AllowAnonymous]
    public ActionResult GetClientScript()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var name = typeof(Plugin).Namespace + ".Web.donate.js";

        using var stream = assembly.GetManifestResourceStream(name);
        if (stream is null)
        {
            _logger.LogError("Donations: embedded resource {Name} is missing from the plugin assembly.", name);
            return NotFound();
        }

        using var reader = new StreamReader(stream);
        Response.Headers.CacheControl = "public, max-age=300";
        return Content(reader.ReadToEnd(), "application/javascript; charset=utf-8");
    }

    /// <summary>Settings plus this user's reminder state.</summary>
    [HttpGet("Config")]
    [Authorize]
    public ActionResult<DonateClientConfig> GetConfig()
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null)
        {
            return new DonateClientConfig { Enabled = false };
        }

        var userId = GetUserId();
        var state = userId is null ? null : DonationStore.Get(userId);
        var isAdmin = User.IsInRole("Administrator");

        var methods = config.Methods
            .Where(m => m.Enabled && !string.IsNullOrWhiteSpace(m.Name))
            .Where(m => !string.IsNullOrWhiteSpace(m.Url) || !string.IsNullOrWhiteSpace(m.Handle))
            .Select(m => new DonateClientMethod
            {
                Id = m.Id,
                Name = m.Name,
                Handle = m.Handle,
                Url = m.Url,
                Instructions = m.Instructions,
                Icon = m.Icon,
                ImageUrl = m.ImageUrl,
                Color = m.Color
            })
            .ToArray();

        return new DonateClientConfig
        {
            Enabled = config.Enabled,
            ShouldPrompt = DonationStore.ShouldPrompt(config, state, isAdmin),
            ShowDontRemindOption = config.ShowDontRemindOption,
            HasDonated = state?.DonatedUtc.HasValue == true,
            DelaySeconds = Math.Clamp(config.DelaySeconds, 0, 600),
            ReminderIntervalDays = Math.Max(0, config.ReminderIntervalDays),
            PopupTitle = config.PopupTitle,
            PopupMessage = config.PopupMessage,
            DonateButtonText = config.DonateButtonText,
            CloseButtonText = config.CloseButtonText,
            DontRemindText = config.DontRemindText,
            DonatePageTitle = config.DonatePageTitle,
            DonatePageMessage = config.DonatePageMessage,
            ThankYouMessage = config.ThankYouMessage,
            DonatedButtonText = config.DonatedButtonText,
            ExternalDonatePageUrl = config.ExternalDonatePageUrl,
            ShowPersistentButton = config.ShowPersistentButton,
            ShowMenuItem = config.ShowMenuItem,
            PersistentButtonText = config.PersistentButtonText,
            Appearance = config.Appearance,
            AccentColor = config.AccentColor,
            AllowHtml = config.AllowHtmlInMessages,
            Methods = methods
        };
    }

    /// <summary>Records that the popup was shown, so the reminder interval can be honoured.</summary>
    [HttpPost("Prompted")]
    [Authorize]
    public ActionResult<DonateAck> RecordPrompted()
    {
        var userId = GetUserId();
        if (userId is null)
        {
            return new DonateAck();
        }

        DonationStore.Update(userId, s => s.LastPromptUtc = DateTime.UtcNow);
        return new DonateAck();
    }

    /// <summary>"Don't remind me again" - stored server-side so it follows the user across devices.</summary>
    [HttpPost("OptOut")]
    [Authorize]
    public ActionResult<DonateAck> SetOptOut([FromBody] OptOutRequest? request)
    {
        var optOut = request?.OptOut ?? true;
        var userId = GetUserId();
        if (userId is null)
        {
            return new DonateAck { OptedOut = optOut };
        }

        DonationStore.Update(userId, s => s.OptedOut = optOut);
        return new DonateAck { OptedOut = optOut };
    }

    /// <summary>The user says they donated: show the thank-you and (optionally) stop prompting.</summary>
    [HttpPost("Donated")]
    [Authorize]
    public ActionResult<DonateAck> MarkDonated()
    {
        var userId = GetUserId();
        if (userId is null)
        {
            return new DonateAck { HasDonated = true };
        }

        DonationStore.Update(userId, s => s.DonatedUtc = DateTime.UtcNow);
        return new DonateAck { HasDonated = true };
    }

    /// <summary>
    /// Why is nothing showing up? Answers that without needing the server logs.
    /// </summary>
    [HttpGet("Status")]
    [Authorize(Policy = "RequiresElevation")]
    public ActionResult<DonateStatus> GetStatus()
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null)
        {
            return new DonateStatus { Problems = ["The plugin is not loaded. Restart Jellyfin."] };
        }

        var injection = ScriptInjectionService.DescribeInjection(_paths.WebPath);
        var enabledMethods = config.Methods.Count(m => m.Enabled && !string.IsNullOrWhiteSpace(m.Name));
        var hasTarget = enabledMethods > 0 || !string.IsNullOrWhiteSpace(config.ExternalDonatePageUrl);
        var problems = new List<string>();

        if (!config.Enabled)
        {
            problems.Add("The plugin is disabled - tick \"Enable the donation plugin\" at the top of this page.");
        }

        if (!injection.IndexExists)
        {
            problems.Add(
                "The web client was not found at " + injection.IndexPath
                + ". If Jellyfin serves its web client from somewhere else (Docker, a reverse proxy), add the "
                + "script tag to that index.html yourself and turn off automatic injection.");
        }
        else if (!injection.ScriptPresent)
        {
            problems.Add(config.AutoInjectClientScript
                ? "The popup script is not in index.html yet"
                    + (injection.Writable
                        ? ". Restart Jellyfin - the script is added at startup."
                        : ", and the file is not writable by Jellyfin. Fix the permissions on "
                          + injection.IndexPath + " or add the script tag manually.")
                : "Automatic script injection is turned off and the script is not in index.html, so nothing "
                    + "will appear in the browser.");
        }

        if (!hasTarget)
        {
            problems.Add(
                "No payment methods are enabled, so the popup stays hidden. Add one under \"Payment methods\" "
                + "below and tick \"Show this method to users\".");
        }

        if (!config.ShowPopup)
        {
            problems.Add("\"Show the popup after users log in\" is turned off.");
        }

        var viewerExcluded = !config.ShowToAdministrators;
        if (viewerExcluded)
        {
            problems.Add(
                "You are an administrator and \"Also show the popup to administrators\" is off, so you will not "
                + "see the popup yourself even when everything else is set up. Use the Preview buttons above to "
                + "check it, or tick that option while testing.");
        }

        return new DonateStatus
        {
            PopupWillShow = config.Enabled && config.ShowPopup && hasTarget && injection.ScriptPresent,
            Problems = problems,
            ScriptInstalled = injection.ScriptPresent,
            WebClientFound = injection.IndexExists,
            WebClientWritable = injection.Writable,
            IndexPath = injection.IndexPath,
            EnabledMethodCount = enabledMethods,
            ViewerExcludedAsAdmin = viewerExcluded
        };
    }

    /// <summary>
    /// Re-runs the index.html patch on demand. Containers lose the web client when they
    /// are recreated, so this repairs it without waiting for a server restart.
    /// </summary>
    [HttpPost("InstallScript")]
    [Authorize(Policy = "RequiresElevation")]
    public ActionResult<DonateStatus> InstallScript()
    {
        try
        {
            _injection.Install();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Donations: on-demand script installation failed.");
        }

        return GetStatus();
    }

    /// <summary>
    /// Resolves the signed-in user from the auth claims only. Deliberately avoids
    /// IUserManager: its user entity moved assemblies in 10.11, and touching it from a
    /// plugin built against a different server version throws at JIT time and takes the
    /// whole endpoint down with it.
    /// </summary>
    private string? GetUserId()
    {
        var claim = User.FindFirstValue(JellyfinUserIdClaim);
        if (!string.IsNullOrEmpty(claim) && Guid.TryParse(claim, out var parsed))
        {
            return parsed.ToString("N");
        }

        // Claim names have changed between server versions before; accept any claim
        // that looks like a user id and holds a GUID.
        foreach (var candidate in User.Claims)
        {
            if (candidate.Type.Contains("UserId", StringComparison.OrdinalIgnoreCase)
                && Guid.TryParse(candidate.Value, out var found))
            {
                return found.ToString("N");
            }
        }

        return null;
    }
}
