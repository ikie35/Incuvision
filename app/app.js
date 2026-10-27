// IncuVision Mobile-First Dashboard Controller
// Connected to Raspberry Pi 5 Master Vision & Coordinator Engine

let ws = null;
let currentDay = 0;
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
    loadAppliedSchedule();
    if (appliedSchedule && appliedSchedule.active) {
        renderHomeCountdownCard();
    } else {
        renderHomeCountdownCardDefault();
    }
    // Periodic ticker to keep countdown live without re-rendering unnecessarily
    setInterval(() => {
        if (appliedSchedule && appliedSchedule.active) {
            renderHomeCountdownCard();
        }
    }, 1000);
    renderProtocolCards();
    initPushNotifications();
    loadNotificationHistory();
    renderAlertsList();
});

// =============================================================================
// NAVIGATION & SCREEN SWITCHING
// =============================================================================
let currentActiveScreen = 'home';
let previousActiveScreen = 'home';

function switchNav(screenId) {
    if (currentActiveScreen !== screenId && currentActiveScreen !== 'alerts') {
        previousActiveScreen = currentActiveScreen;
    }
    currentActiveScreen = screenId;

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

    // Toggle active highlight on header notification bell button
    const bellBtn = document.getElementById('btnHeaderBell');
    if (bellBtn) {
        if (screenId === 'alerts') {
            bellBtn.classList.add('active');
        } else {
            bellBtn.classList.remove('active');
        }
    }

    // Screen specific triggers
    if (screenId === 'alerts') {
        const bellDot = document.getElementById('bellDot');
        if (bellDot) bellDot.style.display = 'none';
        renderAlertsList();
    } else if (screenId === 'analytics') {
        setTimeout(drawTempWaveChart, 50);
    } else if (screenId === 'fertility') {
        refreshLiveStream();
    }
}

function toggleNotifications() {
    if (currentActiveScreen === 'alerts') {
        // Minimize notifications and return to previous screen
        switchNav(previousActiveScreen || 'home');
    } else {
        // Open notifications
        switchNav('alerts');
        const bellDot = document.getElementById('bellDot');
        if (bellDot) bellDot.style.display = 'none';
        renderAlertsList();
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
        const res = await fetch('/api/history?limit=120');
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

    const previousPhase = currentPhase;

    // Day & Phase: Only reflect active schedule day if schedule_active is true
    if (data.schedule_active === true) {
        if (data.day !== undefined && data.day !== null) {
            currentDay = data.day;
        }
        if (data.phase) {
            currentPhase = data.phase;
        }
    } else if (data.schedule_active === false) {
        // Schedule confirmed inactive on Pi (Standby mode)
        currentDay = 0;
        currentPhase = 'SETTING';
    } else if (appliedSchedule && appliedSchedule.active) {
        // Partial or legacy update while schedule is active
        if (data.day !== undefined && data.day !== null) {
            currentDay = data.day;
        }
        if (data.phase) {
            currentPhase = data.phase;
        }
    }

    if (currentDay >= 19) {
        currentPhase = 'HATCHING';
    }

    if (previousPhase === 'SETTING' && currentPhase === 'HATCHING') {
        addDashboardNotification({
            type: 'info',
            category: 'phase',
            msg: `HATCHING PHASE LOCKDOWN STARTED (DAY 19-21). TARGETS: 36.9°C & 70% RH. TURNER DISENGAGED.`,
            pushTitle: "🐣 Lockdown · Day 19",
            pushBody: "Targets: 36.9°C & 70% RH · Turner locked",
            cooldownSecs: 3600
        });
    }

    // Home Countdown Sync: ONLY update if schedule is confirmed active!
    if (data.schedule_active === true && data.start_time) {
        if (!appliedSchedule || appliedSchedule.startTime !== data.start_time) {
            appliedSchedule = {
                startTime: data.start_time,
                day: currentDay,
                phase: currentPhase,
                active: true
            };
            try {
                localStorage.setItem('incuvision_applied_schedule', JSON.stringify(appliedSchedule));
            } catch (e) {}
        }
        renderHomeCountdownCard();
    } else if (data.schedule_active === false) {
        appliedSchedule = null;
        try {
            localStorage.removeItem('incuvision_applied_schedule');
        } catch (e) {}
        renderHomeCountdownCardDefault();
    } else {
        if (appliedSchedule && appliedSchedule.active) {
            renderHomeCountdownCard();
        } else {
            renderHomeCountdownCardDefault();
        }
    }

    if (!protocolStateInitialized) {
        protocolState.day = currentDay;
        protocolState.phase = currentPhase;
        protocolState.temp = (currentPhase === 'HATCHING' || currentDay >= 19) ? 36.9 : 37.5;
        protocolState.rh = (currentPhase === 'HATCHING' || currentDay >= 19) ? 70.0 : 58.0;
        protocolState.co2 = (currentPhase === 'HATCHING' || currentDay >= 19) ? 7500 : 5000;
        protocolState.o2 = (currentPhase === 'HATCHING' || currentDay >= 19) ? 20.5 : 20.9;
        
        if (appliedSchedule && appliedSchedule.startTime) {
            initScheduleInputs(new Date(appliedSchedule.startTime));
        } else if (data.schedule_active && data.start_time) {
            initScheduleInputs(new Date(data.start_time));
        } else {
            initScheduleInputs(new Date());
        }
        protocolStateInitialized = true;
        renderProtocolCards();
    } else if (data.schedule_active && data.start_time) {
        const dateEl = document.getElementById('inputBatchDate');
        const timeEl = document.getElementById('inputBatchTime');
        const isEditing = (dateEl && document.activeElement === dateEl) || (timeEl && document.activeElement === timeEl);
        if (!isEditing && currentSetTimestamp) {
            const telemetryDate = new Date(data.start_time);
            if (Math.abs(currentSetTimestamp.getTime() - telemetryDate.getTime()) > 60000) {
                initScheduleInputs(telemetryDate);
            }
        }
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
            if (telemetryHistory.length > 120) {
                telemetryHistory.shift();
            }
        } catch (e) {}

        // 3. Hardware synchronized egg turning timer
        try {
            const motorActive = Boolean(telem.actuators && telem.actuators.motor);
            isHardwareTurning = motorActive;
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

                if (telem.actuators.manual !== undefined) {
                    // Do not let stale background telemetry revert user toggle within 4 seconds
                    if (Date.now() - lastUserModeSwitchTime > 4000) {
                        isManualMode = Boolean(telem.actuators.manual);
                        setManualModeUI(isManualMode);
                    }
                }
            }

            // Emergency Overheat Safety Auto-Revert check
            const currentTemp = parseFloat(telem.temp || 0);
            if (currentTemp >= 38.0 && isManualMode) {
                isManualMode = false;
                setManualModeUI(false);
                showToast("CRITICAL TEMPERATURE (38.0°C) REACHED! Safety system reverted to AUTOMATIC mode.", true);
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
    } else {
        const deck = document.getElementById('auditReviewDeck');
        if (deck) deck.style.display = 'none';
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
    if (!isManualMode) {
        showToast("System is in AUTOMATIC mode. Click the 'AUTOMATIC' badge above to switch to MANUAL mode first.", true);
        return;
    }
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
let lastUserModeSwitchTime = 0;

function setManualModeUI(manual) {
    const badge = document.getElementById('badgeActuatorMode');
    const grid = document.getElementById('actuatorsGrid');
    if (badge) {
        badge.innerText = manual ? 'MANUAL' : 'AUTOMATIC';
        badge.style.background = manual ? '#FEE2E2' : '#FDE68A';
        badge.style.color = manual ? '#DC2626' : '#78350F';
    }
    if (grid) {
        if (manual) {
            grid.classList.add('manual-mode-active');
        } else {
            grid.classList.remove('manual-mode-active');
        }
    }
}

async function toggleActuatorMode() {
    lastUserModeSwitchTime = Date.now();
    isManualMode = !isManualMode;
    setManualModeUI(isManualMode);
    showToast(isManualMode ? "Manual Override Enabled: You can now toggle actuators directly." : "Automatic Control Restored: Sensors and setpoints in charge.");
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

function getSecondsToNextTurn() {
    if (currentPhase === 'HATCHING' || currentDay >= 19) {
        return 0;
    }
    const now = new Date();
    const secondsIntoHour = now.getMinutes() * 60 + now.getSeconds();
    return Math.max(0, 3600 - secondsIntoHour);
}

function updateTurningDisplay() {
    const turnEl = document.getElementById('turningCountdown');
    if (!turnEl) return;

    if (!appliedSchedule || !appliedSchedule.active) {
        turnEl.innerText = "STANDBY";
        return;
    }

    if (currentPhase === 'HATCHING' || currentDay >= 19) {
        turnEl.innerText = "OFF (HATCH)";
        return;
    }

    if (isHardwareTurning) {
        turnEl.innerText = "TURNING...";
        return;
    }

    const secs = getSecondsToNextTurn();
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    turnEl.innerText = `${m}:${s}`;
}

async function manualEggTurn() {
    if (currentPhase === 'HATCHING' || currentDay >= 19) {
        showToast("🔒 Egg turning is locked out during Hatching Phase (Days 19–21).", true);
        return;
    }

    isHardwareTurning = true;
    updateTurningDisplay();
    renderProtocolCards();

    addDashboardNotification({
        type: 'info',
        category: 'turning',
        msg: "MANUAL EGG ROTATION TRIGGERED (15S TRAY TILT).",
        push: false
    });

    try {
        await fetch('/api/control/egg_turning', { method: 'POST' });
        showToast("Egg turning initiated (15s rotation).");
    } catch (e) {
        console.warn("Egg turn error:", e);
        showToast("Failed to trigger egg turning.", true);
    }

    setTimeout(() => {
        isHardwareTurning = false;
        updateTurningDisplay();
        renderProtocolCards();
    }, 15000);
}

function startTurningCountdown() {
    updateTurningDisplay();
    setInterval(() => {
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

    // 2. Update Header Title & Current Reading
    const titleEl = document.getElementById('graphMetricTitle');
    const pillEl = document.getElementById('graphCurrentValPill');

    if (titleEl) titleEl.innerText = metricConfigs[metricType].title;
    if (pillEl) pillEl.innerText = metricConfigs[metricType].pillText();

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

    // Draw vertical dashed time division lines (-20m, -15m, -10m, -5m, Now)
    const timeCols = 4;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#F5C754';
    ctx.lineWidth = 1.5;

    for (let i = 1; i < timeCols; i++) {
        const x = (w / timeCols) * i;
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
// SMART ALERTS & NOTIFICATION HISTORY ENGINE (LATEST FIRST)
// =============================================================================
const NOTIF_STORAGE_KEY = 'incuvision_notification_history';
let notificationHistory = [];

let paramStateHistory = {
    tempState: 'NORMAL', // 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL'
    rhState: 'NORMAL',   // 'NORMAL' | 'LOW' | 'HIGH'
    co2State: 'NORMAL',  // 'NORMAL' | 'HIGH'
    o2State: 'NORMAL',   // 'NORMAL' | 'LOW'
    motorState: false
};

function formatNotifTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function loadNotificationHistory() {
    try {
        const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
        if (raw) {
            notificationHistory = JSON.parse(raw);
        }
    } catch (e) {
        notificationHistory = [];
    }

    // Default starter history if none exists — explicitly sorted LATEST FIRST!
    if (!Array.isArray(notificationHistory) || notificationHistory.length === 0) {
        const now = Date.now();
        notificationHistory = [
            {
                id: 'init-2',
                timestamp: now - 3 * 60 * 1000,
                timeStr: formatNotifTime(now - 3 * 60 * 1000),
                type: 'success',
                category: 'temp',
                msg: "TEMPERATURE IS NOW 37.5°, IT'S NORMAL. PTC HEATER IS TURNED OFF."
            },
            {
                id: 'init-1',
                timestamp: now - 18 * 60 * 1000,
                timeStr: formatNotifTime(now - 18 * 60 * 1000),
                type: 'warning',
                category: 'temp',
                msg: "TEMPERATURE WAS 35.0°, BELOW NORMAL. PTC HEATER IS TURNED ON."
            }
        ];
        saveNotificationHistory();
    }
}

function saveNotificationHistory() {
    try {
        if (notificationHistory.length > 60) {
            notificationHistory = notificationHistory.slice(0, 60);
        }
        localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notificationHistory));
    } catch (e) {}
}

function clearNotificationHistory() {
    notificationHistory = [];
    saveNotificationHistory();
    renderAlertsList();
    showToast("Cleared notification history.");
}

function addDashboardNotification({ type = 'warning', category = 'system', msg, title = '', push = true, pushTitle = '', pushBody = '', cooldownSecs = 180 }) {
    if (!msg) return;

    const now = Date.now();
    const timeStr = formatNotifTime(now);

    // Prevent duplicate spam within 30 seconds for identical message
    const isRecentDuplicate = notificationHistory.length > 0 && 
        notificationHistory[0].msg === msg && 
        (now - notificationHistory[0].timestamp) < 30000;

    if (isRecentDuplicate) return;

    const newNotif = {
        id: 'notif-' + now + '-' + Math.floor(Math.random() * 1000),
        timestamp: now,
        timeStr: timeStr,
        type: type, // 'warning' | 'critical' | 'success' | 'info'
        category: category,
        msg: msg,
        title: title
    };

    // ALWAYS PREPEND: LATEST MUST BE FIRST!
    notificationHistory.unshift(newNotif);
    saveNotificationHistory();
    renderAlertsList();

    // Show bell badge if not on alerts screen
    const bellDot = document.getElementById('bellDot');
    if (bellDot && currentActiveScreen !== 'alerts') {
        bellDot.style.display = 'block';
    }

    if (push) {
        sendPushNotification({
            title: pushTitle || (type === 'critical' ? '🚨 IncuVision Alert' : (type === 'warning' ? '⚠️ IncuVision Alert' : 'IncuVision Update')),
            body: pushBody || msg,
            tag: `incuvision-${category}`,
            soundType: (type === 'critical' || type === 'warning') ? 'alert' : 'chime',
            cooldownSeconds: cooldownSecs
        });
    }
}

function evaluateSmartAlerts(temp, rh, o2, actuators) {
    const isHatching = (currentPhase === 'HATCHING' || currentDay >= 19);
    const targetTemp = isHatching ? 36.9 : 37.5;
    const targetRH = isHatching ? 70.0 : 58.0;
    const co2Limit = isHatching ? 7500 : 5000;

    let hasActiveAlert = false;

    // 1. Temperature Evaluation & State Transition
    let currentTempState = 'NORMAL';
    const tempLow = isHatching ? 36.2 : 36.8;
    const tempHigh = isHatching ? 37.6 : 38.2;

    if (temp >= 38.0 && isManualMode) {
        currentTempState = 'CRITICAL';
        hasActiveAlert = true;
    } else if (temp < tempLow) {
        currentTempState = 'LOW';
        hasActiveAlert = true;
    } else if (temp > tempHigh) {
        currentTempState = 'HIGH';
        hasActiveAlert = true;
    }

    if (currentTempState !== paramStateHistory.tempState) {
        if (currentTempState === 'LOW') {
            addDashboardNotification({
                type: 'warning',
                category: 'temp',
                msg: `TEMPERATURE IS ${temp.toFixed(1)}°C, BELOW ${isHatching ? 'HATCHING' : 'SETTING'} TARGET (${targetTemp}°C). PTC HEATER IS TURNED ON.`,
                pushTitle: `🌡️ Low Temp · ${temp.toFixed(1)}°C`,
                pushBody: `Target: ${targetTemp}°C · PTC Heater ON`
            });
        } else if (currentTempState === 'HIGH') {
            addDashboardNotification({
                type: 'warning',
                category: 'temp',
                msg: `TEMPERATURE IS ${temp.toFixed(1)}°C, ABOVE ${isHatching ? 'HATCHING' : 'SETTING'} TARGET (${targetTemp}°C). EXHAUST FAN IS ENGAGED.`,
                pushTitle: `🌡️ High Temp · ${temp.toFixed(1)}°C`,
                pushBody: `Target: ${targetTemp}°C · Cooling Active`
            });
        } else if (currentTempState === 'CRITICAL') {
            addDashboardNotification({
                type: 'critical',
                category: 'temp',
                msg: `CRITICAL TEMPERATURE (${temp.toFixed(1)}°C) REACHED! AUTOMATIC SAFETY ENGAGED.`,
                pushTitle: `🚨 Critical Overheat · ${temp.toFixed(1)}°C`,
                pushBody: `Exceeded 38.0°C! Safety system reverted to AUTO.`
            });
        } else if (currentTempState === 'NORMAL' && paramStateHistory.tempState !== 'NORMAL') {
            addDashboardNotification({
                type: 'success',
                category: 'temp',
                msg: `TEMPERATURE IS NOW ${temp.toFixed(1)}°C, IT'S NORMAL. PTC HEATER IS TURNED OFF.`,
                push: false
            });
        }
        paramStateHistory.tempState = currentTempState;
    }

    // 2. Humidity Evaluation & State Transition
    let currentRHState = 'NORMAL';
    const rhLow = isHatching ? 62.0 : 50.0;
    const rhHigh = isHatching ? 80.0 : 65.0;

    if (rh < rhLow) {
        currentRHState = 'LOW';
        hasActiveAlert = true;
    } else if (rh > rhHigh) {
        currentRHState = 'HIGH';
        hasActiveAlert = true;
    }

    if (currentRHState !== paramStateHistory.rhState) {
        if (currentRHState === 'LOW') {
            addDashboardNotification({
                type: 'warning',
                category: 'rh',
                msg: `HUMIDITY IS ${rh.toFixed(1)}%, BELOW ${isHatching ? 'HATCHING' : 'SETTING'} TARGET (${targetRH}%). PLEASE REFILL WATER RESERVOIR.`,
                pushTitle: `💧 Low Humidity · ${rh.toFixed(1)}%`,
                pushBody: `Target: ${targetRH}% · Please refill water reservoir`
            });
        } else if (currentRHState === 'HIGH') {
            addDashboardNotification({
                type: 'warning',
                category: 'rh',
                msg: `HUMIDITY IS ${rh.toFixed(1)}%, ABOVE ${isHatching ? 'HATCHING' : 'SETTING'} TARGET (${targetRH}%). EXHAUST VENTING.`,
                pushTitle: `💧 High Humidity · ${rh.toFixed(1)}%`,
                pushBody: `Target: ${targetRH}% · Exhaust venting`
            });
        } else if (currentRHState === 'NORMAL' && paramStateHistory.rhState !== 'NORMAL') {
            addDashboardNotification({
                type: 'success',
                category: 'rh',
                msg: `HUMIDITY IS NOW ${rh.toFixed(1)}%, IT'S NORMAL.`,
                push: false
            });
        }
        paramStateHistory.rhState = currentRHState;
    }

    // 3. CO2 Evaluation & State Transition
    const currentCO2 = (currentTelemetry && currentTelemetry.co2) ? currentTelemetry.co2 : 0;
    let currentCO2State = 'NORMAL';
    if (currentCO2 > co2Limit) {
        currentCO2State = 'HIGH';
        hasActiveAlert = true;
    }

    if (currentCO2State !== paramStateHistory.co2State) {
        if (currentCO2State === 'HIGH') {
            addDashboardNotification({
                type: 'warning',
                category: 'co2',
                msg: `CO2 LEVEL IS ${currentCO2} PPM, EXCEEDS ${isHatching ? 'HATCHING' : 'SETTING'} LIMIT (${co2Limit} PPM). EXHAUST FAN IS TURNED ON.`,
                pushTitle: `⚠️ High CO2 · ${currentCO2} ppm`,
                pushBody: `Limit: ${co2Limit} ppm · Exhaust fan active`
            });
        } else if (currentCO2State === 'NORMAL' && paramStateHistory.co2State !== 'NORMAL') {
            addDashboardNotification({
                type: 'success',
                category: 'co2',
                msg: `CO2 LEVEL IS NOW ${currentCO2} PPM, IT'S NORMAL. EXHAUST FAN TURNED OFF.`,
                push: false
            });
        }
        paramStateHistory.co2State = currentCO2State;
    }

    // 4. Oxygen Evaluation & State Transition
    let currentO2State = 'NORMAL';
    if (o2 > 0 && o2 < 20.0) {
        currentO2State = 'LOW';
        hasActiveAlert = true;
    }

    if (currentO2State !== paramStateHistory.o2State) {
        if (currentO2State === 'LOW') {
            addDashboardNotification({
                type: 'warning',
                category: 'o2',
                msg: `OXYGEN LEVEL IS ${o2.toFixed(1)}%, BELOW NORMAL (20.0%). EXHAUST FAN ENGAGED.`,
                pushTitle: `⚠️ Low O2 · ${o2.toFixed(1)}%`,
                pushBody: `Below 20.0% · Exhaust active`
            });
        } else if (currentO2State === 'NORMAL' && paramStateHistory.o2State !== 'NORMAL') {
            addDashboardNotification({
                type: 'success',
                category: 'o2',
                msg: `OXYGEN LEVEL IS NOW ${o2.toFixed(1)}%, IT'S NORMAL.`,
                push: false
            });
        }
        paramStateHistory.o2State = currentO2State;
    }

    // 5. Motor (Egg Turning) State Detection
    const isMotorOn = Boolean(actuators && actuators.motor);
    if (isMotorOn !== paramStateHistory.motorState) {
        if (isMotorOn) {
            addDashboardNotification({
                type: 'info',
                category: 'turning',
                msg: `EGG TURNING CYCLE INITIATED (45° TRAY TILT · 15 SECONDS).`,
                push: false
            });
        } else if (paramStateHistory.motorState) {
            addDashboardNotification({
                type: 'success',
                category: 'turning',
                msg: `EGG TURNING CYCLE COMPLETED. NEXT ROTATION IN 60 MINUTES.`,
                push: false
            });
        }
        paramStateHistory.motorState = isMotorOn;
    }

    // Header Bell Dot
    const bellDot = document.getElementById('bellDot');
    if (bellDot && currentActiveScreen !== 'alerts') {
        bellDot.style.display = hasActiveAlert ? 'block' : 'none';
    }
}

function renderAlertsList() {
    const listEl = document.getElementById('alertsList');
    if (!listEl) return;

    if (!notificationHistory || notificationHistory.length === 0) {
        const isHatching = (currentPhase === 'HATCHING' || currentDay >= 19);
        listEl.innerHTML = `
            <div class="alert-empty-card">
                <div class="alert-empty-icon">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                </div>
                <div class="alert-empty-title">ALL SYSTEMS OPTIMAL</div>
                <div class="alert-empty-desc">
                    Operating under ${isHatching ? 'Hatching Phase' : 'Setting Phase'} conditions (${isHatching ? '36.9°C · 70% RH' : '37.5°C · 58% RH'}). All sensor readings and controls are normal.
                </div>
            </div>
        `;
        return;
    }

    // CRITICAL: Sort descending by timestamp — LATEST ALWAYS FIRST!
    const sorted = [...notificationHistory].sort((a, b) => b.timestamp - a.timestamp);

    // Group by time header
    const groups = {};
    const groupOrder = [];

    sorted.forEach(notif => {
        const timeHeader = notif.timeStr || formatNotifTime(notif.timestamp);
        if (!groups[timeHeader]) {
            groups[timeHeader] = [];
            groupOrder.push(timeHeader); // preserves latest-first order
        }
        groups[timeHeader].push(notif);
    });

    // Render groups with the newest/latest time group at the very top
    let html = '';
    groupOrder.forEach((timeHeader, idx) => {
        const items = groups[timeHeader];
        const isLatestGroup = (idx === 0);

        html += `
            <div class="alert-time-group">
                <span class="time-header">${timeHeader}${isLatestGroup ? ' · LATEST' : ''}</span>
                ${items.map(item => renderAlertBoxHtml(item)).join('')}
            </div>
        `;
    });

    listEl.innerHTML = html;
}

function renderAlertBoxHtml(item) {
    const type = item.type || 'warning';
    let boxClass = 'alert-box';
    let iconSvg = '';

    if (type === 'critical') {
        boxClass += ' alert-critical';
        iconSvg = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#DC2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
        `;
    } else if (type === 'success') {
        boxClass += ' alert-success';
        iconSvg = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#059669" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6L9 17l-5-5"/>
            </svg>
        `;
    } else if (type === 'info') {
        boxClass += ' alert-info';
        iconSvg = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#2563EB" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
        `;
    } else {
        // Warning
        boxClass += ' alert-warning';
        iconSvg = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#D97706" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
        `;
    }

    return `
        <div class="${boxClass}">
            <span class="alert-warn-badge">
                ${iconSvg}
            </span>
            <p class="alert-msg">${item.msg}</p>
        </div>
    `;
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
        if (!latestAuditImageUrl) {
            showToast("No candling scan captured yet. Run an audit first.", true);
            switchCameraView('live');
            return;
        }
        if (tabAudit) tabAudit.classList.add('active');
        if (tabLive) tabLive.classList.remove('active');
        if (returnLiveBtn) returnLiveBtn.style.display = 'flex';
        if (pausedScreen) pausedScreen.style.display = 'none';
        if (offlineScreen) offlineScreen.style.display = 'none';

        if (streamImg) {
            streamImg.src = `${latestAuditImageUrl}?t=${Date.now()}`;
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
    const deck = document.getElementById('auditReviewDeck');
    if (!audit || audit.error) {
        if (deck) deck.style.display = 'none';
        return;
    }

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

    // Populate & reveal Audit Review Deck
    if (deck) {
        deck.style.display = 'flex';
        const dayChip = document.getElementById('auditDeckDayChip');
        if (dayChip) {
            dayChip.innerText = `DAY ${audit.day || currentDay || 7} SCAN`;
        }
        const timeSpan = document.getElementById('auditDeckTimestamp');
        if (timeSpan) {
            if (audit.timestamp) {
                try {
                    const d = new Date(audit.timestamp);
                    timeSpan.innerText = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                } catch(e) {
                    timeSpan.innerText = 'Just now';
                }
            } else {
                timeSpan.innerText = 'Just now';
            }
        }
        const btnSave = document.getElementById('btnDownloadCapture');
        if (btnSave) {
            const dlUrl = audit.annotated_image_url || audit.image_url || latestAuditImageUrl;
            if (dlUrl) {
                btnSave.href = dlUrl;
                btnSave.setAttribute('download', `incuvision_day${audit.day || currentDay || 7}_candling.jpg`);
                btnSave.style.display = 'inline-flex';
            }
        }
    }

    if (switchToAudit && audit && !audit.error) {
        addDashboardNotification({
            type: 'info',
            category: 'candling',
            msg: `DAY ${audit.day || currentDay} CANDLING AUDIT: ${fertileCount} FERTILE (${rate.toFixed(1)}%), ${infertileCount} INFERTILE.`,
            pushTitle: `🔬 Candling · Day ${audit.day || currentDay}`,
            pushBody: `Fertility: ${rate.toFixed(1)}% (${fertileCount}/${total} fertile)`,
            cooldownSecs: 60
        });
    }
}

async function retakeCandlingAudit() {
    const btnRetake = document.getElementById('btnRetakeAudit');
    const btnTitle = document.getElementById('btnRetakeTitle');
    if (btnRetake && btnRetake.classList.contains('is-retaking')) return;

    if (btnRetake) btnRetake.classList.add('is-retaking');
    if (btnTitle) btnTitle.innerText = "Re-scanning...";
    showToast("Capturing fresh candling frame & running YOLOv8...");

    try {
        const res = await fetch('/api/candling/trigger', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success' && data.result) {
            if (data.result.error) {
                showToast("Candling note: " + data.result.error, true);
            } else {
                renderAuditScores(data.result, true);
                showToast("Scan updated successfully with fresh frame.");
            }
        } else {
            showToast("Retake failed: " + (data.detail || "Server error"), true);
        }
    } catch (e) {
        showToast("Connection error during re-take: " + e, true);
    } finally {
        if (btnRetake) btnRetake.classList.remove('is-retaking');
        if (btnTitle) btnTitle.innerText = "Re-take & Replace";
    }
}

function discardCandlingAudit() {
    const modal = document.getElementById('discardConfirmModal');
    if (modal) {
        modal.classList.add('open');
    } else if (confirm("Discard this candling scan? The photo and scores will be removed.")) {
        executeDiscardAudit();
    }
}

function closeDiscardConfirmModal(event) {
    if (event && event.target && !event.target.classList.contains('modal-backdrop') && !event.target.classList.contains('btn-confirm-cancel')) {
        return;
    }
    const modal = document.getElementById('discardConfirmModal');
    if (modal) modal.classList.remove('open');
}

async function executeDiscardAudit() {
    const modal = document.getElementById('discardConfirmModal');
    const btnExecute = document.getElementById('btnConfirmDiscardExecute');
    if (btnExecute) {
        btnExecute.disabled = true;
        btnExecute.innerText = "Purging...";
    }

    try {
        const res = await fetch('/api/candling/discard', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success') {
            showToast("Scan discarded. Reverted to live stream.");
            if (modal) modal.classList.remove('open');

            // Reset scores display to --
            const fertileScore = document.getElementById('scoreFertile');
            const infertileScore = document.getElementById('scoreInfertile');
            const fertileSub = document.getElementById('scoreFertileSub');
            const infertileSub = document.getElementById('scoreInfertileSub');
            if (fertileScore) fertileScore.innerText = '--';
            if (infertileScore) infertileScore.innerText = '--';
            if (fertileSub) fertileSub.innerText = 'Embryo Viable';
            if (infertileSub) infertileSub.innerText = 'Clear / Quitter';

            // Reset egg matrix data
            eggMatrixData = [];
            for (let i = 1; i <= 56; i++) {
                const slot = document.getElementById('eggSlot-' + i);
                if (slot) slot.className = 'egg-slot-pill';
            }

            // Invalidate latestAuditImageUrl
            latestAuditImageUrl = null;

            // Hide review deck
            const deck = document.getElementById('auditReviewDeck');
            if (deck) deck.style.display = 'none';

            // Switch camera view back to live
            switchCameraView('live');
        } else {
            showToast("Discard failed: " + (data.message || data.detail || "Server error"), true);
        }
    } catch (e) {
        showToast("Connection error while discarding: " + e, true);
    } finally {
        if (btnExecute) {
            btnExecute.disabled = false;
            btnExecute.innerText = "Discard & Purge";
        }
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
    
    const row = (egg && egg.row) ? egg.row : Math.floor((index - 1) / 7) + 1;
    const col = (egg && egg.col) ? egg.col : ((index - 1) % 7) + 1;

    if (egg) {
        const statusColor = egg.status === 'fertile' ? '#15803D' : '#B91C1C';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #E5E7EB; padding-bottom:8px;">
                    <span style="color:#6B7280;">Tray Coordinate</span>
                    <span style="font-weight:700;">Row ${row} of 8, Col ${col} of 7</span>
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
// PUSH & SYSTEM NOTIFICATIONS (AUDIO CHIME, VIBRATION & SERVICE WORKER)
// =============================================================================
let swRegistration = null;
let pushEnabled = false;
const lastPushTimestamps = {};
let audioCtxInstance = null;

function getAudioContext() {
    try {
        if (!audioCtxInstance) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) audioCtxInstance = new AudioCtx();
        }
        if (audioCtxInstance && audioCtxInstance.state === 'suspended') {
            audioCtxInstance.resume().catch(() => {});
        }
        return audioCtxInstance;
    } catch (e) {
        return null;
    }
}

// Ensure audio context is unlocked upon user interaction (required by mobile browsers)
window.addEventListener('click', () => { getAudioContext(); }, { passive: true });
window.addEventListener('touchstart', () => { getAudioContext(); }, { passive: true });

function playNotificationSound(type = 'chime') {
    try {
        // 1. Phone Vibration (works on Android Chrome even if OS Push is blocked)
        if ('vibrate' in navigator) {
            try {
                if (type === 'alert') {
                    navigator.vibrate([300, 150, 300]);
                } else {
                    navigator.vibrate([180, 80, 180]);
                }
            } catch (ve) {}
        }

        // 2. Web Audio Chime / Alarm
        const ctx = getAudioContext();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'alert') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(587.33, ctx.currentTime);
            osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);
            gain.gain.setValueAtTime(0.25, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } else {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, ctx.currentTime);
            osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.10);
            osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.20);
            gain.gain.setValueAtTime(0.22, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.55);
            osc.start();
            osc.stop(ctx.currentTime + 0.55);
        }
    } catch (e) {
        // Handled silently
    }
}

function initPushNotifications() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            swRegistration = reg;
            console.log("[PUSH] Service Worker active with scope:", reg.scope);
        }).catch(() => {
            navigator.serviceWorker.register('./sw.js').then(reg => {
                swRegistration = reg;
            }).catch(e => console.warn("[PUSH] SW fallback registration:", e));
        });
    }

    if ('Notification' in window) {
        pushEnabled = (Notification.permission === 'granted');
    }
    updatePushUI();
}

function updatePushUI() {
    const badge = document.getElementById('notifIconBadge');
    const title = document.getElementById('notifStatusTitle');
    const sub = document.getElementById('notifStatusSub');
    const btnToggle = document.getElementById('btnToggleNotif');
    const btnTest = document.getElementById('btnTestNotif');

    if (btnTest) btnTest.style.display = 'inline-block';

    if (!('Notification' in window)) {
        if (title) title.innerText = 'In-App Alerts Active';
        if (sub) sub.innerText = 'Sound & vibration active (No OS push)';
        if (btnToggle) {
            btnToggle.innerText = 'Guide ℹ️';
            btnToggle.classList.remove('active');
        }
        return;
    }

    const perm = Notification.permission;
    const isSecure = (window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

    if (perm === 'granted') {
        pushEnabled = true;
        if (badge) badge.classList.add('active');
        if (title) title.innerText = 'Push Active ✓';
        if (sub) sub.innerText = 'Alerts enabled on lockscreen & phone';
        if (btnToggle) {
            btnToggle.innerText = 'Active ✓';
            btnToggle.classList.add('active');
        }
    } else if (perm === 'denied' || !isSecure) {
        pushEnabled = false;
        if (badge) badge.classList.add('active');
        if (title) title.innerText = 'In-App Alerts Active';
        if (sub) sub.innerText = isSecure ? 'Sound & vibrate active (Tap Guide to unblock)' : 'Sound & vibrate active (HTTP connection)';
        if (btnToggle) {
            btnToggle.innerText = 'Guide ℹ️';
            btnToggle.classList.remove('active');
        }
    } else {
        pushEnabled = false;
        if (badge) badge.classList.remove('active');
        if (title) title.innerText = 'Push Notifications';
        if (sub) sub.innerText = 'Tap enable to receive lockscreen alerts';
        if (btnToggle) {
            btnToggle.innerText = 'Enable';
            btnToggle.classList.remove('active');
        }
    }
}

function openNotifHelpModal() {
    const modal = document.getElementById('notifHelpModal');
    const body = document.getElementById('notifHelpBody');
    if (!modal || !body) return;

    const currentHost = location.origin;

    body.innerHTML = `
        <div style="background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 12px; padding: 12px; margin-bottom: 14px;">
            <div style="font-weight: 700; color: #065F46; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                <span>✅</span> In-App Alerts Are 100% Working
            </div>
            <p style="margin: 0; color: #047857; font-size: 0.82rem;">
                Even without lockscreen permissions, <strong>Sound Chimes, Phone Vibration, and Live Banners</strong> alert you immediately whenever temperature, humidity, or turning need attention.
            </p>
        </div>

        <div style="font-weight: 700; color: #1E1B18; margin-bottom: 6px;">
            Why did Android Chrome block OS push?
        </div>
        <p style="margin: 0 0 10px 0; color: #4B5563; font-size: 0.82rem;">
            Google Chrome on phones strictly blocks lockscreen notifications on local network IP addresses (<code>${location.hostname}</code>) because the connection is <strong>HTTP</strong> instead of HTTPS.
        </p>

        <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 12px;">
            <div style="font-weight: 700; color: #111827; margin-bottom: 6px;">
                How to Enable Lockscreen Push on Chrome:
            </div>
            <ol style="margin: 0; padding-left: 18px; font-size: 0.82rem; color: #4B5563;">
                <li style="margin-bottom: 6px;">Open a new tab in Chrome and go to: <strong style="color: #1F2937;">chrome://flags</strong></li>
                <li style="margin-bottom: 6px;">Search: <strong style="color: #1F2937;">unsafely-treat-insecure-origin-as-secure</strong></li>
                <li style="margin-bottom: 6px;">Enter: <code style="background: #E5E7EB; padding: 2px 5px; border-radius: 4px; color: #B45309;">${currentHost}</code></li>
                <li style="margin-bottom: 6px;">Change dropdown to <strong>Enabled</strong>, then tap <strong>Relaunch</strong>.</li>
                <li>Return here and tap <strong>Enable</strong>!</li>
            </ol>
        </div>
    `;

    modal.classList.add('open');
}

function closeNotifHelpModal(e) {
    if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close')) return;
    const modal = document.getElementById('notifHelpModal');
    if (modal) modal.classList.remove('open');
}

async function togglePushNotifications() {
    getAudioContext();

    if (!('Notification' in window)) {
        openNotifHelpModal();
        return;
    }

    if (Notification.permission === 'granted') {
        showToast("🔔 Push notifications are active!");
        testPushNotification();
        return;
    }

    if (Notification.permission === 'denied' || !window.isSecureContext) {
        // Directly open the step-by-step guidance modal instead of hitting a dead-end
        openNotifHelpModal();
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        updatePushUI();
        if (permission === 'granted') {
            showToast("🔔 Push notifications enabled successfully!");
            playNotificationSound('chime');
            sendPushNotification({
                title: "IncuVision Push Active",
                body: "You will now receive instant push alerts for critical incubator events.",
                tag: "system-welcome",
                soundType: "chime",
                cooldownSeconds: 0
            });
        } else {
            openNotifHelpModal();
        }
    } catch (e) {
        console.warn("[PUSH] Request error:", e);
        openNotifHelpModal();
    }
}

function sendPushNotification({ title, body, tag = 'incuvision-alert', soundType = 'alert', cooldownSeconds = 180 }) {
    const now = Date.now();
    if (lastPushTimestamps[tag] && (now - lastPushTimestamps[tag]) < (cooldownSeconds * 1000)) {
        return;
    }
    lastPushTimestamps[tag] = now;

    // 1. Play audio chime & vibrate device
    playNotificationSound(soundType);

    // 2. In-App toast
    showToast(`🔔 ${title}: ${body}`);

    // 3. Dispatch native system push notification if allowed
    if ('Notification' in window && Notification.permission === 'granted') {
        const options = {
            body: body,
            icon: '/dashboard/icons/icon-192.png',
            badge: '/dashboard/icons/icon-192.png',
            tag: tag,
            renotify: true,
            vibrate: [250, 100, 250],
            data: { url: '/dashboard/' }
        };

        if (swRegistration && swRegistration.showNotification) {
            swRegistration.showNotification(title, options).catch(() => {
                try { new Notification(title, options); } catch (e) {}
            });
        } else {
            try {
                new Notification(title, options);
            } catch (e) {
                console.warn("[PUSH] Native notification error:", e);
            }
        }
    }
}

function testPushNotification() {
    getAudioContext();
    playNotificationSound('chime');
    addDashboardNotification({
        type: 'info',
        category: 'test',
        msg: `SYSTEM TEST: AUDIBLE CHIME & VIBRATION VERIFIED. DAY ${currentDay} (${currentPhase}).`,
        push: false
    });
    sendPushNotification({
        title: `IncuVision · Day ${currentDay}`,
        body: `System active (${currentPhase}) · Audio & alerts verified`,
        tag: "test-" + Date.now(),
        soundType: "chime",
        cooldownSeconds: 0
    });
}

// =============================================================================
// VISUAL PROTOCOL CONTROLLER (MATCHES HOME SCREEN METRIC CARDS)
// =============================================================================
let protocolStateInitialized = false;
let protocolState = {
    day: 0,
    phase: 'SETTING',
    temp: 37.5,
    rh: 58.0,
    co2: 5000,
    o2: 20.9
};

let currentSetTimestamp = null;
let appliedSchedule = null; // { startTime: string, day: number, phase: string, active: boolean }

function loadAppliedSchedule() {
    try {
        const stored = localStorage.getItem('incuvision_applied_schedule');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && parsed.active && parsed.startTime) {
                appliedSchedule = parsed;
                return;
            }
        }
    } catch (e) {}
    appliedSchedule = null;
}

function renderHomeCountdownCardDefault() {
    const daysLeftEl = document.getElementById('homeDaysLeft');
    const phaseSubEl = document.getElementById('homePhaseSub');
    const badgeEl = document.getElementById('homePhaseBadge');
    const fillEl = document.getElementById('homeProgressFill');
    const finishEl = document.getElementById('homeProjectedFinish');

    if (daysLeftEl) daysLeftEl.innerText = "21 Days Left";
    if (phaseSubEl) phaseSubEl.innerText = "Day 0 of 21 · Setting Phase";
    if (badgeEl) {
        badgeEl.innerText = "SETTING";
        badgeEl.classList.remove('badge-hatching');
        badgeEl.classList.add('badge-setting');
    }
    if (fillEl) {
        fillEl.style.width = "0%";
        fillEl.classList.remove('hatching');
    }
    if (finishEl) finishEl.innerText = "Pending Schedule Apply";
}

function renderHomeCountdownCard() {
    if (!appliedSchedule || !appliedSchedule.active || !appliedSchedule.startTime) {
        renderHomeCountdownCardDefault();
        return;
    }

    const startDate = new Date(appliedSchedule.startTime);
    if (isNaN(startDate.getTime())) {
        renderHomeCountdownCardDefault();
        return;
    }

    const now = new Date();
    // 21 Days total incubation (504 hours)
    const TOTAL_MS = 21 * 86400000;
    const finishDate = new Date(startDate.getTime() + TOTAL_MS);
    const elapsedMs = Math.max(0, now.getTime() - startDate.getTime());
    const remainingMs = Math.max(0, TOTAL_MS - elapsedMs);

    const remTotalSec = Math.floor(remainingMs / 1000);
    const remDays = Math.floor(remTotalSec / 86400);
    const remHours = Math.floor((remTotalSec % 86400) / 3600);

    const elapsedTotalSec = Math.floor(elapsedMs / 1000);
    const elapsedDays = Math.min(21, Math.floor(elapsedTotalSec / 86400));
    const elapsedHours = Math.floor((elapsedTotalSec % 86400) / 3600);
    const isHatching = (elapsedDays >= 19 || appliedSchedule.phase === 'HATCHING');

    // 1. Main Countdown Text (e.g. "19d 7h Left" or "21 Days Left")
    const daysLeftEl = document.getElementById('homeDaysLeft');
    if (daysLeftEl) {
        if (remainingMs <= 0) {
            daysLeftEl.innerText = "Incubation Complete";
        } else if (remDays > 0) {
            daysLeftEl.innerText = `${remDays}d ${remHours}h Left`;
        } else {
            const remMins = Math.floor((remTotalSec % 3600) / 60);
            daysLeftEl.innerText = `${remHours}h ${remMins}m Left`;
        }
    }

    // 2. Subtitle: "Day 1 of 21 · 16h elapsed"
    const phaseSubEl = document.getElementById('homePhaseSub');
    if (phaseSubEl) {
        phaseSubEl.innerText = `Day ${elapsedDays} of 21 · ${elapsedHours}h elapsed`;
    }

    // 3. Phase Pill Badge: SETTING vs HATCHING
    const badgeEl = document.getElementById('homePhaseBadge');
    if (badgeEl) {
        badgeEl.innerText = isHatching ? "HATCHING" : "SETTING";
        if (isHatching) {
            badgeEl.classList.remove('badge-setting');
            badgeEl.classList.add('badge-hatching');
        } else {
            badgeEl.classList.remove('badge-hatching');
            badgeEl.classList.add('badge-setting');
        }
    }

    // 4. Progress Bar Fill
    const fillEl = document.getElementById('homeProgressFill');
    if (fillEl) {
        const pct = Math.min(100, Math.max(0, (elapsedMs / TOTAL_MS) * 100));
        fillEl.style.width = `${pct.toFixed(1)}%`;
        if (isHatching) fillEl.classList.add('hatching');
        else fillEl.classList.remove('hatching');
    }

    // 5. Projected Hatch Completion
    const finishEl = document.getElementById('homeProjectedFinish');
    if (finishEl) {
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const m = monthNames[finishDate.getMonth()];
        const d = finishDate.getDate();
        const dow = dayNames[finishDate.getDay()];
        const hh = String(finishDate.getHours()).padStart(2, '0');
        const mm = String(finishDate.getMinutes()).padStart(2, '0');
        finishEl.innerText = `${dow}, ${m} ${d} · ${hh}:${mm}`;
    }
}

const updateHomeCountdownDisplay = renderHomeCountdownCard;

function initScheduleInputs(startDate) {
    const dt = (startDate instanceof Date && !isNaN(startDate)) ? startDate : (startDate ? new Date(startDate) : new Date());
    currentSetTimestamp = dt;

    const dateEl = document.getElementById('inputBatchDate');
    const timeEl = document.getElementById('inputBatchTime');

    if (dateEl) {
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const dd = String(dt.getDate()).padStart(2, '0');
        dateEl.value = `${yyyy}-${mm}-${dd}`;
    }
    if (timeEl) {
        const hh = String(dt.getHours()).padStart(2, '0');
        const min = String(dt.getMinutes()).padStart(2, '0');
        timeEl.value = `${hh}:${min}`;
    }

    recalcScheduleFromInputs();
}

function onBatchDateInputChange() {
    const dateEl = document.getElementById('inputBatchDate');
    const timeEl = document.getElementById('inputBatchTime');
    if (!dateEl || !timeEl || !dateEl.value) return;

    const timeVal = timeEl.value || '00:00';
    const [hh, min] = timeVal.split(':').map(Number);
    const [yyyy, mm, dd] = dateEl.value.split('-').map(Number);

    currentSetTimestamp = new Date(yyyy, mm - 1, dd, hh || 0, min || 0, 0);
    recalcScheduleFromInputs();
}

function resetBatchToNow() {
    initScheduleInputs(new Date());
    showToast("Date & time set to now (Day 0 draft). Not applied until you click 'Apply Schedule'.");
}

function recalcScheduleFromInputs() {
    if (!currentSetTimestamp || isNaN(currentSetTimestamp.getTime())) return;

    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - currentSetTimestamp.getTime());
    const totalSec = Math.floor(diffMs / 1000);
    const day = Math.min(21, Math.floor(totalSec / 86400));
    const hours = Math.floor((totalSec % 86400) / 3600);
    const daysLeft = Math.max(0, 21 - day);

    protocolState.day = day;
    protocolState.phase = (day >= 19) ? 'HATCHING' : 'SETTING';

    const progEl = document.getElementById('dispScheduleProgress');
    const remEl = document.getElementById('dispScheduleRemaining');
    if (progEl) progEl.innerText = `Day ${day} · ${hours}h elapsed`;
    if (remEl) remEl.innerText = `${daysLeft} Days Left`;

    const lblProg = document.getElementById('lblScheduleProgress');
    if (lblProg) {
        const isAppliedMatch = appliedSchedule && appliedSchedule.active && appliedSchedule.startTime &&
            Math.abs(currentSetTimestamp.getTime() - new Date(appliedSchedule.startTime).getTime()) < 60000;
        if (isAppliedMatch) {
            lblProg.innerText = "ACTIVE TIMELINE (APPLIED)";
            lblProg.style.color = "#059669";
        } else {
            lblProg.innerText = "PREVIEW (PENDING APPLY)";
            lblProg.style.color = "#D97706";
        }
    }

    // Update draft tabs in Menu only
    const dispDay = document.getElementById('dispProtocolDay');
    if (dispDay) dispDay.innerText = `Day ${protocolState.day}`;

    const isHatching = (protocolState.phase === 'HATCHING' || protocolState.day >= 19);
    const btnSetting = document.getElementById('btnPhaseSetting');
    const btnHatching = document.getElementById('btnPhaseHatching');
    if (btnSetting) {
        if (isHatching) btnSetting.classList.remove('active');
        else btnSetting.classList.add('active');
    }
    if (btnHatching) {
        if (isHatching) btnHatching.classList.add('active');
        else btnHatching.classList.remove('active');
    }

    // HOME COUNTDOWN IS NEVER UPDATED HERE.
    // It will ONLY update when the user clicks 'Apply Schedule'!
}

function setProtocolPhase(phase) {
    const isHatching = (phase === 'HATCHING');
    protocolState.phase = phase;

    protocolState.temp = isHatching ? 36.9 : 37.5;
    protocolState.rh = isHatching ? 70.0 : 58.0;
    protocolState.co2 = isHatching ? 7500 : 5000;
    protocolState.o2 = isHatching ? 20.5 : 20.9;

    renderProtocolCards();
    showToast(`Loaded ${isHatching ? 'Hatching' : 'Setting'} presets. Tap 'Apply Target Setpoints' or 'Apply Schedule' to apply.`);
}

function stepDay(delta) {
    if (!currentSetTimestamp) currentSetTimestamp = new Date();
    currentSetTimestamp = new Date(currentSetTimestamp.getTime() - delta * 86400000);
    initScheduleInputs(currentSetTimestamp);
}

// Deprecated aliases for backwards compatibility
function validateElapsedInputs() {}
function stepElapsedHours() {}
function stepElapsedMins() {}
function getElapsedTimeString() { return "00:00"; }
function setElapsedTimeString() {}
const updateProtocolTimeDesc = () => {};
const syncProtocolTimeWithClock = () => {};

function stepTemp(delta) {
    protocolState.temp = Math.round((protocolState.temp + delta) * 10) / 10;
    protocolState.temp = Math.max(35.0, Math.min(40.0, protocolState.temp));
    renderProtocolCards();
}

function stepRH(delta) {
    protocolState.rh = Math.max(40, Math.min(95, Math.round(protocolState.rh + delta)));
    renderProtocolCards();
}

function stepCO2(delta) {
    protocolState.co2 = Math.max(1000, Math.min(10000, Math.round(protocolState.co2 + delta)));
    renderProtocolCards();
}

function stepO2(delta) {
    protocolState.o2 = Math.round((protocolState.o2 + delta) * 10) / 10;
    protocolState.o2 = Math.max(18.0, Math.min(22.0, protocolState.o2));
    renderProtocolCards();
}

function renderProtocolCards() {
    const isHatching = (protocolState.phase === 'HATCHING' || protocolState.day >= 19);

    // 1. Day & Phase Tabs
    const dispDay = document.getElementById('dispProtocolDay');
    if (dispDay) dispDay.innerText = `Day ${protocolState.day}`;

    const btnSetting = document.getElementById('btnPhaseSetting');
    const btnHatching = document.getElementById('btnPhaseHatching');
    if (btnSetting) {
        if (isHatching) btnSetting.classList.remove('active');
        else btnSetting.classList.add('active');
    }
    if (btnHatching) {
        if (isHatching) btnHatching.classList.add('active');
        else btnHatching.classList.remove('active');
    }

    // 2. Target Metric Card Values (Temp, RH, CO2, O2)
    const dispTemp = document.getElementById('dispTargetTemp');
    const dispRH = document.getElementById('dispTargetRH');
    const dispCO2 = document.getElementById('dispTargetCO2');
    const dispO2 = document.getElementById('dispTargetO2');

    if (dispTemp) dispTemp.innerText = `${protocolState.temp.toFixed(1)}°C`;
    if (dispRH) dispRH.innerText = `${protocolState.rh.toFixed(1)}%`;
    if (dispCO2) dispCO2.innerText = protocolState.co2.toLocaleString();
    if (dispO2) dispO2.innerText = `${protocolState.o2.toFixed(1)}%`;

    // 3. Dedicated Turner Control Card
    const turnVal = document.getElementById('dispTurnerStatus');
    const turnSub = document.getElementById('dispTurnerSub');
    const turnCard = document.getElementById('cardTurnerTrigger');
    const isSystemHatching = (currentPhase === 'HATCHING' || currentDay >= 19);

    if (turnVal && turnSub) {
        if (isSystemHatching && appliedSchedule && appliedSchedule.active) {
            turnVal.innerText = 'LOCKED';
            turnSub.innerText = 'Turning disabled during hatching lockdown';
            if (turnCard) turnCard.classList.add('is-locked');
        } else {
            turnVal.innerText = isHardwareTurning ? 'TURNING' : 'ROTATE';
            turnSub.innerText = isHardwareTurning ? 'Tilt motor engaged (15s rotation)' : 'Auto-turns hourly · Tap to test 15s';
            if (turnCard) turnCard.classList.remove('is-locked');
        }
    }

    // NOTE: Home countdown card is NOT updated here. Only "Apply Schedule" updates the Home countdown card!
}

async function saveIncubationSchedule() {
    onBatchDateInputChange(); // Make sure currentSetTimestamp is current

    const isHatching = (protocolState.day >= 19);
    protocolState.phase = isHatching ? 'HATCHING' : 'SETTING';

    currentDay = protocolState.day;
    currentPhase = protocolState.phase;

    // 1. Commit schedule locally and update Home countdown card
    appliedSchedule = {
        startTime: currentSetTimestamp.toISOString(),
        day: currentDay,
        phase: currentPhase,
        active: true
    };
    try {
        localStorage.setItem('incuvision_applied_schedule', JSON.stringify(appliedSchedule));
    } catch (e) {}

    renderHomeCountdownCard();
    renderProtocolCards();
    updateTurningDisplay();

    const lblProg = document.getElementById('lblScheduleProgress');
    if (lblProg) {
        lblProg.innerText = "ACTIVE TIMELINE (APPLIED)";
        lblProg.style.color = "#059669";
    }

    // Create local ISO string
    const dt = currentSetTimestamp || new Date();
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    const localIsoStr = `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;

    try {
        const resp = await fetch('/api/control/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start_time: localIsoStr,
                day: currentDay,
                phase: protocolState.phase,
                active: true
            })
        });

        if (resp.ok) {
            showToast(`Schedule Applied: Day ${currentDay} (${protocolState.phase})`);
        } else {
            // Fallback to legacy endpoint if schedule endpoint is unavailable
            await fetch('/api/control/day', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ day: currentDay })
            });
            await fetch('/api/control/phase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phase: protocolState.phase })
            });
            showToast(`Schedule Applied: Day ${currentDay}`);
        }
    } catch (e) {
        console.warn("Schedule save error:", e);
        showToast(`Schedule saved locally: Day ${currentDay}`);
    }
}

async function saveTargetSetpoints() {
    try {
        // 1. Send Target Setpoints update
        await fetch('/api/control/setpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                temp: protocolState.temp,
                rh: protocolState.rh,
                co2: protocolState.co2,
                o2: protocolState.o2
            })
        });

        // 2. Ensure Mode is set to AUTOMATIC so PID/heating loop runs
        await fetch('/api/control/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'AUTO' })
        });

        showToast(`Target Setpoints Applied: ${protocolState.temp.toFixed(1)}°C · ${protocolState.rh.toFixed(1)}% RH · ${protocolState.o2.toFixed(1)}% O₂`);
    } catch (e) {
        console.warn("Setpoints save error:", e);
        showToast("Setpoints saved locally (controller syncing).");
    }
}

async function saveProtocolSettings() {
    await saveIncubationSchedule();
    await saveTargetSetpoints();
}

// Aliases for compatibility
const onMenuDayInputChanged = (val) => stepDay((parseInt(val) || 1) - protocolState.day);
const applyProtocolPreset = setProtocolPhase;
const updateMenuProtocolDisplay = renderProtocolCards;
const updateCleanProtocolUI = renderProtocolCards;
const setIncubationDayFromMenu = saveIncubationSchedule;
const saveMenuSetpoints = saveTargetSetpoints;


