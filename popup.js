document.addEventListener('DOMContentLoaded', () => {
    let adSkipperEnabled = true;
    let persistentSpeed = 1.0;
    let globalVolume = 1.0;
    let currentEqPreset = 'flat';
    let autoNextEnabled = true;
    let ambientGlowEnabled = false;
    let watchLaterList = [];
    let durationSec = 0;
    let isDraggingScrubber = false;
    let lastKnownPaused = true; // mirrors the video state for the play/pause icon

    // Elements
    const gmcDomain = document.getElementById('gmc-domain');
    const gmcTitle = document.getElementById('gmc-title');
    const btnPlayPause = document.getElementById('btn-play-pause');
    const gmcScrubber = document.getElementById('gmc-scrubber');
    const timeCurrent = document.getElementById('time-current');
    const timeDuration = document.getElementById('time-duration');
    const cardSpeedSelect = document.getElementById('card-speed-select');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeVal = document.getElementById('volume-val');
    const eqSelect = document.getElementById('eq-select');
    const toggleAdskipper = document.getElementById('toggle-adskipper');
    const toggleAutonext = document.getElementById('toggle-autonext');
    const toggleAmbient = document.getElementById('toggle-ambient');
    const wlCount = document.getElementById('wl-count');
    const wlList = document.getElementById('wl-list');
    const wlContainer = document.getElementById('wl-container');

    // ---- Close button: extension popups support window.close() ----
    document.getElementById('btn-close').addEventListener('click', () => window.close());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.close();
    });

    // ---- Small inline toast (replaces alert()) ----
    function popupToast(text) {
        let t = document.getElementById('sf-popup-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'sf-popup-toast';
            t.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#0f121a;color:#a8c7fa;padding:8px 14px;border-radius:8px;z-index:9999;font-size:11px;font-weight:600;border:1px solid #8ab4f8;box-shadow:0 6px 20px rgba(0,0,0,.6);max-width:90%;text-align:center;';
            document.body.appendChild(t);
        }
        t.innerText = text;
        t.style.display = 'block';
        clearTimeout(t.__timer);
        t.__timer = setTimeout(() => { t.style.display = 'none'; }, 2200);
    }

    function formatTime(s) {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec < 10 ? '0' : ''}${sec}`;
    }

    function setPlayIcon(paused) {
        lastKnownPaused = paused;
        const svgPath = btnPlayPause.querySelector('svg path');
        if (svgPath) {
            svgPath.setAttribute('d', paused ? 'M8 5v14l11-7z' : 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
        }
    }

    // ---- Targeted messaging: talk to exactly ONE frame ----
    // The background service worker remembers which frame owns the video the
    // user is watching (VIDEO_ACTIVE). We send commands there, falling back to
    // the top frame (0) when unknown or unreachable.
    function withTargetTab(cb) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0]) return;
            const tabId = tabs[0].id;
            chrome.runtime.sendMessage({ type: 'GET_TARGET_FRAME', tabId }, (res) => {
                cb(tabId, (res && Number.isInteger(res.frameId)) ? res.frameId : 0);
            });
        });
    }

    function sendToFrame(tabId, frameId, msg) {
        return new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, msg, { frameId }, (res) => {
                if (chrome.runtime.lastError && frameId !== 0) {
                    // Elected frame is gone (navigation, closed iframe) — retry top frame.
                    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (res2) => {
                        resolve(chrome.runtime.lastError ? null : res2);
                    });
                } else {
                    resolve(chrome.runtime.lastError ? null : res);
                }
            });
        });
    }

    function sendTabAction(action, data = {}) {
        withTargetTab((tabId, frameId) => {
            sendToFrame(tabId, frameId, Object.assign({ action }, data));
        });
    }

    // 1. Poll Active Tab for Live Media Status
    function pollLiveMedia() {
        withTargetTab(async (tabId, frameId) => {
            const res = await sendToFrame(tabId, frameId, { action: 'GET_MEDIA_STATUS' });
            if (!res || !res.hasVideo) {
                // No content script or no video on this page — say so instead of
                // leaving "Loading Media..." forever.
                gmcTitle.innerText = 'No video detected on this page';
                gmcDomain.innerText = 'StreamFlow';
                timeCurrent.innerText = '0:00';
                timeDuration.innerText = '0:00';
                durationSec = 0;
                gmcScrubber.value = 0;
                setPlayIcon(true);
                return;
            }
            gmcDomain.innerText = res.hostname || 'Web Video';
            gmcTitle.innerText = res.title || 'Video Player';
            setPlayIcon(!!res.paused);

            durationSec = res.duration || 0;
            timeDuration.innerText = formatTime(durationSec);

            if (!isDraggingScrubber && durationSec > 0) {
                timeCurrent.innerText = formatTime(res.currentTime);
                gmcScrubber.value = (res.currentTime / durationSec) * 100;
            }
        });
    }

    pollLiveMedia();
    setInterval(pollLiveMedia, 500);

    // 2. Transport Button Controls
    btnPlayPause.addEventListener('click', () => {
        // Optimistic flip: the icon updates instantly, the 500ms poll corrects it.
        setPlayIcon(!lastKnownPaused);
        sendTabAction('TOGGLE_PLAY');
    });

    document.getElementById('btn-rewind').addEventListener('click', () => {
        sendTabAction('SEEK_OFFSET', { offset: -10 });
    });

    document.getElementById('btn-forward').addEventListener('click', () => {
        sendTabAction('SEEK_OFFSET', { offset: 10 });
    });

    document.getElementById('btn-prev').addEventListener('click', () => {
        sendTabAction('SEEK_EXACT', { time: 0 });
    });

    document.getElementById('btn-next').addEventListener('click', () => {
        sendTabAction('SEEK_OFFSET', { offset: 30 });
    });

    document.getElementById('btn-pip').addEventListener('click', () => {
        sendTabAction('TRIGGER_PIP');
    });

    // Scrubber Dragging
    gmcScrubber.addEventListener('input', (e) => {
        isDraggingScrubber = true;
        if (durationSec > 0) {
            const targetTime = (parseFloat(e.target.value) / 100) * durationSec;
            timeCurrent.innerText = formatTime(targetTime);
        }
    });

    gmcScrubber.addEventListener('change', (e) => {
        isDraggingScrubber = false;
        if (durationSec > 0) {
            const targetTime = (parseFloat(e.target.value) / 100) * durationSec;
            sendTabAction('SEEK_EXACT', { time: targetTime });
        }
    });

    // 3. Storage Sync
    const storageKeys = [
        'cs_ad_skipper_enabled', 'cs_playback_speed', 'cs_global_volume',
        'cs_eq_preset', 'cs_auto_next', 'cs_ambient_glow', 'cs_watch_later'
    ];

    chrome.storage.local.get(storageKeys, (localData) => {
        chrome.storage.sync.get(storageKeys, (syncData) => {
            const data = Object.assign({}, syncData, localData);
            if (data.cs_ad_skipper_enabled !== undefined) adSkipperEnabled = data.cs_ad_skipper_enabled;
            if (data.cs_playback_speed) persistentSpeed = parseFloat(data.cs_playback_speed);
            if (data.cs_global_volume !== undefined) globalVolume = parseFloat(data.cs_global_volume);
            if (data.cs_eq_preset) currentEqPreset = data.cs_eq_preset;
            if (data.cs_auto_next !== undefined) autoNextEnabled = data.cs_auto_next;
            if (data.cs_ambient_glow !== undefined) ambientGlowEnabled = data.cs_ambient_glow;
            if (data.cs_watch_later) watchLaterList = data.cs_watch_later;

            // Sync UI
            cardSpeedSelect.value = persistentSpeed.toString();
            volumeSlider.value = Math.round(globalVolume * 100);
            volumeVal.innerText = `${Math.round(globalVolume * 100)}%`;
            eqSelect.value = currentEqPreset;
            toggleAdskipper.classList.toggle('active', adSkipperEnabled);
            toggleAutonext.classList.toggle('active', autoNextEnabled);
            toggleAmbient.classList.toggle('active', ambientGlowEnabled);
            renderWatchLater();
        });
    });

    let syncTimer = null;
    function saveSettings() {
        const obj = {
            cs_ad_skipper_enabled: adSkipperEnabled,
            cs_playback_speed: persistentSpeed,
            cs_global_volume: globalVolume,
            cs_eq_preset: currentEqPreset,
            cs_auto_next: autoNextEnabled,
            cs_ambient_glow: ambientGlowEnabled
        };
        chrome.storage.local.set(obj);

        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            chrome.storage.sync.set(obj).catch(() => {});
        }, 500);

        sendTabAction('UPDATE_SETTINGS', {
            settings: {
                adSkipperEnabled,
                persistentSpeed,
                globalVolume,
                eqPreset: currentEqPreset,
                autoNextEnabled,
                ambientGlowEnabled,
                autoUnmuteEnabled: true,
                miniHudEnabled: true,
                forceHighResEnabled: true
            }
        });
    }

    cardSpeedSelect.addEventListener('change', (e) => {
        persistentSpeed = parseFloat(e.target.value);
        saveSettings();
    });

    volumeSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        globalVolume = val / 100;
        volumeVal.innerText = `${val}%`;
        saveSettings();
    });

    eqSelect.addEventListener('change', (e) => {
        currentEqPreset = e.target.value;
        saveSettings();
    });

    toggleAdskipper.addEventListener('click', () => {
        adSkipperEnabled = !adSkipperEnabled;
        toggleAdskipper.classList.toggle('active', adSkipperEnabled);
        saveSettings();
    });

    toggleAutonext.addEventListener('click', () => {
        autoNextEnabled = !autoNextEnabled;
        toggleAutonext.classList.toggle('active', autoNextEnabled);
        saveSettings();
    });

    toggleAmbient.addEventListener('click', () => {
        ambientGlowEnabled = !ambientGlowEnabled;
        toggleAmbient.classList.toggle('active', ambientGlowEnabled);
        saveSettings();
    });

    // Tool Actions
    document.getElementById('btn-ab-a').addEventListener('click', () => sendTabAction('SET_AB_A'));
    document.getElementById('btn-ab-b').addEventListener('click', () => sendTabAction('SET_AB_B'));
    document.getElementById('btn-ab-clear').addEventListener('click', () => sendTabAction('CLEAR_AB'));
    document.getElementById('btn-frame-back').addEventListener('click', () => sendTabAction('STEP_FRAME_BACK'));
    document.getElementById('btn-frame-fwd').addEventListener('click', () => sendTabAction('STEP_FRAME_FWD'));
    document.getElementById('btn-shot').addEventListener('click', () => sendTabAction('TRIGGER_SCREENSHOT'));

    // Watch Later Drawer Toggle
    document.getElementById('row-wl-toggle').addEventListener('click', (e) => {
        if (e.target.id !== 'btn-save-wl') {
            wlContainer.classList.toggle('open');
        }
    });

    // 4. WATCH LATER QUEUE RENDERER
    function renderWatchLater() {
        wlCount.innerText = watchLaterList.length;
        chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: watchLaterList.length });
        wlList.innerHTML = '';

        if (watchLaterList.length === 0) {
            wlList.innerHTML = '<div style="color:#8a92a6; text-align:center; padding:12px; font-size:11px;">Queue is empty.<br>Click + Save Video to bookmark!</div>';
            return;
        }

        watchLaterList.forEach(item => {
            const el = document.createElement('div');
            el.className = 'wl-item';
            el.innerHTML = `
                <div class="wl-title" title="${item.title}">${item.title}</div>
                <div style="font-size:9px; color:#8a92a6; display:flex; justify-content:space-between;">
                    <span>📅 ${item.date}</span>
                    <span style="color:var(--gmc-blue); font-weight:bold;">${item.site || 'Web'}</span>
                </div>
                <div class="wl-actions">
                    <button class="wl-btn-play">▶ Play</button>
                    <button class="wl-btn-del">✕</button>
                </div>
            `;
            el.querySelector('.wl-btn-play').addEventListener('click', () => {
                chrome.tabs.create({ url: item.url });
            });
            el.querySelector('.wl-btn-del').addEventListener('click', () => {
                watchLaterList = watchLaterList.filter(i => i.id !== item.id);
                chrome.storage.local.set({ cs_watch_later: watchLaterList });
                renderWatchLater();
            });
            wlList.appendChild(el);
        });
    }

    // 5. "SAVE VIDEO" HANDLER
    document.getElementById('btn-save-wl').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0]) return;

            chrome.tabs.sendMessage(tabs[0].id, { action: 'GET_METADATA' }, { frameId: 0 }, (res) => {
                let finalUrl = (res && res.url) || tabs[0].url || '';
                let finalTitle = (res && res.title) || tabs[0].title || 'Saved Video';
                let site = (res && res.site) || 'Web';

                if (!finalUrl || finalUrl === 'about:blank' || finalUrl.startsWith('chrome://')) {
                    popupToast('⚠️ Please open or play a video first!');
                    return;
                }

                // Check duplicate
                if (watchLaterList.some(i => i.url === finalUrl)) {
                    popupToast('ℹ️ Video is already in your Watch Later queue!');
                    wlContainer.classList.add('open');
                    return;
                }

                const newItem = {
                    id: Date.now(),
                    title: finalTitle.slice(0, 65),
                    url: finalUrl,
                    site: site,
                    date: new Date().toLocaleDateString()
                };

                watchLaterList.unshift(newItem);
                chrome.storage.local.set({ cs_watch_later: watchLaterList }, () => {
                    renderWatchLater();
                    wlContainer.classList.add('open');
                });
            });
        });
    });
});
