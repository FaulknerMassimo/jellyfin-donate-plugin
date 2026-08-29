using System;

namespace Jellyfin.Plugin.Donate.Configuration;

/// <summary>
/// A single payment option shown on the donate page (PayPal, Venmo, Interac, ...).
/// </summary>
public class DonationMethod
{
    /// <summary>Stable id, used by the config page to track rows.</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>Display name, e.g. "PayPal" or "Interac e-Transfer".</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// The handle/address users need: a PayPal.me name, "@venmo-user", "$cashtag",
    /// or the e-mail address for an Interac e-Transfer. Shown with a copy button.
    /// </summary>
    public string Handle { get; set; } = string.Empty;

    /// <summary>Link opened when the user picks this method. Optional (Interac has none).</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>Free-form note, e.g. "Security question answer: jellyfin".</summary>
    public string Instructions { get; set; } = string.Empty;

    /// <summary>Emoji or short text badge used as the icon.</summary>
    public string Icon { get; set; } = string.Empty;

    /// <summary>Optional image shown inside the card - a logo or a payment QR code.</summary>
    public string ImageUrl { get; set; } = string.Empty;

    /// <summary>Accent colour for this card, e.g. "#0070ba".</summary>
    public string Color { get; set; } = string.Empty;

    /// <summary>Whether the method is shown to users.</summary>
    public bool Enabled { get; set; } = true;
}
