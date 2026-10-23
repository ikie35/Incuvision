// IncuVision Mobile-First Dashboard Controller
// Connected to Raspberry Pi 5 Master Vision & Coordinator Engine

let ws = null;
let currentDay = 1;
let currentPhase = 'SETTING';
let currentTelemetry = {
    temp: 37.5,
    rh: 58.0,
    co2: 3200,
    o2: 20.9,
    actuators: {
        heater: false,
        exhaust: false,
        circulate: true,
        motor: false,
        candling: false
    }
};

let eggMatrixData = [];
let telemetryHistory = []; // Rolling buffer (30-50 samples) for real-time wave graph
let turningSecondsLeft = 3600;
let isHardwareTurning = false;
let isTurningInitialized = false;
let candlingLightState = false;

document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    fetchInitialData();
    // Continuous 2-second polling fallback (guarantees live telemetry over Cloudflare/proxies)
    setInterval(fetchInitialData, 2000);
    loadTelemetryHistory();
    init56EggGrid();
    startTurningCountdown();
    drawTempWaveChart();
});

// =============================================================================
// NAVIGATION & SCREEN SWITCHING
// =============================================================================
function switchNav(screenId) {
    const screens = {
        'home': document.getElementById('screenHome'),
        'analytics': document.getElementById('screenAnalytics'),
        'alerts': document.getElementById('screenAlerts'),
        'fertility': document.getElementById('screenFertility'),
        'menu': document.getElementById('screenMenu')
    };

    const tabs = {
        'home': document.getElementById('navHome'),
        'analytics': document.getElementById('navProfile'),
        'fertility': document.getElementById('navFertility'),
        'menu': document.getElementById('navMenu')
    };

    // Hide all screens
    Object.values(screens).forEach(s => s && s.classList.remove('active'));
    // Deactivate all nav tabs
    Object.values(tabs).forEach(t => t && t.classList.remove('active'));

    // Activate selected screen
    if (screens[screenId]) {
        screens[screenId].classList.add('active');
    }
    // Activate nav tab
    if (tabs[screenId]) {
        tabs[screenId].classList.add('active');
    }

    // Screen specific triggers
    if (screenId === 'analytics') {
        setTimeout(drawTempWaveChart, 50);
    } else if (screenId === 'fertility') {
        refreshLiveStream();
    }
}

// =============================================================================
// WEBSOCKET & BACKEND TELEMETRY
// =============================================================================
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("[WS] Connected to IncuVision Master Engine");
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleIncomingTelemetry(data);
            } catch (e) {
                console.error("[WS] Parse error:", e);
            }
        };

        ws.onclose = () => {
            setTimeout(initWebSocket, 3000);
        };
    } catch (e) {
        console.warn("[WS] Fallback to polling:", e);
        setInterval(fetchInitialData, 3000);
    }
}


async function loadTelemetryHistory() {
    try {
        const res = await fetch('/api/history?limit=50');
        if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length > 0) {
                telemetryHistory = rows.map(r => ({
                    temp: parseFloat(r.temperature !== undefined ? r.temperature : (r.temp || 37.5)),
                    rh: parseFloat(r.humidity !== undefined ? r.humidity : (r.rh || 58.0)),
                    co2: parseFloat(r.co2 || 3200),
                    o2: parseFloat(r.o2 || 20.9),
                    time: r.timestamp || Date.now()
                }));
                drawWaveChart();
            }
        }
    } catch (e) {
        console.warn("[HISTORY] Preload error:", e);
    }
}
async function fetchInitialData() {
    try {
        const res = await fetch('/api/telemetry');
        if (res.ok) {
            const data = await res.json();
            handleIncomingTelemetry(data);
        }
    } catch (e) {
        // Backend connecting
    }
}

function handleIncomingTelemetry(data) {
    if (!data) return;

    // Day & Phase
    if (data.day) {
        currentDay = data.day;
        const daysLeft = Math.max(0, 21 - currentDay);
        const dayEl = document.getElementById('homeDaysLeft');
        if (dayEl) dayEl.innerText = `${daysLeft} Days Left`;
        
        const menuDay = document.getElementById('menuDayInput');
        if (menuDay && document.activeElement !== menuDay) {
            menuDay.value = currentDay;
        }
    }
    if (data.phase) {
        currentPhase = data.phase;
    }

    // Update Home & Menu Protocol Phase Indicators
    const homePhaseSub = document.getElementById('homePhaseSub');
    if (homePhaseSub) {
        const isHatching = (currentPhase === 'HATCHING' || currentDay >= 19);
        homePhaseSub.innerText = isHatching ? `Lockdown Phase (Day ${currentDay} of 21)` : `Setting Phase (Day ${currentDay} of 21)`;
        if (isHatching) homePhaseSub.classList.add('hatching');
        else homePhaseSub.classList.remove('hatching');
    }

    const menuDayEl = document.getElementById('menuDayInput');
    if (menuDayEl && document.activeElement !== menuDayEl) {
        updateMenuProtocolDisplay(currentDay, currentPhase, false);
    }

    const telem = data.telemetry;
    if (telem) {
        currentTelemetry = telem;

        // 1. ALWAYS UPDATE PRIMARY METRIC CARDS FIRST
        try {
            const temp = parseFloat(telem.temp !== undefined ? telem.temp : 37.5);
            const valTempEl = document.getElementById('valTemp');
            const pillTemp = document.getElementById('analyticsTempPill');
            if (valTempEl) valTempEl.innerText = `${temp.toFixed(1)}°C`;
            if (pillTemp) pillTemp.innerText = `${temp.toFixed(1)}°`;

            const rh = parseFloat(telem.rh !== undefined ? telem.rh : 58.0);
            const valRHEl = document.getElementById('valRH');
            if (valRHEl) valRHEl.innerText = `${rh.toFixed(1)}%`;

            const co2 = parseInt(telem.co2 !== undefined ? telem.co2 : 3200);
            const valCO2El = document.getElementById('valCO2');
            if (valCO2El) valCO2El.innerText = co2.toLocaleString();

            const o2 = parseFloat(telem.o2 !== undefined ? telem.o2 : 20.9);
            const valO2El = document.getElementById('valO2');
            if (valO2El) valO2El.innerText = `${o2.toFixed(1)}%`;
        } catch (err) {
            console.error("[TELEMETRY] Error updating cards:", err);
        }

        // 2. Push live sample to rolling buffer
        try {
            const liveTemp = parseFloat(telem.temp || 37.5);
            const liveRH = parseFloat(telem.rh || 58.0);
            const liveCO2 = parseFloat(telem.co2 || 3200);
            const liveO2 = parseFloat(telem.o2 || 20.9);
            telemetryHistory.push({ temp: liveTemp, rh: liveRH, co2: liveCO2, o2: liveO2, time: Date.now() });
            if (telemetryHistory.length > 50) {
                telemetryHistory.shift();
            }
        } catch (e) {}

        // 3. Hardware synchronized egg turning timer
        try {
            const motorActive = Boolean(telem.actuators && telem.actuators.motor);
            isHardwareTurning = motorActive;

            if (telem.next_turn_seconds !== undefined) {
                const serverSecs = parseInt(telem.next_turn_seconds);
                if (!isTurningInitialized || Math.abs(turningSecondsLeft - serverSecs) > 3 || motorActive) {
                    turningSecondsLeft = serverSecs;
                    isTurningInitialized = true;
                }
            }
            updateTurningDisplay();
        } catch (e) {
            console.warn("[TURNING] update error:", e);
        }

        // 4. Refresh wave chart dynamically with live telemetry
        try {
            drawWaveChart();
            const graphPill = document.getElementById('graphCurrentValPill');
            if (graphPill && metricConfigs[currentGraphMetric]) {
                graphPill.innerText = metricConfigs[currentGraphMetric].pillText();
            }
        } catch (e) {
            console.warn("[CHART] draw error:", e);
        }

        // 5. 2x2 Actuator Status Pills sync (Heater, Turner, Exhaust, LED Light)
        try {
            if (telem.actuators) {
                updatePillState('pillHeater', !!telem.actuators.heater);
                updatePillState('pillTurner', !!telem.actuators.motor);
                updatePillState('pillExhaust', !!telem.actuators.exhaust);
                updatePillState('pillLed', !!telem.actuators.candling);
            }
        } catch (e) {}

        // 6. Generate dynamic smart alerts based on thresholds
        try {
            const tempVal = parseFloat(telem.temp || 37.5);
            const rhVal = parseFloat(telem.rh || 58.0);
            const o2Val = parseFloat(telem.o2 || 20.9);
            evaluateSmartAlerts(tempVal, rhVal, o2Val, telem.actuators);
        } catch (e) {}
    }

    // Latest Candling Audit Data
    if (data.latest_audit) {
        renderAuditScores(data.latest_audit, false);
    }
}

// =============================================================================
// ACTUATOR CONTROLS (PTC Heater, Egg Turner, Exhaust Fan, LED Light)
// =============================================================================
function updatePillState(elementId, isOn) {
    const pill = document.getElementById(elementId);
    if (!pill) return;
    const textSpan = pill.querySelector('.status-text');
    if (isOn) {
        pill.classList.add('is-on');
        if (textSpan) textSpan.innerText = 'ON';
    } else {
        pill.classList.remove('is-on');
        if (textSpan) textSpan.innerText = 'OFF';
    }
}

async function toggleRelayByName(actuatorName) {
    if (!currentTelemetry.actuators) {
        currentTelemetry.actuators = {};
    }
    const isCurrentlyOn = !!currentTelemetry.actuators[actuatorName];
    const newState = !isCurrentlyOn;
    currentTelemetry.actuators[actuatorName] = newState;

    const pillMap = {
        'heater': 'pillHeater',
        'motor': 'pillTurner',
        'exhaust': 'pillExhaust',
        'candling': 'pillLed'
    };
    if (pillMap[actuatorName]) {
        updatePillState(pillMap[actuatorName], newState);
    }

    try {
        await fetch('/api/control/relay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actuator: actuatorName, state: newState })
        });
    } catch (e) {
        console.warn("Could not toggle relay:", e);
    }
}

let isManualMode = false;
async function toggleActuatorMode() {
    isManualMode = !isManualMode;
    const modeStr = isManualMode ? 'MANUAL' : 'AUTOMATIC';
    const badge = document.getElementById('badgeActuatorMode');
    if (badge) {
        badge.innerText = modeStr;
        badge.style.background = isManualMode ? '#FEE2E2' : '#FDE68A';
        badge.style.color = isManualMode ? '#DC2626' : '#78350F';
    }
    try {
        await fetch('/api/control/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: isManualMode ? 'MANUAL' : 'AUTO' })
        });
    } catch (e) {
        console.warn("Could not toggle mode:", e);
    }
}

function updateTurningDisplay() {
    const turnEl = document.getElementById('turningCountdown');
    if (!turnEl) return;

    if (currentPhase === 'HATCHING' || currentDay >= 19) {
        turnEl.innerText = "OFF (HATCH)";
        return;
    }

    if (isHardwareTurning) {
        turnEl.innerText = "TURNING...";
        return;
    }

    const m = Math.floor(turningSecondsLeft / 60).toString().padStart(2, '0');
    const s = (turningSecondsLeft % 60).toString().padStart(2, '0');
    turnEl.innerText = `${m}:${s}`;
}

async function manualEggTurn() {
    if (currentPhase === 'HATCHING' || currentDay >= 19) {
        showToast("🔒 Egg turning is locked out during Hatching Phase (Days 19–21).", true);
        return;
    }

    isHardwareTurning = true;
    turningSecondsLeft = 3600;
    updateTurningDisplay();

    try {
        await fetch('/api/control/egg_turning', { method: 'POST' });
        showToast("Egg turning initiated (15s rotation).");
    } catch (e) {
        console.warn("Egg turn error:", e);
        showToast("Failed to trigger egg turning.", true);
    }
}

function startTurningCountdown() {
    setInterval(() => {
        if (currentPhase === 'HATCHING' || currentDay >= 19) {
            updateTurningDisplay();
            return;
        }

        if (isHardwareTurning) {
            updateTurningDisplay();
            return;
        }

        if (turningSecondsLeft > 0) {
            turningSecondsLeft--;
        } else {
            turningSecondsLeft = 3600;
        }
        updateTurningDisplay();
    }, 1000);
}

// =============================================================================
// SENSOR GRAPH & MULTI-METRIC WAVE CHART
// =============================================================================
let currentGraphMetric = 'temp';

const metricConfigs = {
    temp: {
        title: 'TEMPERATURE',
        tabId: 'gTabTemp',
        pillText: () => `${parseFloat(currentTelemetry.temp || 37.5).toFixed(1)}°C`,
        targetText: () => (currentPhase === 'HATCHING' || currentDay >= 19) ? 'Target: 36.9°C (Hatching)' : 'Target: 37.5°C (Setting)',
        strokeColor: '#E09930',
        gradTop: 'rgba(250, 217, 128, 0.45)',
        minVal: 30.0,
        maxVal: 39.0,
        yLabels: ['39°', '38°', '37°', '36°', '35°', '34°', '33°', '32°', '31°', '30°'],
        wavePoints: [
            { x: 0,   y: 80 }, { x: 25,  y: 105 }, { x: 45,  y: 92 }, { x: 68,  y: 120 },
            { x: 90,  y: 135 }, { x: 110, y: 100 }, { x: 135, y: 145 }, { x: 160, y: 108 },
            { x: 180, y: 115 }, { x: 205, y: 95 }, { x: 230, y: 118 }, { x: 255, y: 88 },
            { x: 280, y: 112 }, { x: 305, y: 92 }, { x: 320, y: 65 }, { x: 340, y: 100 }
        ]
    },
    rh: {
        title: 'HUMIDITY',
        tabId: 'gTabRH',
        pillText: () => `${parseFloat(currentTelemetry.rh || 58.0).toFixed(1)}%`,
        targetText: () => (currentPhase === 'HATCHING' || currentDay >= 19) ? 'Target: 70.0% (Hatching)' : 'Target: 58.0% (Setting)',
        strokeColor: '#0284C7',
        gradTop: 'rgba(186, 230, 253, 0.55)',
        minVal: 40.0,
        maxVal: 80.0,
        yLabels: ['80%', '75%', '70%', '65%', '60%', '55%', '50%', '45%', '40%'],
        wavePoints: [
            { x: 0,   y: 95 }, { x: 30,  y: 75 }, { x: 60,  y: 110 }, { x: 90,  y: 85 },
            { x: 120, y: 125 }, { x: 150, y: 90 }, { x: 180, y: 105 }, { x: 210, y: 80 },
            { x: 240, y: 115 }, { x: 270, y: 95 }, { x: 300, y: 120 }, { x: 340, y: 85 }
        ]
    },
    co2: {
        title: 'CO₂ LEVEL',
        tabId: 'gTabCO2',
        pillText: () => `${parseInt(currentTelemetry.co2 || 3200).toLocaleString()} ppm`,
        targetText: () => (currentPhase === 'HATCHING' || currentDay >= 19) ? 'Max Threshold: <7,500 ppm' : 'Safe Threshold: <5,000 ppm',
        strokeColor: '#059669',
        gradTop: 'rgba(167, 243, 208, 0.55)',
        minVal: 0,
        maxVal: 6000,
        yLabels: ['6k', '5k', '4k', '3k', '2k', '1k', '0'],
        wavePoints: [
            { x: 0,   y: 130 }, { x: 35,  y: 115 }, { x: 70,  y: 140 }, { x: 105, y: 95 },
            { x: 140, y: 110 }, { x: 175, y: 85 }, { x: 210, y: 120 }, { x: 245, y: 100 },
            { x: 280, y: 135 }, { x: 315, y: 90 }, { x: 340, y: 115 }
        ]
    },
    o2: {
        title: 'OXYGEN',
        tabId: 'gTabO2',
        pillText: () => `${parseFloat(currentTelemetry.o2 || 20.9).toFixed(1)}%`,
        targetText: 'Min Threshold: >20.5%',
        strokeColor: '#7C3AED',
        gradTop: 'rgba(233, 213, 255, 0.55)',
        minVal: 19.0,
        maxVal: 23.0,
        yLabels: ['23%', '22%', '21.5%', '21%', '20.5%', '20%', '19%'],
        wavePoints: [
            { x: 0,   y: 100 }, { x: 40,  y: 120 }, { x: 80,  y: 90 }, { x: 120, y: 105 },
            { x: 160, y: 85 }, { x: 200, y: 110 }, { x: 240, y: 95 }, { x: 280, y: 115 },
            { x: 310, y: 80 }, { x: 340, y: 105 }
        ]
    }
};

function goToMetricGraph(metricType) {
    switchScreen('analytics');
    setGraphMetric(metricType);
}

function setGraphMetric(metricType) {
    if (!metricConfigs[metricType]) return;
    currentGraphMetric = metricType;

    // 1. Update tab active states
    ['gTabTemp', 'gTabRH', 'gTabCO2', 'gTabO2'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(metricConfigs[metricType].tabId);
    if (activeBtn) activeBtn.classList.add('active');

    // 2. Update Header Title & Target Label
    const titleEl = document.getElementById('graphMetricTitle');
    const pillEl = document.getElementById('graphCurrentValPill');
    const targetEl = document.getElementById('graphTargetLabel');

    if (titleEl) titleEl.innerText = metricConfigs[metricType].title;
    if (pillEl) pillEl.innerText = metricConfigs[metricType].pillText();
    if (targetEl) {
        const tVal = metricConfigs[metricType].targetText;
        targetEl.innerText = typeof tVal === 'function' ? tVal() : tVal;
    }

    // 3. Update Y-Axis labels
    const yAxisEl = document.getElementById('chartYAxis');
    if (yAxisEl) {
        yAxisEl.innerHTML = metricConfigs[metricType].yLabels.map(lbl => `<span>${lbl}</span>`).join('');
    }

    // 4. Redraw chart
    drawWaveChart();
}

function drawWaveChart() {
    const canvas = document.getElementById('tempWaveChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const cfg = metricConfigs[currentGraphMetric] || metricConfigs.temp;

    // Draw vertical dashed day separator lines
    const dayCols = 5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#F5C754';
    ctx.lineWidth = 1.5;

    for (let i = 1; i < dayCols; i++) {
        const x = (w / dayCols) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }
    ctx.setLineDash([]); // Reset line dash

    // Generate dynamic wave curve points from telemetry history
    let wavePoints = [];
    if (telemetryHistory.length >= 2) {
        const count = telemetryHistory.length;
        wavePoints = telemetryHistory.map((item, idx) => {
            const rawVal = item[currentGraphMetric] !== undefined ? item[currentGraphMetric] : (cfg.minVal + cfg.maxVal) / 2;
            const norm = Math.max(0, Math.min(1, (rawVal - cfg.minVal) / (cfg.maxVal - cfg.minVal)));
            const x = (w / (count - 1)) * idx;
            const y = h - (norm * (h - 24) + 12);
            return { x, y };
        });
    } else {
        const curVal = parseFloat(currentTelemetry[currentGraphMetric] || (cfg.minVal + cfg.maxVal) / 2);
        const norm = Math.max(0, Math.min(1, (curVal - cfg.minVal) / (cfg.maxVal - cfg.minVal)));
        const baseY = h - (norm * (h - 24) + 12);
        wavePoints = [
            { x: 0, y: baseY },
            { x: w * 0.25, y: Math.max(10, baseY - 6) },
            { x: w * 0.5, y: Math.min(h - 10, baseY + 6) },
            { x: w * 0.75, y: Math.max(10, baseY - 4) },
            { x: w, y: baseY }
        ];
    }

    // Smooth bezier curve
    ctx.beginPath();
    ctx.moveTo(wavePoints[0].x, wavePoints[0].y);
    for (let i = 0; i < wavePoints.length - 1; i++) {
        const xc = (wavePoints[i].x + wavePoints[i + 1].x) / 2;
        const yc = (wavePoints[i].y + wavePoints[i + 1].y) / 2;
        ctx.quadraticCurveTo(wavePoints[i].x, wavePoints[i].y, xc, yc);
    }
    ctx.lineTo(wavePoints[wavePoints.length - 1].x, wavePoints[wavePoints.length - 1].y);
    ctx.strokeStyle = cfg.strokeColor;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Fill soft gradient under curve
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, cfg.gradTop);
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.fillStyle = grad;
    ctx.fill();
}

// Alias for backward compatibility
function drawTempWaveChart() {
    drawWaveChart();
}

// =============================================================================
// SMART ALERTS & LOGS
// =============================================================================
let alertLogCache = [];

function evaluateSmartAlerts(temp, rh, o2, actuators) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bellDot = document.getElementById('bellDot');

    // Check conditions
    let hasAlert = false;
    if (o2 > 21.8) {
        hasAlert = true;
    }
    if (temp < 36.5 || temp > 38.5) {
        hasAlert = true;
    }

    if (bellDot) {
        bellDot.style.display = hasAlert ? 'block' : 'none';
    }
}

// =============================================================================
// EGG FERTILITY CHECKER (AI CANDLING & CAMERA)
// =============================================================================
let isCameraOn = true;
let currentCameraMode = 'live'; // 'live' or 'audit'
let latestAuditImageUrl = null;

function switchCameraView(mode) {
    currentCameraMode = mode;
    const tabLive = document.getElementById('tabLiveView');
    const tabAudit = document.getElementById('tabAuditView');
    const streamImg = document.getElementById('fertilityCameraStream');
    const badge = document.getElementById('cameraStatusBadge');
    const returnLiveBtn = document.getElementById('btnReturnLive');
    const pausedScreen = document.getElementById('cameraPausedScreen');
    const offlineScreen = document.getElementById('cameraOfflineScreen');
    const centerIcon = document.getElementById('camOverlayIcon');

    if (centerIcon) centerIcon.style.display = 'none';
    if (offlineScreen) offlineScreen.style.display = 'none';

    if (mode === 'live') {
        if (tabLive) tabLive.classList.add('active');
        if (tabAudit) tabAudit.classList.remove('active');
        if (returnLiveBtn) returnLiveBtn.style.display = 'none';

        if (isCameraOn) {
            if (pausedScreen) pausedScreen.style.display = 'none';
            if (streamImg) {
                streamImg.src = `/api/camera/stream?t=${Date.now()}`;
                streamImg.style.display = 'block';
            }
            if (badge) {
                badge.className = 'camera-status-badge';
                badge.innerHTML = '<span class="live-dot"></span> LIVE FEED';
            }
        } else {
            showCameraPaused();
        }
    } else if (mode === 'audit') {
        if (tabAudit) tabAudit.classList.add('active');
        if (tabLive) tabLive.classList.remove('active');
        if (returnLiveBtn) returnLiveBtn.style.display = 'flex';
        if (pausedScreen) pausedScreen.style.display = 'none';
        if (offlineScreen) offlineScreen.style.display = 'none';

        if (streamImg) {
            if (latestAuditImageUrl) {
                streamImg.src = `${latestAuditImageUrl}?t=${Date.now()}`;
            }
            streamImg.style.display = 'block';
        }
        if (badge) {
            badge.className = 'camera-status-badge audit-mode';
            badge.innerHTML = '<span class="audit-dot"></span> CANDLING AUDIT';
        }
    }
}

function toggleCameraPower(forceOn = null) {
    if (forceOn !== null) {
        isCameraOn = forceOn;
    } else {
        isCameraOn = !isCameraOn;
    }

    const btnPowerText = document.getElementById('btnCameraPowerText');
    const btnPower = document.getElementById('btnCameraPower');

    if (isCameraOn) {
        if (btnPowerText) btnPowerText.textContent = 'Cam OFF';
        if (btnPower) {
            btnPower.style.background = 'rgba(0, 0, 0, 0.7)';
        }
        switchCameraView(currentCameraMode);
    } else {
        if (btnPowerText) btnPowerText.textContent = 'Cam ON';
        if (btnPower) {
            btnPower.style.background = '#10B981';
        }
        showCameraPaused();
    }
}

function showCameraPaused() {
    const streamImg = document.getElementById('fertilityCameraStream');
    const pausedScreen = document.getElementById('cameraPausedScreen');
    const offlineScreen = document.getElementById('cameraOfflineScreen');
    const centerIcon = document.getElementById('camOverlayIcon');
    const badge = document.getElementById('cameraStatusBadge');
    const returnLiveBtn = document.getElementById('btnReturnLive');

    if (centerIcon) centerIcon.style.display = 'none';
    if (offlineScreen) offlineScreen.style.display = 'none';
    if (streamImg) {
        streamImg.src = ''; // Halt MJPEG stream to stop bandwidth & CPU
        streamImg.style.display = 'none';
    }
    if (pausedScreen) pausedScreen.style.display = 'flex';
    if (returnLiveBtn) returnLiveBtn.style.display = 'none';
    if (badge) {
        badge.className = 'camera-status-badge paused-mode';
        badge.innerHTML = '<span class="paused-dot"></span> CAMERA OFF';
    }
}

function refreshLiveStream() {
    if (!isCameraOn) {
        toggleCameraPower(true);
        return;
    }
    switchCameraView('live');
}

function onCameraStreamError() {
    if (!isCameraOn) return;
    const streamImg = document.getElementById('fertilityCameraStream');
    const offlineScreen = document.getElementById('cameraOfflineScreen');
    const pausedScreen = document.getElementById('cameraPausedScreen');
    const centerIcon = document.getElementById('camOverlayIcon');
    const badge = document.getElementById('cameraStatusBadge');

    if (centerIcon) centerIcon.style.display = 'none';
    if (pausedScreen) pausedScreen.style.display = 'none';

    if (currentCameraMode === 'live') {
        if (streamImg) streamImg.style.display = 'none';
        if (offlineScreen) offlineScreen.style.display = 'flex';
        if (badge) {
            badge.className = 'camera-status-badge paused-mode';
            badge.innerHTML = '<span class="paused-dot"></span> OFFLINE';
        }
    }
}

async function toggleCandlingLight() {
    candlingLightState = !candlingLightState;
    const btnLight = document.getElementById('btnCamLight');
    const btnLightText = document.getElementById('btnCamLightText');
    if (btnLight) {
        if (candlingLightState) {
            btnLight.classList.add('is-active-gold');
            if (btnLightText) btnLightText.textContent = 'Light: ON';
        } else {
            btnLight.classList.remove('is-active-gold');
            if (btnLightText) btnLightText.textContent = 'Light';
        }
    }

    // Also update home actuator status pill if present
    updatePillState('pillLed', candlingLightState);

    try {
        await fetch('/api/control/candling_light', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: candlingLightState })
        });
    } catch (e) {
        console.warn("Light toggle error:", e);
    }
}

async function triggerCandlingAudit() {
    const btnLabel = document.getElementById('btnCandlingLabel');
    const originalText = btnLabel ? btnLabel.innerText : "Run AI Candling Audit";
    if (btnLabel) btnLabel.innerText = "Running YOLOv8 Audit...";

    try {
        const res = await fetch('/api/candling/trigger', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success' && data.result) {
            if (data.result.error) {
                alert("Candling audit note: " + data.result.error);
            } else {
                renderAuditScores(data.result);
            }
        } else {
            alert("Candling audit error: " + (data.detail || "Server error"));
        }
    } catch (e) {
        alert("Candling audit connection error: " + e);
    } finally {
        if (btnLabel) btnLabel.innerText = originalText;
    }
}

function renderAuditScores(audit, switchToAudit = true) {
    if (!audit || audit.error) return;

    const fertileScore = document.getElementById('scoreFertile');
    const infertileScore = document.getElementById('scoreInfertile');
    const fertileSub = document.getElementById('scoreFertileSub');
    const infertileSub = document.getElementById('scoreInfertileSub');

    const rate = parseFloat(audit.fertility_rate !== undefined ? audit.fertility_rate : 0);
    const total = parseInt(audit.total_eggs || 56);
    const fertileCount = audit.fertile !== undefined ? audit.fertile : Math.round((rate / 100) * total);
    const infertileCount = audit.infertile !== undefined ? audit.infertile : (total - fertileCount);

    if (fertileScore) fertileScore.innerText = `${rate.toFixed(1)}%`;
    if (infertileScore) infertileScore.innerText = `${(100 - rate).toFixed(1)}%`;
    if (fertileSub) fertileSub.innerText = `${fertileCount} / ${total} Eggs`;
    if (infertileSub) infertileSub.innerText = `${infertileCount} / ${total} Eggs`;

    // Save and optionally switch camera viewport to the annotated scan photo
    if (audit.annotated_image_url) {
        latestAuditImageUrl = audit.annotated_image_url;
        if (switchToAudit) {
            switchCameraView('audit');
        }
    }

    // Update 56-Egg Matrix from dynamic detections
    if (audit.matrix) {
        eggMatrixData = [];
        for (let i = 1; i <= 56; i++) {
            const slot = document.getElementById('eggSlot-' + i);
            if (slot) slot.className = 'egg-slot-pill';
        }
        const flatList = Array.isArray(audit.matrix[0]) ? audit.matrix.flat() : audit.matrix;
        flatList.forEach(egg => {
            eggMatrixData.push(egg);
            const slot = document.getElementById('eggSlot-' + egg.index);
            if (slot) slot.className = 'egg-slot-pill ' + egg.status;
        });
    }
}

// 56-Egg Matrix Drawer
function init56EggGrid() {
    const grid = document.getElementById('eggGrid');
    if (!grid) return;
    grid.innerHTML = '';

    for (let i = 1; i <= 56; i++) {
        const slot = document.createElement('div');
        slot.className = 'egg-slot-pill';
        slot.id = `eggSlot-${i}`;
        slot.innerText = `#${i.toString().padStart(2, '0')}`;
        slot.onclick = () => openEggDetail(i);
        grid.appendChild(slot);
    }
}

function toggleMatrixDrawer() {
    const drawer = document.getElementById('matrixDrawer');
    if (drawer) {
        drawer.classList.toggle('open');
    }
}

function openEggDetail(index) {
    const egg = eggMatrixData.find(e => e.index === index);
    const modal = document.getElementById('eggModal');
    const title = document.getElementById('modalEggTitle');
    const body = document.getElementById('modalEggBody');

    title.innerText = `Egg Slot #${index.toString().padStart(2, '0')}`;
    
    const row = (egg && egg.row) ? egg.row : Math.floor((index - 1) / 8) + 1;
    const col = (egg && egg.col) ? egg.col : ((index - 1) % 8) + 1;

    if (egg) {
        const statusColor = egg.status === 'fertile' ? '#15803D' : '#B91C1C';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #E5E7EB; padding-bottom:8px;">
                    <span style="color:#6B7280;">Tray Coordinate</span>
                    <span style="font-weight:700;">Row ${row} of 7, Col ${col} of 8</span>
                </div>
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #E5E7EB; padding-bottom:8px;">
                    <span style="color:#6B7280;">Fertility Classification</span>
                    <span style="font-weight:800; color:${statusColor}; text-transform:uppercase;">${egg.status}</span>
                </div>
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #E5E7EB; padding-bottom:8px;">
                    <span style="color:#6B7280;">YOLOv8 Confidence</span>
                    <span style="font-weight:800; font-family:var(--font-mono);">${(egg.confidence * 100).toFixed(1)}%</span>
                </div>
            </div>
        `;
    } else {
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #E5E7EB; padding-bottom:8px;">
                    <span style="color:#6B7280;">Tray Coordinate</span>
                    <span style="font-weight:700;">Row ${row} of 7, Col ${col} of 8</span>
                </div>
                <p style="color:#6B7280; font-size:0.85rem; padding-top:6px;">No AI candling scan recorded for this slot yet. Run Candling Audit to scan.</p>
            </div>
        `;
    }

    modal.classList.add('open');
}

function closeModal(e) {
    const modal = document.getElementById('eggModal');
    if (modal) modal.classList.remove('open');
}

// =============================================================================
// TOAST NOTIFICATIONS
// =============================================================================
let toastTimer = null;
function showToast(message, isError = false) {
    const toast = document.getElementById('appToast');
    if (!toast) return;
    toast.innerText = message;
    if (isError) {
        toast.classList.add('toast-error');
    } else {
        toast.classList.remove('toast-error');
    }
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 3200);
}

// =============================================================================
// MENU SETPOINTS & PROTOCOL (AUTOMATIC DAY 18 TRANSITION)
// =============================================================================
function onMenuDayInputChanged(val) {
    const day = parseInt(val) || 1;
    const isHatching = day >= 19;
    updateMenuProtocolDisplay(day, isHatching ? 'HATCHING' : 'SETTING', true);
}

function applyProtocolPreset(phase) {
    const day = (phase === 'HATCHING') ? 19 : 1;
    const dayInput = document.getElementById('menuDayInput');
    if (dayInput) dayInput.value = day;
    updateMenuProtocolDisplay(day, phase, true);
    showToast(`Loaded ${phase === 'HATCHING' ? 'Hatching / Lockdown (36.9°C, 70% RH)' : 'Setting (37.5°C, 58% RH)'} preset. Tap "Save Day" to activate.`);
}

function updateMenuProtocolDisplay(day, phase, updateInputs = false) {
    const isHatching = (phase === 'HATCHING' || day >= 19);

    // 1. Update Phase Banner & Status Dot
    const banner = document.getElementById('protocolPhaseBanner');
    const badge = document.getElementById('protocolPhaseBadge');
    const desc = document.getElementById('protocolPhaseDesc');
    const dot = document.getElementById('phaseStatusDot');

    if (banner) {
        if (isHatching) banner.classList.add('banner-hatching');
        else banner.classList.remove('banner-hatching');
    }
    if (badge) {
        badge.innerText = isHatching ? 'HATCHING / LOCKDOWN (Days 19–21)' : 'SETTING PHASE (Days 1–18)';
        if (isHatching) badge.classList.add('badge-hatching');
        else badge.classList.remove('badge-hatching');
    }
    if (desc) {
        desc.innerText = isHatching 
            ? 'Lockdown Active: Target 36.9°C, 70% RH. Egg turning is locked OFF so chicks can orient and pip safely.'
            : 'Standard Setting: 37.5°C, 58% RH with automatic egg turning every 60m.';
    }
    if (dot) {
        if (isHatching) dot.classList.add('indicator-hatching');
        else dot.classList.remove('indicator-hatching');
    }

    // 2. Preset Tabs state
    const btnSetting = document.getElementById('btnPresetSetting');
    const btnHatching = document.getElementById('btnPresetHatching');
    if (btnSetting) {
        if (isHatching) btnSetting.classList.remove('active');
        else btnSetting.classList.add('active');
    }
    if (btnHatching) {
        if (isHatching) btnHatching.classList.add('active');
        else btnHatching.classList.remove('active');
    }

    // 3. Hint tags
    const hintDay = document.getElementById('menuDayHintTag');
    if (hintDay) {
        hintDay.innerText = `Day ${day} of 21 (${isHatching ? 'Lockdown' : 'Setting'})`;
    }

    const recTemp = document.getElementById('recTempTag');
    const recRH = document.getElementById('recRHTag');
    const recCO2 = document.getElementById('recCO2Tag');
    if (recTemp) recTemp.innerText = isHatching ? 'Lockdown: 36.9°C' : 'Setting: 37.5°C';
    if (recRH) recRH.innerText = isHatching ? 'Lockdown: 70% RH' : 'Setting: 58% RH';
    if (recCO2) recCO2.innerText = isHatching ? 'Lockdown: 7500 ppm' : 'Setting: 5000 ppm';

    // 4. Update input values if requested
    if (updateInputs) {
        const tempIn = document.getElementById('menuTempInput');
        const rhIn = document.getElementById('menuRHInput');
        const co2In = document.getElementById('menuCO2Input');
        if (tempIn) tempIn.value = isHatching ? '36.9' : '37.5';
        if (rhIn) rhIn.value = isHatching ? '70' : '58';
        if (co2In) co2In.value = isHatching ? '7500' : '5000';
    }

    // 5. Egg Turning Button Safeguard & Warning notice
    const rotateBtn = document.getElementById('menuRotateBtn');
    const warnNotice = document.getElementById('lockdownWarningNotice');

    if (rotateBtn) {
        if (isHatching) {
            rotateBtn.disabled = true;
            rotateBtn.classList.add('disabled-lockdown');
            rotateBtn.innerHTML = '🔒 Egg Turning Locked (Day 19–21)';
        } else {
            rotateBtn.disabled = false;
            rotateBtn.classList.remove('disabled-lockdown');
            rotateBtn.innerHTML = 'Rotate Egg Tray Now (15s)';
        }
    }
    if (warnNotice) {
        warnNotice.style.display = isHatching ? 'flex' : 'none';
    }
}

async function setIncubationDayFromMenu() {
    const dayInput = document.getElementById('menuDayInput');
    const day = parseInt(dayInput ? dayInput.value : 1) || 1;
    currentDay = day;
    currentPhase = day >= 19 ? 'HATCHING' : 'SETTING';

    const daysLeft = Math.max(0, 21 - currentDay);
    const dayEl = document.getElementById('homeDaysLeft');
    if (dayEl) dayEl.innerText = `${daysLeft} Days Left`;

    // Automatically apply appropriate phase setpoints
    const isHatching = day >= 19;
    const targetTemp = isHatching ? 36.9 : 37.5;
    const targetRH = isHatching ? 70.0 : 58.0;
    const targetCO2 = isHatching ? 7500 : 5000;

    const tempIn = document.getElementById('menuTempInput');
    const rhIn = document.getElementById('menuRHInput');
    const co2In = document.getElementById('menuCO2Input');
    if (tempIn) tempIn.value = targetTemp;
    if (rhIn) rhIn.value = targetRH;
    if (co2In) co2In.value = targetCO2;

    updateMenuProtocolDisplay(day, currentPhase, false);
    updateTurningDisplay();

    try {
        // Send Day to coordinator & ESP32
        const resDay = await fetch('/api/control/day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day: day })
        });

        // Also sync setpoints for this phase
        await fetch('/api/control/setpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temp: targetTemp, rh: targetRH, co2: targetCO2 })
        });

        if (resDay.ok) {
            showToast(`Day ${day} applied! Switched to ${isHatching ? 'Lockdown (36.9°C, 70% RH, Motor Locked)' : 'Setting (37.5°C, 58% RH)'}`);
        } else {
            showToast("Saved with warning: Coordinator reconnecting...");
        }
    } catch (e) {
        showToast("Error saving day: " + e.message, true);
    }
}

async function saveMenuSetpoints() {
    const temp = parseFloat(document.getElementById('menuTempInput').value) || 37.5;
    const rh = parseFloat(document.getElementById('menuRHInput').value) || 58.0;
    const co2 = parseInt(document.getElementById('menuCO2Input').value) || 5000;

    try {
        const res = await fetch('/api/control/setpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temp, rh, co2 })
        });
        if (res.ok) {
            showToast(`Setpoints updated: ${temp.toFixed(1)}°C, ${rh.toFixed(0)}% RH, ${co2} ppm`);
        } else {
            showToast("Setpoints sent to controller.");
        }
    } catch (e) {
        showToast("Error updating setpoints: " + e.message, true);
    }
}


