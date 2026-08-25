// YouTube Speed Trainer - Background Service Worker
// Handles keyboard shortcuts via Chrome Commands API

chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Speed Trainer] Command received:', command);
  
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab || !tab.url) return;
  
  // Only work on YouTube
  const url = tab.url.toLowerCase();
  if (!url.includes('youtube.com')) {
    console.log('[Speed Trainer] Not on YouTube, ignoring command');
    return;
  }
  
  // Send command to content script
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'KEYBOARD_COMMAND',
      command: command
    });
  } catch (error) {
    console.log('[Speed Trainer] Could not send command to tab:', error.message);
    
    // Try to inject content script and retry
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      
      // Wait a bit for script to initialize
      await new Promise(r => setTimeout(r, 200));
      
      // Retry sending the command
      await chrome.tabs.sendMessage(tab.id, {
        type: 'KEYBOARD_COMMAND',
        command: command
      });
    } catch (retryError) {
      console.error('[Speed Trainer] Failed to execute command:', retryError.message);
    }
  }
});

// Log when extension is installed/updated
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Speed Trainer] Extension installed/updated:', details.reason);
  
  if (details.reason === 'install') {
    // Set default values on first install
    chrome.storage.local.set({
      currentSpeed: 1.0,
      increment: 0.05,
      timeThreshold: 600,
      watchedTime: 0,
      autoProgressionEnabled: true,
      customStepSizes: [0.05, 0.1, 0.2]
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "UPDATE_BADGE") {
    const speed = message.speed;

    // Format: z.B. "1.25x"
    const text = speed.toFixed(1) + "x";

    chrome.action.setBadgeText({
      tabId: sender.tab.id,
      text: text
    });

    chrome.action.setBadgeBackgroundColor({
      tabId: sender.tab.id,
      color: "#00d4aa"
    });
  }
});