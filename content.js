(function() {
    let adSkipperEnabled = true;
    let autoNextEnabled = true;
    let autoUnmuteEnabled = true;
    let persistentSpeed = 1.0;
    let globalVolume = 1.0;
    let ambientGlowEnabled = false;
    let miniHudEnabled = true;
    let currentEqPreset = 'flat';
    let forceHighResEnabled = true;
    let hasUserInteracted = false;

    let abLoop = { a: null, b: null, active: false };
    let audioCtx = null;
    let gainNode = null;
    let bassFilter = null;
    let vocalFilter = null;
    let hudFadeTimer = null;
    let lastVideo = null; // most recently interacted-with video in THIS frame

    // Tell the background worker that the video the user is watching lives in
    // this frame, so the popup sends commands to exactly this frame instead of
    // broadcasting to every iframe on the page.
    function noteVideoActive(v) {
        if (!v || isAdVideo(v)) return;
        lastVideo = v;
        try { chrome.runtime.sendMessage({ type: 'VIDEO_ACTIVE' }); } catch (e) {}
    }

    ['click', 'keydown', 'pointerdown', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, () => { hasUserInteracted = true; }, { once: true, capture: true });
    });

    function loadAllSettings(callback) {
        const keys = [
            'cs_ad_skipper_enabled', 'cs_auto_next', 'cs_auto_unmute', 'cs_playback_speed',
            'cs_global_volume', 'cs_ambient_glow', 'cs_mini_hud', 'cs_eq_preset',
            'cs_force_high_res'
        ];
        
        chrome.storage.local.get(keys, (localData) => {
            chrome.storage.sync.get(keys, (syncData) => {
                const data = Object.assign({}, syncData, localData);
                if (data.cs_ad_skipper_enabled !== undefined) adSkipperEnabled = data.cs_ad_skipper_enabled;
                if (data.cs_auto_next !== undefined) autoNextEnabled = data.cs_auto_next;
                if (data.cs_auto_unmute !== undefined) autoUnmuteEnabled = data.cs_auto_unmute;
                if (data.cs_playback_speed) persistentSpeed = parseFloat(data.cs_playback_speed);
                if (data.cs_global_volume !== undefined) globalVolume = parseFloat(data.cs_global_volume);
                if (data.cs_ambient_glow !== undefined) ambientGlowEnabled = data.cs_ambient_glow;
                if (data.cs_mini_hud !== undefined) miniHudEnabled = data.cs_mini_hud;
                if (data.cs_eq_preset) currentEqPreset = data.cs_eq_preset;
                if (data.cs_force_high_res !== undefined) forceHighResEnabled = data.cs_force_high_res;

                if (callback) callback();
            });
        });
    }

    function saveSetting(key, val) {
        const obj = { [key]: val };
        chrome.storage.local.set(obj);
        chrome.storage.sync.set(obj);
    }

    loadAllSettings(() => {
        enforcePersistentMedia();
        applyAmbientGlow();
    });

    function showToast(text, color = '#00f2fe') {
        let toast = document.getElementById('streamflow-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'streamflow-toast';
            document.body.appendChild(toast);
        }
        toast.innerText = text;
        toast.style.cssText = `position:fixed;top:35px;right:25px;background:rgba(15,18,26,0.95);color:${color};padding:10px 18px;border-radius:10px;z-index:2147483647;font-size:12px;font-weight:bold;border:1px solid ${color};box-shadow:0 8px 25px rgba(0,0,0,0.7);pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;`;
        clearTimeout(window.__sfToastTimer);
        window.__sfToastTimer = setTimeout(() => { if (toast) toast.remove(); }, 1800);
    }

    function getAllVideos() {
        return Array.from(document.querySelectorAll('video'));
    }

    function getActiveVideo() {
        const vids = getAllVideos().filter(v => v.readyState > 0);
        if (vids.length === 0) return null;
        // Prefer the video the user last interacted with in this frame.
        if (lastVideo && lastVideo.isConnected && vids.includes(lastVideo)) return lastVideo;
        // Otherwise pick the largest visible video — not the first hidden one
        // (e.g. a preview or ad element sitting first in the DOM).
        let best = vids[0];
        let bestArea = -1;
        for (const v of vids) {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area > bestArea) { bestArea = area; best = v; }
        }
        return best;
    }

    function isAdVideo(v) {
        if (!v) return false;
        if (document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ad-interrupting')) return true;
        const adContainer = v.closest('.ad-container, [class*="video-ad"], [id*="player_ad"], [class*="vast-"], [class*="ima-"], .jw-ad, .vjs-ad');
        if (adContainer) return true;
        const src = (v.currentSrc || v.src || '').toLowerCase();
        return src.includes('/ad/') || src.includes('doubleclick') || src.includes('googleads') || src.includes('vast');
    }

    // 1. Playback Persistence
    function enforcePersistentMedia() {
        const vids = getAllVideos();
        vids.forEach(v => {
            if (!isAdVideo(v)) {
                if (v.playbackRate !== persistentSpeed) v.playbackRate = persistentSpeed;
                if (Math.abs(v.volume - globalVolume) > 0.05) v.volume = globalVolume;
            }
        });
    }

    document.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO' && !isAdVideo(e.target)) {
            noteVideoActive(e.target);
            e.target.playbackRate = persistentSpeed;
            e.target.volume = globalVolume;
            if (!location.hostname.includes('tiktok.com')) {
                initAudioEqualizer(e.target);
            }
            renderUpperCenterHudOnVideo(e.target);
        }
    }, true);

    // Clicking a video also elects it as the one the popup controls.
    document.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') noteVideoActive(e.target);
    }, true);

    document.addEventListener('pause', () => {
        updateMiniHudPlayState();
    }, true);

    document.addEventListener('loadedmetadata', (e) => {
        if (e.target && e.target.tagName === 'VIDEO' && !isAdVideo(e.target)) {
            e.target.playbackRate = persistentSpeed;
            e.target.volume = globalVolume;
            if (forceHighResEnabled && location.hostname.includes('youtube.com')) {
                forceYouTubeMaxResolution();
            }
        }
    }, true);

    // Some players (Facebook, Instagram) restore their OWN volume whenever you
    // seek — so re-assert ours right after every seek, plus a 1s safety net in
    // case a site rewrites volume/speed at any other moment.
    document.addEventListener('seeked', (e) => {
        if (e.target && e.target.tagName === 'VIDEO' && !isAdVideo(e.target)) {
            const v = e.target;
            if (v.playbackRate !== persistentSpeed) v.playbackRate = persistentSpeed;
            if (Math.abs(v.volume - globalVolume) > 0.01) v.volume = globalVolume;
        }
    }, true);

    setInterval(() => { enforcePersistentMedia(); }, 1000);

    // 2. A-B Repeat Loop
    function setPointA() {
        const v = getActiveVideo();
        if (!v) return;
        abLoop.a = v.currentTime;
        if (abLoop.b !== null && abLoop.b <= abLoop.a) abLoop.b = null;
        abLoop.active = (abLoop.a !== null && abLoop.b !== null);
        showToast(`🔁 Loop Point A: ${formatTime(abLoop.a)}`, '#f5b041');
        updateMiniHudPlayState();
    }

    function setPointB() {
        const v = getActiveVideo();
        if (!v) return;
        if (abLoop.a === null) abLoop.a = 0;
        abLoop.b = v.currentTime;
        abLoop.active = true;
        showToast(`🔁 Loop Point B: ${formatTime(abLoop.b)} (Active)`, '#2ecc71');
        updateMiniHudPlayState();
    }

    function toggleClearLoop() {
        abLoop.active = false;
        abLoop.a = null;
        abLoop.b = null;
        showToast('🔁 A-B Loop: Cleared', '#ff5f56');
        updateMiniHudPlayState();
    }

    function formatTime(secs) {
        if (secs === null || isNaN(secs)) return '0:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    document.addEventListener('timeupdate', (e) => {
        if (e.target && e.target.tagName === 'VIDEO' && abLoop.active) {
            const v = e.target;
            if (abLoop.b !== null && v.currentTime >= abLoop.b) {
                v.currentTime = abLoop.a || 0;
                v.play().catch(() => {});
            }
        }
    }, true);

    // 3. Frame Stepper & Screenshot
    function stepFrame(forward = true) {
        const v = getActiveVideo();
        if (!v) return;
        if (!v.paused) v.pause();
        const step = 0.04;
        v.currentTime = forward ? Math.min(v.duration, v.currentTime + step) : Math.max(0, v.currentTime - step);
        showToast(`🎞️ Frame: ${v.currentTime.toFixed(2)}s`, '#00f2fe');
    }

    function captureScreenshot() {
        const v = getActiveVideo();
        if (!v || v.readyState < 2) return showToast('⚠️ No active video frame', '#ff5f56');

        try {
            const canvas = document.createElement('canvas');
            canvas.width = v.videoWidth || v.clientWidth || 1280;
            canvas.height = v.videoHeight || v.clientHeight || 720;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

            const timestamp = formatTime(v.currentTime).replace(':', '-');
            let cleanTitle = (document.title || 'Video').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 35);
            const fileName = `${cleanTitle}_[${timestamp}].png`;

            const link = document.createElement('a');
            link.download = fileName;
            link.href = canvas.toDataURL('image/png');
            link.click();
            showToast(`📸 Saved: ${fileName}`, '#2ecc71');
        } catch (e) {
            showToast('⚠️ Screenshot blocked (Protected Stream)', '#ff5f56');
        }
    }

    // 4. Equalizer
    function initAudioEqualizer(video) {
        if (!hasUserInteracted || !video || video.__sfAudioConnected) return;

        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            const source = audioCtx.createMediaElementSource(video);
            video.__sfAudioConnected = true;

            bassFilter = audioCtx.createBiquadFilter();
            bassFilter.type = 'lowshelf';
            bassFilter.frequency.value = 120;

            vocalFilter = audioCtx.createBiquadFilter();
            vocalFilter.type = 'peaking';
            vocalFilter.frequency.value = 2000;
            vocalFilter.Q.value = 1.2;

            gainNode = audioCtx.createGain();

            source.connect(bassFilter);
            bassFilter.connect(vocalFilter);
            vocalFilter.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            applyEqPreset(currentEqPreset);
        } catch (e) {}
    }

    function applyEqPreset(preset) {
        currentEqPreset = preset;
        saveSetting('cs_eq_preset', currentEqPreset);
        if (!bassFilter || !vocalFilter || !gainNode) return;

        if (preset === 'vocal') {
            bassFilter.gain.value = -4;
            vocalFilter.gain.value = 7;
            gainNode.gain.value = 1.1;
            showToast('🎚️ EQ: Vocal Clarity', '#f5b041');
        } else if (preset === 'bass') {
            bassFilter.gain.value = 8;
            vocalFilter.gain.value = -2;
            gainNode.gain.value = 1.0;
            showToast('🎚️ EQ: Bass Boost', '#f5b041');
        } else if (preset === 'night') {
            bassFilter.gain.value = -3;
            vocalFilter.gain.value = 3;
            gainNode.gain.value = 0.9;
            showToast('🎚️ EQ: Night Normalize', '#f5b041');
        } else {
            bassFilter.gain.value = 0;
            vocalFilter.gain.value = 0;
            gainNode.gain.value = 1.0;
            showToast('🎚️ EQ: Flat / Default', '#868fa6');
        }
    }

    // 5. Ambient Glow & Resolution Lock
    function applyAmbientGlow() {
        let styleEl = document.getElementById('streamflow-glow-style');
        if (!ambientGlowEnabled) {
            if (styleEl) styleEl.remove();
            return;
        }
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'streamflow-glow-style';
            document.head.appendChild(styleEl);
        }
        styleEl.innerHTML = `
            video {
                box-shadow: 0 0 45px rgba(0, 242, 254, 0.45), 0 0 100px rgba(0, 114, 255, 0.25) !important;
                transition: box-shadow 0.3s ease !important;
            }
        `;
    }

    function forceYouTubeMaxResolution() {
        try {
            const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
            if (player && typeof player.getAvailableQualityLevels === 'function') {
                const levels = player.getAvailableQualityLevels();
                if (levels && levels.length > 0) {
                    const topQuality = levels[0];
                    player.setPlaybackQualityRange(topQuality, topQuality);
                    player.setPlaybackQuality(topQuality);
                }
            }
        } catch (e) {}
    }

    // 6. Upper-Center HUD
    function positionHudUpperCenter(vid) {
        const hud = document.getElementById('streamflow-upper-center-hud');
        if (!hud || !vid) return;

        const rect = vid.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const topPos = Math.max(10, rect.top + 16);
        const leftPos = rect.left + (rect.width / 2);

        hud.style.top = `${topPos}px`;
        hud.style.left = `${leftPos}px`;
    }

    function showUpperCenterHud(temporary = true) {
        const hud = document.getElementById('streamflow-upper-center-hud');
        if (!hud) return;

        hud.style.opacity = '1';
        hud.style.pointerEvents = 'auto';

        clearTimeout(hudFadeTimer);
        if (temporary) {
            hudFadeTimer = setTimeout(() => {
                const v = getActiveVideo();
                if (v && !v.paused) {
                    hud.style.opacity = '0';
                    hud.style.pointerEvents = 'none';
                }
            }, 2500);
        }
    }

    function updateMiniHudPlayState() {
        const hud = document.getElementById('streamflow-upper-center-hud');
        if (!hud) return;
        const v = getActiveVideo();
        const isPaused = v ? v.paused : true;

        const playSvg = hud.querySelector('.sf-play-btn svg');
        if (playSvg) {
            playSvg.innerHTML = isPaused
                ? `<path d="M8 5v14l11-7z"/>`
                : `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
        }
        const speedBtn = hud.querySelector('.sf-speed-btn');
        if (speedBtn) speedBtn.innerText = `${persistentSpeed}x`;
        
        const loopBtn = hud.querySelector('.sf-loop-btn svg');
        if (loopBtn) {
            loopBtn.style.fill = abLoop.active ? '#2ecc71' : (abLoop.a !== null ? '#f5b041' : '#e8eaed');
        }

        if (isPaused) {
            showUpperCenterHud(false);
        } else {
            showUpperCenterHud(true);
        }
    }

    function renderUpperCenterHudOnVideo(vid) {
        if (!miniHudEnabled || location.hostname.includes('tiktok.com') || isAdVideo(vid)) return;

        let hud = document.getElementById('streamflow-upper-center-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'streamflow-upper-center-hud';
            hud.className = 'streamflow-upper-center-hud';
            
            hud.style.cssText = `
                position: fixed !important; 
                top: 20px !important; 
                left: 50% !important; 
                transform: translate(-50%, 0) !important;
                z-index: 2147483647 !important;
                background: rgba(18, 21, 30, 0.92) !important; 
                backdrop-filter: blur(14px) !important; 
                -webkit-backdrop-filter: blur(14px) !important;
                border: 1px solid rgba(138, 180, 248, 0.35) !important; 
                border-radius: 30px !important;
                padding: 5px 12px !important; 
                display: flex !important; 
                gap: 6px !important; 
                align-items: center !important;
                opacity: 0 !important; 
                pointer-events: none !important;
                transition: opacity 0.25s ease, transform 0.25s ease !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                box-shadow: 0 8px 30px rgba(0,0,0,0.8) !important; 
                user-select: none !important;
            `;

            hud.innerHTML = `
                <button class="sf-hud-btn sf-play-btn" style="background:#a8c7fa; border:none; color:#041e49; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; padding:4px;" title="Play / Pause (Space)">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="sf-hud-btn sf-rewind-btn" style="background:transparent; border:none; color:#e8eaed; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; padding:4px;" title="Rewind -10s">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.2 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
                </button>
                <button class="sf-hud-btn sf-fwd-btn" style="background:transparent; border:none; color:#e8eaed; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; padding:4px;" title="Fast Forward +10s">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M11.5 8c2.65 0 5.05 1 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.2-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z"/></svg>
                </button>
                <button class="sf-hud-btn sf-speed-btn" style="background:rgba(0,242,254,0.14); color:#00f2fe; border:1px solid rgba(0,242,254,0.4); padding:2px 8px; border-radius:14px; font-size:11px; font-weight:800; cursor:pointer; outline:none;" title="Click to Cycle Speed">${persistentSpeed}x</button>
                <button class="sf-hud-btn sf-pip-btn" style="background:transparent; border:none; color:#e8eaed; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; padding:4px;" title="Picture-in-Picture">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M19 11h-8v6h8v-6zm4 8V5c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 0H3V5h18v14z"/></svg>
                </button>
                <button class="sf-hud-btn sf-shot-btn" style="background:transparent; border:none; color:#e8eaed; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; padding:4px;" title="Take Screenshot (S)">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zm8-9.2h-3.2L15 4H9L7.2 6H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h3.9l1.8-2h4.6l1.8 2H20v10z"/></svg>
                </button>
                <button class="sf-hud-btn sf-loop-btn" style="background:transparent; border:none; color:#e8eaed; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; outline:none; padding:4px;" title="A-B Loop">
                    <svg viewBox="0 0 24 24" width="15" height="15" style="fill:#e8eaed;"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
                </button>
            `;

            hud.addEventListener('mouseenter', () => showUpperCenterHud(false));
            hud.addEventListener('mouseleave', () => showUpperCenterHud(true));

            hud.querySelector('.sf-play-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const v = getActiveVideo();
                if (v) {
                    v.paused ? v.play() : v.pause();
                    updateMiniHudPlayState();
                }
            });

            hud.querySelector('.sf-rewind-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const v = getActiveVideo();
                if (v) {
                    v.currentTime -= 10;
                    showToast('⏪ -10s');
                }
            });

            hud.querySelector('.sf-fwd-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const v = getActiveVideo();
                if (v) {
                    v.currentTime += 10;
                    showToast('⏩ +10s');
                }
            });

            hud.querySelector('.sf-speed-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
                let nextIdx = speeds.indexOf(persistentSpeed) + 1;
                if (nextIdx >= speeds.length || nextIdx === 0) nextIdx = 0;
                persistentSpeed = speeds[nextIdx];
                saveSetting('cs_playback_speed', persistentSpeed);
                enforcePersistentMedia();
                updateMiniHudPlayState();
                showToast(`⚡ Speed: ${persistentSpeed}x`);
            });

            hud.querySelector('.sf-pip-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const v = getActiveVideo();
                if (v) document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture();
            });

            hud.querySelector('.sf-shot-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                captureScreenshot();
            });

            hud.querySelector('.sf-loop-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.shiftKey) setPointB();
                else if (abLoop.active) toggleClearLoop();
                else setPointA();
            });

            document.body.appendChild(hud);
        }

        const container = vid.parentElement;
        if (container && !container.__sfHoverAttached) {
            container.__sfHoverAttached = true;
            container.addEventListener('mousemove', () => {
                positionHudUpperCenter(vid);
                showUpperCenterHud(true);
            });
            container.addEventListener('mouseenter', () => {
                positionHudUpperCenter(vid);
                showUpperCenterHud(true);
            });
        }

        positionHudUpperCenter(vid);
        updateMiniHudPlayState();
    }

    window.addEventListener('resize', () => {
        const v = getActiveVideo();
        if (v) positionHudUpperCenter(v);
    });
    window.addEventListener('scroll', () => {
        const v = getActiveVideo();
        if (v) positionHudUpperCenter(v);
    }, true);

    // 7. Ad-Skipper
    setInterval(() => {
        if (!adSkipperEnabled) return;

        const skipSelectors = [
            '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-skip-ad-button', 
            'button.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-container button',
            '[id^="skip-button"] button', '[aria-label*="Skip Ad" i]', '.videoAdUiSkipButton', 
            '.ytp-ad-overlay-close-button', '.ytp-ad-preview-container', '.jw-skip', '.vast-skip-button'
        ];
        
        skipSelectors.forEach(s => {
            document.querySelectorAll(s).forEach(btn => {
                if (btn && btn.offsetParent !== null) {
                    try { btn.click(); } catch(e) {}
                }
            });
        });
        
        const vids = getAllVideos();
        vids.forEach(v => {
            if (isAdVideo(v)) {
                if (v.playbackRate !== 16.0) v.playbackRate = 16.0;
                if (!v.muted) v.muted = true;
                v.dataset.sfIsAd = "true";
            } else if (v.dataset.sfIsAd === "true") {
                delete v.dataset.sfIsAd;
                v.playbackRate = persistentSpeed;
                v.muted = false;
                v.volume = globalVolume;
            }
        });
    }, 500);

    // 8. Auto-Unmute
    setInterval(() => {
        if (!autoUnmuteEnabled) return;
        const userActive = (navigator.userActivation && navigator.userActivation.hasBeenActive) || hasUserInteracted;
        if (!userActive) return;

        const vids = getAllVideos();
        vids.forEach(v => {
            if (!isAdVideo(v) && !v.dataset.sfIsAd && v.muted) {
                try {
                    v.muted = false;
                    v.volume = globalVolume;
                } catch(e) {}
            }
        });
    }, 1000);

    // 9. Continuous PiP & Auto-Next
    document.addEventListener('ended', async (e) => {
        if (!autoNextEnabled) return;
        if (e.target && e.target.tagName === 'VIDEO' && !isAdVideo(e.target)) {
            const wasInPiP = document.pictureInPictureElement === e.target;
            const vids = getAllVideos().filter(v => !isAdVideo(v));
            const currentIdx = vids.indexOf(e.target);

            if (currentIdx !== -1 && currentIdx + 1 < vids.length) {
                const nextVid = vids[currentIdx + 1];
                nextVid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                setTimeout(async () => {
                    nextVid.playbackRate = persistentSpeed;
                    nextVid.volume = globalVolume;
                    try {
                        await nextVid.play();
                        if (wasInPiP) await nextVid.requestPictureInPicture();
                    } catch(playErr) {}
                }, 700);
            }
        }
    }, true);

    // 10. Hotkeys
    window.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
        const v = getActiveVideo();
        if (!v) return;

        if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            persistentSpeed = 1.0;
            saveSetting('cs_playback_speed', persistentSpeed);
            enforcePersistentMedia();
            updateMiniHudPlayState();
            showToast('⚡ Speed Reset: 1.0x (Normal)', '#00f2fe');
        } else if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            v.muted = !v.muted;
            showToast(v.muted ? '🔇 Muted' : `🔊 Unmuted (${Math.round(v.volume * 100)}%)`);
        } else if (e.shiftKey && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) {
            e.preventDefault(); 
            persistentSpeed = Math.min(3.5, +(persistentSpeed + 0.25).toFixed(2));
            saveSetting('cs_playback_speed', persistentSpeed);
            enforcePersistentMedia();
            updateMiniHudPlayState();
            showToast(`⚡ Speed: ${persistentSpeed}x`);
        } else if (e.shiftKey && (e.key === '_' || e.key === '-' || e.code === 'NumpadSubtract')) {
            e.preventDefault(); 
            persistentSpeed = Math.max(0.25, +(persistentSpeed - 0.25).toFixed(2));
            saveSetting('cs_playback_speed', persistentSpeed);
            enforcePersistentMedia();
            updateMiniHudPlayState();
            showToast(`⚡ Speed: ${persistentSpeed}x`);
        } else if (!e.shiftKey && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) {
            e.preventDefault(); 
            globalVolume = Math.min(1.0, +(v.volume + 0.1).toFixed(2));
            v.volume = globalVolume;
            saveSetting('cs_global_volume', globalVolume);
            showToast(`🔊 Global Volume: ${Math.round(globalVolume * 100)}%`);
        } else if (!e.shiftKey && (e.key === '-' || e.code === 'NumpadSubtract')) {
            e.preventDefault(); 
            globalVolume = Math.max(0.0, +(v.volume - 0.1).toFixed(2));
            v.volume = globalVolume;
            saveSetting('cs_global_volume', globalVolume);
            showToast(`🔉 Global Volume: ${Math.round(globalVolume * 100)}%`);
        } else if (e.code === 'ArrowRight') {
            e.preventDefault();
            v.currentTime += 10;
            showToast('⏩ +10s');
        } else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            v.currentTime -= 10;
            showToast('⏪ -10s');
        } else if (e.key === ',' || e.code === 'Comma') {
            e.preventDefault(); stepFrame(false);
        } else if (e.key === '.' || e.code === 'Period') {
            e.preventDefault(); stepFrame(true);
        } else if (e.key === '[' || e.code === 'BracketLeft') {
            e.preventDefault(); setPointA();
        } else if (e.key === ']' || e.code === 'BracketRight') {
            e.preventDefault(); setPointB();
        } else if (e.key === '\\' || e.code === 'Backslash') {
            e.preventDefault(); toggleClearLoop();
        } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault(); captureScreenshot();
        } else if (e.code === 'Space') { 
            e.preventDefault(); 
            v.paused ? v.play() : v.pause(); 
            updateMiniHudPlayState();
        } else if (e.code === 'KeyF') { e.preventDefault(); (v.parentElement || v).requestFullscreen(); }
    });

    // 11. Cross-Origin Safe Message Bridge
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        const v = getActiveVideo();

        if (msg.action === 'GET_MEDIA_STATUS') {
            let u = window.location.href;
            try { if (window.top && window.top.location) u = window.top.location.href; } catch(e) {}
            
            let title = document.title || 'Video Player';
            const yt = document.querySelector('h1.ytd-watch-metadata, #title h1');
            if (yt && yt.innerText) title = yt.innerText.trim();

            sendResponse({
                url: u,
                hostname: location.hostname.replace('www.', ''),
                title: title,
                paused: v ? v.paused : true,
                currentTime: v ? v.currentTime : 0,
                duration: v ? (v.duration || 0) : 0,
                volume: globalVolume,
                muted: v ? v.muted : false,
                speed: persistentSpeed,
                hasVideo: !!v
            });
        } else if (msg.action === 'GET_METADATA') {
            let u = window.location.href;
            try { if (window.top && window.top.location) u = window.top.location.href; } catch(e) {}

            let title = document.title || 'Saved Video';
            let site = location.hostname.replace('www.', '').split('.')[0];

            if (location.hostname.includes('youtube.com')) {
                site = 'YouTube';
                const yt = document.querySelector('h1.ytd-watch-metadata, #title h1');
                if (yt && yt.innerText) title = yt.innerText.trim();
            } else if (location.hostname.includes('facebook.com')) {
                site = 'Facebook';
            }

            sendResponse({ url: u, title: title, site: site });
        } else if (msg.action === 'TOGGLE_PLAY') {
            if (v) {
                if (v.paused) {
                    // play() is async and can reject (autoplay policy) — never
                    // leave an unhandled rejection, and report the real state.
                    v.play().then(() => sendResponse({ paused: false })).catch(() => sendResponse({ paused: true }));
                } else {
                    v.pause();
                    updateMiniHudPlayState();
                    sendResponse({ paused: true });
                }
            } else {
                sendResponse({ paused: true, noVideo: true });
            }
        } else if (msg.action === 'SEEK_OFFSET') {
            if (v) v.currentTime += msg.offset;
        } else if (msg.action === 'SEEK_EXACT') {
            if (v) v.currentTime = msg.time;
        } else if (msg.action === 'UPDATE_SETTINGS') {
            adSkipperEnabled = msg.settings.adSkipperEnabled;
            autoNextEnabled = msg.settings.autoNextEnabled;
            autoUnmuteEnabled = msg.settings.autoUnmuteEnabled;
            ambientGlowEnabled = msg.settings.ambientGlowEnabled;
            miniHudEnabled = msg.settings.miniHudEnabled;
            forceHighResEnabled = msg.settings.forceHighResEnabled;
            
            saveSetting('cs_ad_skipper_enabled', adSkipperEnabled);
            saveSetting('cs_auto_next', autoNextEnabled);
            saveSetting('cs_auto_unmute', autoUnmuteEnabled);
            saveSetting('cs_ambient_glow', ambientGlowEnabled);
            saveSetting('cs_mini_hud', miniHudEnabled);
            saveSetting('cs_force_high_res', forceHighResEnabled);

            applyAmbientGlow();
            if (v) renderUpperCenterHudOnVideo(v);

            if (msg.settings.persistentSpeed) {
                persistentSpeed = msg.settings.persistentSpeed;
                saveSetting('cs_playback_speed', persistentSpeed);
                enforcePersistentMedia();
                updateMiniHudPlayState();
            }
            if (msg.settings.globalVolume !== undefined) {
                globalVolume = msg.settings.globalVolume;
                saveSetting('cs_global_volume', globalVolume);
                enforcePersistentMedia();
            }
            if (msg.settings.eqPreset) {
                applyEqPreset(msg.settings.eqPreset);
            }
            sendResponse({ status: 'ok' });
        } else if (msg.action === 'TRIGGER_PIP') {
            if (v) document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture();
        } else if (msg.action === 'TRIGGER_FOCUS') {
            if (v) document.fullscreenElement ? document.exitFullscreen() : (v.parentElement || v).requestFullscreen();
        } else if (msg.action === 'TRIGGER_SCREENSHOT') {
            if (v) captureScreenshot();
        } else if (msg.action === 'SET_AB_A') {
            if (v) setPointA();
        } else if (msg.action === 'SET_AB_B') {
            if (v) setPointB();
        } else if (msg.action === 'CLEAR_AB') {
            if (v) toggleClearLoop();
        } else if (msg.action === 'STEP_FRAME_FWD') {
            if (v) stepFrame(true);
        } else if (msg.action === 'STEP_FRAME_BACK') {
            if (v) stepFrame(false);
        }
        return true;
    });
})();
