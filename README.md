# YouTube Speed Trainer

A Chrome extension that helps you gradually train yourself to watch YouTube videos at higher speeds.

## ✨ Features

- **Time-Based Progression**: Speed increases based on total watch time, not per video — with an on/off toggle
- **Custom Step Sizes**: Keep multiple custom increments; add, pick, or remove them anytime
- **Smart Recommendations**: Get data-driven step-size and level-up suggestions based on how you actually watch
- **Analytics & Time Saved**: See time saved, personal average speed, natural speed range, and per-video breakdowns
- **Progress Reports & Goal Forecasting**: A full report page with charts, a target speed, and an ETA to reach it (export to PDF)
- **Achievements & Streaks**: Unlock milestones from genuine viewing, build streaks, and share achievement cards
- **Visual Keyboard Shortcuts**: Configure shortcuts on an on-screen keyboard with conflict detection and live testing
- **Speed Drops**: When you manually slow down, the extension records the episode with date, time, and video
- **Instant Speed Control**: Adjust speed anytime via the popup or keyboard
- **Persistent Settings**: Your progress and settings sync across sessions

## ⌨️ Keyboard Shortcuts

Control playback speed without leaving the video:

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+↑` | Increase speed |
| `Alt+Shift+↓` | Decrease speed |
| `Alt+Shift+R` | Reset to 1.0× |

**Customize shortcuts:** Go to `chrome://extensions/shortcuts` to set your preferred keys.

A centered speed overlay appears briefly when using shortcuts, so you always know the current speed.

## 🚀 Installation

1. Download and unzip the extension
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the extension folder
5. Start watching YouTube videos!

## 📖 How It Works

### Time-Based Progression

Instead of increasing speed per video (unfair for short clips), the extension tracks your **total watch time**:

| Watch Time | Effect |
|------------|--------|
| 5 minutes  | Progress bar fills |
| 10 minutes | **Level up!** Speed increases |
| 15 minutes | Another level up |
| etc.       | Continues until max speed |

**Why this is better:**
- Watching a 2-hour documentary = 12 level-ups (at 10min threshold)
- Watching twelve 10-second clips = still need real watch time
- Fairer, more consistent progression

### Custom Increments

Not everyone learns at the same pace:

| User Type | Recommended Increment |
|-----------|----------------------|
| Careful learner | 0.02 - 0.05 |
| Average user | 0.05 - 0.10 |
| Speed demon | 0.15 - 0.25 |

Enter any value from 0.01 to 1.00 in the custom input field.

### Speed Drops

The trainer is all about pushing your speed up — but sometimes a video is too fast and you slow it back down. Those moments are your **speed drops**.

Whenever you manually lower the speed (via the popup or `Alt+Shift+↓`), the extension records the *episode*: the speed you dropped **from** (the peak before you backed off) and the lowest speed you dropped **to**. Pressing decrease several times in a row counts as one drop. The episode closes as soon as the speed goes back up — manually or via an automatic level-up.

The popup keeps your **5 biggest drops** by magnitude, e.g. `2.50× → 1.50×  −1.00`, so you can see where you struggled most. They persist across sessions and are cleared by **Reset All**.

## ⚙️ Settings

| Setting | Options | Default |
|---------|---------|---------|
| Step size | 0.01 - 1.00 | 0.05 |
| Level up every | 5m, 10m, 15m, 30m | 10 minutes |

## 🎯 Tips

1. **Use keyboard shortcuts**: Much faster than opening the popup
2. **Start conservative**: Use small increments (0.03-0.05) if you're new
3. **Longer thresholds**: Choose 15-30 minute thresholds for podcasts/lectures
4. **Shorter thresholds**: Choose 5 minute thresholds for quick adaptation

## 📁 Files

```
youtube-speed-trainer/
├── manifest.json    # Extension configuration
├── background.js    # Keyboard shortcut handler & badge
├── content.js       # Video control, time tracking & telemetry
├── analytics.js     # Shared analytics/recommendation/achievement library
├── popup.html       # Extension popup UI (Trainer / Insights / Awards tabs)
├── popup.js         # Popup logic
├── reports.html     # Progress reports & goal forecasting page
├── reports.js       # Reports logic (charts, forecasts, PDF export)
├── shortcuts.html   # Visual keyboard shortcut customizer
├── shortcuts.js     # Shortcut customizer logic
└── icon*.png        # Extension icons
```

## 🔧 Technical Details

- **Manifest V3**: Latest Chrome extension format
- **Commands API**: Native Chrome keyboard shortcuts
- **Time Tracking**: Accurate to 0.5 seconds, ignores background tabs
- **Storage**: chrome.storage.local for persistence
- **Speed Range**: 0.5× to 4.0×

## 🔒 Privacy

This extension:
- Does NOT collect any data
- Does NOT connect to external servers
- Only stores your settings locally in Chrome

## 📝 Changelog

### v1.6
- ✨ Auto-progression on/off toggle
- ✨ Multiple custom step sizes (add / pick / remove) with input validation
- ✨ Insights: time saved, personal average speed, natural speed range
- ✨ Data-driven step-size & level-up recommendations (with a one-click "optimize both")
- ✨ Speed drops now record date, time, and the associated video, in a scrollable list
- ✨ Separate resets: reset personal average (keeps history) vs. delete all history (confirmed)
- ✨ Achievements, ranks & streaks earned from genuine viewing, with shareable cards
- ✨ Progress Reports & Goal Forecasting page with charts, target speed, ETA and PDF export
- ✨ Visual keyboard shortcut customizer with conflict detection and live testing

### v1.5
- ✨ Speed Drops: remembers and shows your biggest manual speed drops

### v1.4
- ✨ Keyboard shortcuts (Alt+Shift+↑/↓/R)
- ✨ Centered speed overlay for visual feedback
- ✨ Customizable shortcuts via Chrome settings

### v1.3
- 🐛 Fixed black screen bug when video initializes
- 🔧 Added video readiness checks

### v1.2
- ✨ Time-based progression (replaces per-video)
- ✨ Custom increment input
- ✨ Visual progress bar
- 🐛 Fixed YouTube detection issues
- 🐛 Fixed real-time speed updates

### v1.1  
- Fixed popup not detecting YouTube pages
- Added real-time speed changes without reload

### v1.0
- Initial release

---

Made with ⚡ for faster learning
