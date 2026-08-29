using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Donate.Api;

/// <summary>Everything the web-client script needs, for the signed-in user.</summary>
public class DonateClientConfig
{
    public bool Enabled { get; set; }

    /// <summary>True when the popup is due for this user right now.</summary>
    public bool ShouldPrompt { get; set; }

    public bool ShowDontRemindOption { get; set; }

    public bool HasDonated { get; set; }

    public int DelaySeconds { get; set; }

    /// <summary>0 means "once per browser session"; the client uses sessionStorage for that.</summary>
    public int ReminderIntervalDays { get; set; }

    public string PopupTitle { get; set; } = string.Empty;

    public string PopupMessage { get; set; } = string.Empty;

    public string DonateButtonText { get; set; } = string.Empty;

    public string CloseButtonText { get; set; } = string.Empty;

    public string DontRemindText { get; set; } = string.Empty;

    public string DonatePageTitle { get; set; } = string.Empty;

    public string DonatePageMessage { get; set; } = string.Empty;

    public string ThankYouMessage { get; set; } = string.Empty;

    public string DonatedButtonText { get; set; } = string.Empty;

    public string ExternalDonatePageUrl { get; set; } = string.Empty;

    public bool ShowPersistentButton { get; set; }

    public bool ShowMenuItem { get; set; }

    public string PersistentButtonText { get; set; } = string.Empty;

    public string Appearance { get; set; } = "auto";

    public string AccentColor { get; set; } = string.Empty;

    public bool AllowHtml { get; set; }

    public IReadOnlyList<DonateClientMethod> Methods { get; set; } = Array.Empty<DonateClientMethod>();
}

/// <summary>A payment option as the client sees it.</summary>
public class DonateClientMethod
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Handle { get; set; } = string.Empty;

    public string Url { get; set; } = string.Empty;

    public string Instructions { get; set; } = string.Empty;

    public string Icon { get; set; } = string.Empty;

    public string ImageUrl { get; set; } = string.Empty;

    public string Color { get; set; } = string.Empty;
}

/// <summary>Body of the opt-out request.</summary>
public class OptOutRequest
{
    /// <summary>True to stop reminding, false to start again.</summary>
    public bool OptOut { get; set; } = true;
}

/// <summary>Generic acknowledgement so the client always gets parseable JSON back.</summary>
public class DonateAck
{
    public bool Ok { get; set; } = true;

    public bool OptedOut { get; set; }

    public bool HasDonated { get; set; }
}

/// <summary>Diagnostics for the admin page: is this thing actually working?</summary>
public class DonateStatus
{
    /// <summary>True when everything is set up and at least some users will see the popup.</summary>
    public bool PopupWillShow { get; set; }

    /// <summary>Plain-English reasons the popup is not showing, in the order worth fixing.</summary>
    public IReadOnlyList<string> Problems { get; set; } = Array.Empty<string>();

    public bool ScriptInstalled { get; set; }

    public bool WebClientFound { get; set; }

    public bool WebClientWritable { get; set; }

    public string IndexPath { get; set; } = string.Empty;

    public int EnabledMethodCount { get; set; }

    /// <summary>True when the person viewing the admin page is excluded by the admin setting.</summary>
    public bool ViewerExcludedAsAdmin { get; set; }
}
