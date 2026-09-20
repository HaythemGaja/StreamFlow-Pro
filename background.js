// StreamFlow Pro — background service worker (MV3)
// 1) Watch Later badge counter.
// 2) Per-tab "active video frame" registry. The content script runs in every
//    frame (all_frames), so the popup must talk to exactly ONE frame — the one
//    whose video the user is actually watching — instead of broadcasting to
//    every iframe. Each frame reports VIDEO_ACTIVE when its video plays or is
//    clicked; the popup asks GET_TARGET_FRAME before sending any command.

const activeFrameByTab = {}; // tabId -> frameId

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPDATE_BADGE') {
    const count = message.count > 0 ? message.count.toString() : '';
    chrome.action.setBadgeText({ text: count });
    chrome.action.setBadgeBackgroundColor({ color: '#f5b041' });
    return; // synchronous, no response needed
  }

  if (message.type === 'VIDEO_ACTIVE' && sender.tab && Number.isInteger(sender.frameId)) {
    activeFrameByTab[sender.tab.id] = sender.frameId;
    return;
  }

  if (message.type === 'GET_TARGET_FRAME' && Number.isInteger(message.tabId)) {
    sendResponse({ frameId: activeFrameByTab[message.tabId] ?? 0 });
    return;
  }
});

// Forget dead tabs so we never target a stale frame.
chrome.tabs.onRemoved.addListener((tabId) => {
  delete activeFrameByTab[tabId];
});
