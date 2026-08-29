using System;

namespace Jellyfin.Plugin.Donate.Configuration;

/// <summary>
/// Per-user bookkeeping for the reminder: opt-outs, last prompt, donation acknowledgement.
/// </summary>
public class UserDonationState
{
    /// <summary>Jellyfin user id, "N" format (no dashes).</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>Set when the user ticks "Don't remind me again".</summary>
    public bool OptedOut { get; set; }

    /// <summary>Last time the popup was actually shown to this user.</summary>
    public DateTime? LastPromptUtc { get; set; }

    /// <summary>Set when the user says they have donated.</summary>
    public DateTime? DonatedUtc { get; set; }
}
