using System;
using System.Linq;
using Jellyfin.Plugin.Donate.Configuration;

namespace Jellyfin.Plugin.Donate.Services;

/// <summary>
/// Read/write helper for the per-user reminder state that lives in the plugin
/// configuration. All writes are serialised because several users can dismiss
/// the popup at the same time.
/// </summary>
public static class DonationStore
{
    private static readonly object _lock = new();

    public static UserDonationState? Get(string userId)
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null || string.IsNullOrEmpty(userId))
        {
            return null;
        }

        return Array.Find(
            config.UserStates,
            s => string.Equals(s.UserId, userId, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Applies <paramref name="mutate"/> to the user's state (creating it if needed)
    /// and persists the configuration.
    /// </summary>
    public static void Update(string userId, Action<UserDonationState> mutate)
    {
        if (string.IsNullOrEmpty(userId))
        {
            return;
        }

        lock (_lock)
        {
            var plugin = Plugin.Instance;
            if (plugin is null)
            {
                return;
            }

            var config = plugin.Configuration;
            var state = Array.Find(
                config.UserStates,
                s => string.Equals(s.UserId, userId, StringComparison.OrdinalIgnoreCase));

            if (state is null)
            {
                state = new UserDonationState { UserId = userId };
                config.UserStates = [.. config.UserStates, state];
            }

            mutate(state);
            plugin.SaveConfiguration();
        }
    }

    /// <summary>
    /// Decides whether the popup should be shown to this user right now, based on
    /// their opt-out, donation status and the configured reminder interval.
    /// </summary>
    public static bool ShouldPrompt(PluginConfiguration config, UserDonationState? state, bool isAdministrator)
    {
        if (!config.Enabled || !config.ShowPopup)
        {
            return false;
        }

        if (isAdministrator && !config.ShowToAdministrators)
        {
            return false;
        }

        if (!config.Methods.Any(m => m.Enabled) && string.IsNullOrWhiteSpace(config.ExternalDonatePageUrl))
        {
            // Nothing to donate to yet - don't nag people over an empty page.
            return false;
        }

        if (state is null)
        {
            return true;
        }

        if (state.OptedOut)
        {
            return false;
        }

        if (config.StopPromptingAfterDonation && state.DonatedUtc.HasValue)
        {
            return false;
        }

        if (config.ReminderIntervalDays > 0 && state.LastPromptUtc.HasValue)
        {
            var due = state.LastPromptUtc.Value.AddDays(config.ReminderIntervalDays);
            if (DateTime.UtcNow < due)
            {
                return false;
            }
        }

        return true;
    }
}
