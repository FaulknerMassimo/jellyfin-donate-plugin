using System;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Donate.Configuration;

/// <summary>
/// Admin-editable settings for the donation prompt and donate page.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Master switch. When off, nothing is shown to users.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Patch the web client's index.html so the popup script loads for everyone.</summary>
    public bool AutoInjectClientScript { get; set; } = true;

    // ---- Popup ----

    /// <summary>Show the popup at all. Turn off to keep only the donate page (#donate).</summary>
    public bool ShowPopup { get; set; } = true;

    public string PopupTitle { get; set; } = "Enjoying the server?";

    public string PopupMessage { get; set; } =
        "This Jellyfin server is paid for and maintained out of pocket. "
        + "If you get some value out of it, a small donation goes a long way toward hardware, "
        + "storage and the electricity bill. Totally optional - nothing is locked behind it.";

    public string DonateButtonText { get; set; } = "Yes, I'd like to donate";

    public string CloseButtonText { get; set; } = "Close";

    public string DontRemindText { get; set; } = "Don't remind me again";

    /// <summary>Offer the "Don't remind me again" checkbox.</summary>
    public bool ShowDontRemindOption { get; set; } = true;

    /// <summary>Seconds to wait after login before the popup appears.</summary>
    public int DelaySeconds { get; set; } = 6;

    /// <summary>
    /// Minimum days between popups for the same user. 0 shows it once per browser
    /// session (i.e. essentially every time they open Jellyfin).
    /// </summary>
    public int ReminderIntervalDays { get; set; }

    /// <summary>Also prompt server administrators.</summary>
    public bool ShowToAdministrators { get; set; }

    /// <summary>Stop prompting a user once they have said they donated.</summary>
    public bool StopPromptingAfterDonation { get; set; } = true;

    // ---- Donate page ----

    public string DonatePageTitle { get; set; } = "Support the server";

    public string DonatePageMessage { get; set; } =
        "Pick whichever method is easiest for you. Any amount is appreciated.";

    /// <summary>Shown after the user picks a method or confirms they donated.</summary>
    public string ThankYouMessage { get; set; } =
        "Thank you so much! Your support genuinely keeps this server running. "
        + "It means a lot that you took the time.";

    /// <summary>Text on the "I've donated" confirmation button.</summary>
    public string DonatedButtonText { get; set; } = "I've made a donation";

    /// <summary>
    /// If set, the popup's donate button opens this URL in a new tab instead of
    /// showing the built-in donate page.
    /// </summary>
    public string ExternalDonatePageUrl { get; set; } = string.Empty;

    /// <summary>
    /// Show a small floating "Donate" button in the corner of the web client, so the
    /// donate page stays reachable for people who dismissed the popup. On by default:
    /// without it the donate page has no entry point of its own.
    /// </summary>
    public bool ShowPersistentButton { get; set; } = true;

    /// <summary>Add a "Donate" entry to the web client's sidebar menu.</summary>
    public bool ShowMenuItem { get; set; } = true;

    public string PersistentButtonText { get; set; } = "Donate";

    // ---- Appearance ----

    /// <summary>"auto", "dark" or "light".</summary>
    public string Appearance { get; set; } = "auto";

    public string AccentColor { get; set; } = "#00a4dc";

    /// <summary>Render admin-supplied message text as HTML instead of plain text.</summary>
    public bool AllowHtmlInMessages { get; set; }

    // ---- Data ----

    public DonationMethod[] Methods { get; set; } = CreateDefaultMethods();

    public UserDonationState[] UserStates { get; set; } = Array.Empty<UserDonationState>();

    private static DonationMethod[] CreateDefaultMethods() =>
    [
        new DonationMethod
        {
            Name = "PayPal",
            Icon = "P",
            Color = "#0070ba",
            Url = "https://paypal.me/yourname",
            Handle = "you@example.com",
            Enabled = false
        },
        new DonationMethod
        {
            Name = "Venmo",
            Icon = "V",
            Color = "#3d95ce",
            Url = "https://venmo.com/u/yourname",
            Handle = "@yourname",
            Enabled = false
        },
        new DonationMethod
        {
            Name = "Cash App",
            Icon = "$",
            Color = "#00d54b",
            Url = "https://cash.app/$yourname",
            Handle = "$yourname",
            Enabled = false
        },
        new DonationMethod
        {
            Name = "Interac e-Transfer",
            Icon = "e",
            Color = "#ffb800",
            Handle = "you@example.com",
            Instructions = "Send to the address above. No security question needed - auto-deposit is on.",
            Enabled = false
        }
    ];
}
