using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Claims;
using Jellyfin.Plugin.Donate.Configuration;
using Jellyfin.Plugin.Donate.Services;
using MediaBrowser.Controller.Library;
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

    private readonly IUserManager _userManager;
    private readonly ILogger<DonateController> _logger;

    public DonateController(IUserManager userManager, ILogger<DonateController> logger)
    {
        _userManager = userManager;
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
    /// Jellyfin puts the user id in a private claim; fall back to resolving the
    /// username in case that claim name changes between server versions.
    /// </summary>
    private string? GetUserId()
    {
        var claim = User.FindFirstValue(JellyfinUserIdClaim);
        if (!string.IsNullOrEmpty(claim) && Guid.TryParse(claim, out var parsed))
        {
            return parsed.ToString("N");
        }

        var username = User.Identity?.Name;
        if (!string.IsNullOrEmpty(username))
        {
            var user = _userManager.GetUserByName(username);
            if (user is not null)
            {
                return user.Id.ToString("N");
            }
        }

        return null;
    }
}
