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
    renderProtocolCards();
    initPushNotifications();
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
    }

    const previousPhase = currentPhase;
    if (data.phase) {
        currentPhase = data.phase;
    }
    if (currentDay >= 19) {
        currentPhase = 'HATCHING';
    }

    if (previousPhase === 'SETTING' && currentPhase === 'HATCHING') {
        sendPushNotification({
            title: "🐣 Lockdown Transition (Day 19)",
            body: "Incubator entered Hatching phase! Targets updated to 36.9°C & 70% RH. Egg turner locked.",
            tag: "phase-transition-lockdown",
            soundType: "chime",
            cooldownSeconds: 3600
        });
    }

    // Update Home & Protocol Phase Indicators
    const homePhaseSub = document.getElementById('homePhaseSub');
    if (homePhaseSub) {
        const isHatching = (currentPhase === 'HATCHING' || currentDay >= 19);
        homePhaseSub.innerText = isHatching ? `Lockdown Phase (Day ${currentDay} of 21)` : `Setting Phase (Day ${currentDay} of 21)`;
        if (isHatching) homePhaseSub.classList.add('hatching');
        else homePhaseSub.classList.remove('hatching');
    }

    if (!protocolStateInitialized) {
        protocolState.day = currentDay;
        protocolState.phase = currentPhase;
        protocolState.temp = (currentPhase === 'HATCHING' || currentDay >= 19) ? 36.9 : 37.5;
        protocolState.rh = (currentPhase === 'HATCHING' || currentDay >= 19) ? 70.0 : 58.0;
        protocolState.co2 = (currentPhase === 'HATCHING' || currentDay >= 19) ? 7500 : 5000;
        protocolStateInitialized = true;
        renderProtocolCards();
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

                if (telem.actuators.manual !== undefined) {
                    // Do not let stale background telemetry revert user toggle within 4 seconds
                    if (Date.now() - lastUserModeSwitchTime > 4000) {
                        isManualMode = Boolean(telem.actuators.manual);
                        setManualModeUI(isManualMode);
                    }
                }
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

    const isHatching = (currentPhase === 'HATCHING' || currentDay >= 19);

    let hasAlert = false;
    let alerts = [];

    // Phase-specific target evaluations
    if (isHatching) {
        // Hatching Phase Targets: Temp ~36.9°C, RH ~70%, CO2 <= 7500ppm
        if (temp < 36.2) {
            hasAlert = true;
            alerts.push({ msg: `TEMPERATURE IS ${temp.toFixed(1)}°C, BELOW HATCHING TARGET (36.9°C). HEATER ENGAGED.` });
        } else if (temp > 37.6) {
            hasAlert = true;
            alerts.push({ msg: `TEMPERATURE IS ${temp.toFixed(1)}°C, ABOVE HATCHING TARGET (36.9°C). COOLING.` });
        }

        if (rh < 62.0) {
            hasAlert = true;
            alerts.push({ msg: `HUMIDITY IS ${rh.toFixed(1)}%, BELOW HATCHING TARGET (70%). HUMIDIFIER ENGAGED.` });
        } else if (rh > 80.0) {
            hasAlert = true;
            alerts.push({ msg: `HUMIDITY IS ${rh.toFixed(1)}%, ABOVE HATCHING TARGET (70%). EXHAUST VENTING.` });
        }

        if (currentTelemetry.co2 && currentTelemetry.co2 > 7500) {
            hasAlert = true;
            alerts.push({ msg: `CO₂ LEVEL IS ${currentTelemetry.co2} PPM, EXCEEDS HATCHING LIMIT (7,500 PPM). EXHAUST ON.` });
        }
    } else {
        // Setting Phase Targets: Temp ~37.5°C, RH ~58%, CO2 <= 5000ppm
        if (temp < 36.8) {
            hasAlert = true;
            alerts.push({ msg: `TEMPERATURE IS ${temp.toFixed(1)}°C, BELOW SETTING TARGET (37.5°C). HEATER ENGAGED.` });
        } else if (temp > 38.2) {
            hasAlert = true;
            alerts.push({ msg: `TEMPERATURE IS ${temp.toFixed(1)}°C, ABOVE SETTING TARGET (37.5°C). VENTING.` });
        }

        if (rh < 50.0) {
            hasAlert = true;
            alerts.push({ msg: `HUMIDITY IS ${rh.toFixed(1)}%, BELOW SETTING TARGET (58%). HUMIDIFIER ENGAGED.` });
        } else if (rh > 65.0) {
            hasAlert = true;
            alerts.push({ msg: `HUMIDITY IS ${rh.toFixed(1)}%, ABOVE SETTING TARGET (58%). EXHAUST VENTING.` });
        }

        if (currentTelemetry.co2 && currentTelemetry.co2 > 5000) {
            hasAlert = true;
            alerts.push({ msg: `CO₂ LEVEL IS ${currentTelemetry.co2} PPM, EXCEEDS SETTING LIMIT (5,000 PPM). EXHAUST ON.` });
        }
    }

    if (o2 > 0 && o2 < 20.0) {
        hasAlert = true;
        alerts.push({ msg: `OXYGEN LEVEL IS ${o2.toFixed(1)}%, BELOW 20.0%. EXHAUST FAN ENGAGED.` });
    }

    if (bellDot) {
        bellDot.style.display = hasAlert ? 'block' : 'none';
    }

    const alertsListEl = document.getElementById('alertsList');
    if (alertsListEl && alerts.length > 0) {
        alertsListEl.innerHTML = `
            <div class="alert-time-group">
                <span class="time-header">${timeStr} · ${isHatching ? 'HATCHING PHASE (LOCKDOWN)' : 'SETTING PHASE'}</span>
                ${alerts.map(a => `
                    <div class="alert-box">
                        <span class="alert-warn-badge">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#D97706" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                <line x1="12" y1="9" x2="12" y2="13"/>
                                <line x1="12" y1="17" x2="12.01" y2="17"/>
                            </svg>
                        </span>
                        <p class="alert-msg">${a.msg}</p>
                    </div>
                `).join('')}
            </div>
            <div class="alert-time-group" style="opacity:0.6;">
                <span class="time-header">OPERATING STATUS</span>
                <div class="alert-box">
                    <span class="alert-warn-badge">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#059669" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5"/>
                        </svg>
                    </span>
                    <p class="alert-msg">${isHatching ? 'SYSTEM OPERATING UNDER HATCHING LOCKDOWN SETPOINTS (36.9°C / 70% RH / NO TURN).' : 'SYSTEM OPERATING UNDER SETTING PHASE SETPOINTS (37.5°C / 58% RH / 1-HR ROTATE).'}</p>
                </div>
            </div>
        `;
    }

    // Trigger push notification if out-of-bounds alerts are active
    if (alerts.length > 0) {
        sendPushNotification({
            title: isHatching ? "⚠️ Hatching Alert (Lockdown)" : "⚠️ Incubation Alert",
            body: alerts[0].msg,
            tag: "alert-" + (isHatching ? "hatch" : "set"),
            soundType: "alert",
            cooldownSeconds: 180
        });
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

    if (switchToAudit && audit && !audit.error) {
        sendPushNotification({
            title: `🔬 Candling Audit (Day ${audit.day || currentDay})`,
            body: `Fertility: ${rate.toFixed(1)}% (${fertileCount}/${total} Fertile Eggs).`,
            tag: `audit-result-day-${audit.day || currentDay}`,
            soundType: "chime",
            cooldownSeconds: 60
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
// PUSH & SYSTEM NOTIFICATIONS (WEB AUDIO CHIME + SERVICE WORKER)
// =============================================================================
let swRegistration = null;
let pushEnabled = false;
const lastPushTimestamps = {};

function playNotificationSound(type = 'chime') {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'alert') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(587.33, ctx.currentTime);
            osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } else {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, ctx.currentTime);
            osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.10);
            osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.20);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.55);
            osc.start();
            osc.stop(ctx.currentTime + 0.55);
        }
    } catch (e) {
        // AudioContext can be suspended before user interaction
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

    if (!('Notification' in window)) {
        if (title) title.innerText = 'Push Unavailable';
        if (sub) sub.innerText = 'Browser does not support notifications';
        if (btnToggle) btnToggle.style.display = 'none';
        if (btnTest) btnTest.style.display = 'none';
        return;
    }

    const perm = Notification.permission;
    if (perm === 'granted') {
        pushEnabled = true;
        if (badge) badge.classList.add('active');
        if (title) title.innerText = 'Push Active';
        if (sub) sub.innerText = 'Alerts enabled on lockscreen & phone';
        if (btnToggle) {
            btnToggle.innerText = 'Active ✓';
            btnToggle.classList.add('active');
        }
        if (btnTest) btnTest.style.display = 'inline-block';
    } else if (perm === 'denied') {
        pushEnabled = false;
        if (badge) badge.classList.remove('active');
        if (title) title.innerText = 'Push Blocked';
        if (sub) sub.innerText = 'Notifications blocked in browser settings';
        if (btnToggle) {
            btnToggle.innerText = 'Blocked';
            btnToggle.classList.remove('active');
        }
        if (btnTest) btnTest.style.display = 'none';
    } else {
        pushEnabled = false;
        if (badge) badge.classList.remove('active');
        if (title) title.innerText = 'Push Notifications';
        if (sub) sub.innerText = 'Tap enable to receive phone alerts';
        if (btnToggle) {
            btnToggle.innerText = 'Enable';
            btnToggle.classList.remove('active');
        }
        if (btnTest) btnTest.style.display = 'inline-block';
    }
}

async function togglePushNotifications() {
    if (!('Notification' in window)) {
        showToast("Your browser does not support Web Notifications.", true);
        return;
    }

    if (Notification.permission === 'granted') {
        showToast("Push notifications are already active!");
        testPushNotification();
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
        } else if (permission === 'denied') {
            showToast("Notification permission was denied in your browser settings.", true);
        }
    } catch (e) {
        console.warn("[PUSH] Request error:", e);
        showToast("Could not request notification permission.", true);
    }
}

function sendPushNotification({ title, body, tag = 'incuvision-alert', soundType = 'alert', cooldownSeconds = 180 }) {
    const now = Date.now();
    if (lastPushTimestamps[tag] && (now - lastPushTimestamps[tag]) < (cooldownSeconds * 1000)) {
        return;
    }
    lastPushTimestamps[tag] = now;

    // 1. Play audio chime
    playNotificationSound(soundType);

    // 2. In-App toast
    showToast(`🔔 ${title}: ${body}`);

    // 3. Dispatch native system push notification
    if ('Notification' in window && Notification.permission === 'granted') {
        const options = {
            body: body,
            icon: '/dashboard/icons/logo.png',
            badge: '/dashboard/icons/logo.png',
            tag: tag,
            renotify: true,
            vibrate: [200, 100, 200],
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
    playNotificationSound('chime');
    sendPushNotification({
        title: "IncuVision Test Alert",
        body: `Day ${currentDay} (${currentPhase}): Incubator system operational.`,
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
    day: 1,
    phase: 'SETTING',
    temp: 37.5,
    rh: 58.0,
    co2: 5000
};

function setProtocolPhase(phase) {
    const isHatching = (phase === 'HATCHING');
    protocolState.phase = phase;

    if (isHatching && protocolState.day < 19) {
        protocolState.day = 19;
    } else if (!isHatching && protocolState.day >= 19) {
        protocolState.day = 1;
    }

    protocolState.temp = isHatching ? 36.9 : 37.5;
    protocolState.rh = isHatching ? 70.0 : 58.0;
    protocolState.co2 = isHatching ? 7500 : 5000;

    renderProtocolCards();
    showToast(`Loaded ${isHatching ? 'Hatching (36.9°C, 70% RH)' : 'Setting (37.5°C, 58% RH)'} targets.`);
}

function stepDay(delta) {
    protocolState.day = Math.max(1, Math.min(21, protocolState.day + delta));
    const isHatching = (protocolState.day >= 19);
    protocolState.phase = isHatching ? 'HATCHING' : 'SETTING';
    
    // Automatically switch default targets when crossing Day 18
    if (isHatching) {
        protocolState.temp = 36.9;
        protocolState.rh = 70.0;
        protocolState.co2 = 7500;
    } else {
        protocolState.temp = 37.5;
        protocolState.rh = 58.0;
        protocolState.co2 = 5000;
    }

    renderProtocolCards();
}

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

    // 2. Target Metric Card Values
    const dispTemp = document.getElementById('dispTargetTemp');
    const dispRH = document.getElementById('dispTargetRH');
    const dispCO2 = document.getElementById('dispTargetCO2');

    if (dispTemp) dispTemp.innerText = `${protocolState.temp.toFixed(1)}°C`;
    if (dispRH) dispRH.innerText = `${protocolState.rh.toFixed(1)}%`;
    if (dispCO2) dispCO2.innerText = protocolState.co2.toLocaleString();

    // 3. Turner Control Card
    const turnVal = document.getElementById('dispTurnerStatus');
    const turnSub = document.getElementById('dispTurnerSub');
    const turnCard = document.getElementById('cardTurnerTrigger');

    if (turnVal && turnSub) {
        if (isHatching) {
            turnVal.innerText = 'LOCKED';
            turnVal.classList.add('locked');
            turnSub.innerText = 'OFF FOR HATCHING';
            if (turnCard) turnCard.style.opacity = '0.7';
        } else {
            turnVal.innerText = isHardwareTurning ? 'TURNING' : 'ROTATE';
            turnVal.classList.remove('locked');
            turnSub.innerText = 'EGG TURNER (15s)';
            if (turnCard) turnCard.style.opacity = '1';
        }
    }

    // 4. Sync Home Phase subtitle
    const homePhaseSub = document.getElementById('homePhaseSub');
    if (homePhaseSub) {
        homePhaseSub.innerText = isHatching ? `Hatching Phase (Day ${protocolState.day} of 21)` : `Setting Phase (Day ${protocolState.day} of 21)`;
        if (isHatching) homePhaseSub.classList.add('hatching');
        else homePhaseSub.classList.remove('hatching');
    }
}

async function saveProtocolSettings() {
    const isHatching = (protocolState.day >= 19);
    protocolState.phase = isHatching ? 'HATCHING' : 'SETTING';

    currentDay = protocolState.day;
    currentPhase = protocolState.phase;

    const daysLeft = Math.max(0, 21 - currentDay);
    const dayEl = document.getElementById('homeDaysLeft');
    if (dayEl) dayEl.innerText = `${daysLeft} Days Left`;

    renderProtocolCards();
    updateTurningDisplay();

    try {
        // 1. Send Day update to coordinator & ESP32
        await fetch('/api/control/day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day: currentDay })
        });

        // 2. Send Target Setpoints update
        await fetch('/api/control/setpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                temp: protocolState.temp,
                rh: protocolState.rh,
                co2: protocolState.co2
            })
        });

        // 3. Send Phase update
        await fetch('/api/control/phase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phase: protocolState.phase })
        });

        // 4. Ensure Mode is set to AUTOMATIC so heating loop runs
        await fetch('/api/control/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'AUTO' })
        });

        showToast(`Protocol Saved! Day ${currentDay} (${isHatching ? 'Hatching, 36.9°C, 70% RH' : 'Setting, 37.5°C, 58% RH'})`);
    } catch (e) {
        showToast("Settings saved locally (controller syncing).");
    }
}

// Aliases for compatibility
const onMenuDayInputChanged = (val) => stepDay((parseInt(val) || 1) - protocolState.day);
const applyProtocolPreset = setProtocolPhase;
const updateMenuProtocolDisplay = renderProtocolCards;
const updateCleanProtocolUI = renderProtocolCards;
const setIncubationDayFromMenu = saveProtocolSettings;
const saveMenuSetpoints = saveProtocolSettings;


