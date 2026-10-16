// IncuVision Mobile-First Dashboard Controller
// Connected to Raspberry Pi 5 Master Vision & Coordinator Engine

let ws = null;
let currentDay = 1;
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
let turningSecondsLeft = 30 * 60 + 9; // 30:09 countdown default
let candlingLightState = false;

document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    fetchInitialData();
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
        if (menuDay) menuDay.value = currentDay;
    }

    const telem = data.telemetry;
    if (telem) {
        currentTelemetry = telem;

        // 1. Temperature
        const temp = parseFloat(telem.temp || 37.5);
        const valTempEl = document.getElementById('valTemp');
        const cardTemp = document.getElementById('cardTemp');
        const pillTemp = document.getElementById('analyticsTempPill');
        
        if (valTempEl) valTempEl.innerText = `${temp.toFixed(1)}°C`;
        if (pillTemp) pillTemp.innerText = `${temp.toFixed(1)}°`;

        // Highlight Green if in safe range (36.8 - 38.0°C)
        if (cardTemp) {
            if (temp >= 36.8 && temp <= 38.0) {
                cardTemp.classList.add('active-green');
            } else {
                cardTemp.classList.remove('active-green');
            }
        }

        // 2. Humidity
        const rh = parseFloat(telem.rh || 58.0);
        const valRHEl = document.getElementById('valRH');
        if (valRHEl) valRHEl.innerText = `${rh.toFixed(1)}%`;

        // 3. CO2
        const co2 = parseInt(telem.co2 || 3200);
        const valCO2El = document.getElementById('valCO2');
        if (valCO2El) valCO2El.innerText = co2.toLocaleString();

        // 4. Oxygen
        const o2 = parseFloat(telem.o2 || 20.9);
        const valO2El = document.getElementById('valO2');
        if (valO2El) valO2El.innerText = `${o2.toFixed(1)}%`;

        // 5. 2x2 Actuator Status Pills sync (Heater, Turner, Exhaust, LED Light)
        if (telem.actuators) {
            updatePillState('pillHeater', !!telem.actuators.heater);
            updatePillState('pillTurner', !!telem.actuators.motor);
            updatePillState('pillExhaust', !!telem.actuators.exhaust);
            updatePillState('pillLed', !!telem.actuators.candling);
        }

        // Generate dynamic smart alerts based on thresholds
        evaluateSmartAlerts(temp, rh, o2, telem.actuators);
    }

    // Latest Candling Audit Data
    if (data.latest_audit) {
        renderAuditScores(data.latest_audit);
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

async function manualEggTurn() {
    const turningEl = document.getElementById('turningCountdown');
    if (turningEl) turningEl.innerText = "TURNING...";
    turningSecondsLeft = 3600; // Reset to 60 mins

    try {
        await fetch('/api/control/egg_turning', { method: 'POST' });
    } catch (e) {
        console.warn("Egg turn error:", e);
    }
}

function startTurningCountdown() {
    setInterval(() => {
        if (turningSecondsLeft > 0) {
            turningSecondsLeft--;
            const mins = Math.floor(turningSecondsLeft / 60).toString().padStart(2, '0');
            const secs = (turningSecondsLeft % 60).toString().padStart(2, '0');
            const el = document.getElementById('turningCountdown');
            if (el && el.innerText !== "TURNING...") {
                el.innerText = `${mins}:${secs}`;
            }
        } else {
            turningSecondsLeft = 3600;
        }
    }, 1000);
}

// =============================================================================
// TEMPERATURE WAVE CHART CANVAS
// =============================================================================
function drawTempWaveChart() {
    const canvas = document.getElementById('tempWaveChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

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

    // Generate smooth wave curve matching mockup
    // Y-axis spans 30° to 38°
    const wavePoints = [
        { x: 0,   y: 80 },
        { x: 25,  y: 105 },
        { x: 45,  y: 92 },
        { x: 68,  y: 120 },
        { x: 90,  y: 135 },
        { x: 110, y: 100 },
        { x: 135, y: 145 },
        { x: 160, y: 108 },
        { x: 180, y: 115 },
        { x: 205, y: 95 },
        { x: 230, y: 118 },
        { x: 255, y: 88 },
        { x: 280, y: 112 },
        { x: 305, y: 92 },
        { x: 320, y: 65 },
        { x: 340, y: 100 }
    ];

    // Smooth bezier curve
    ctx.beginPath();
    ctx.moveTo(wavePoints[0].x, wavePoints[0].y);
    for (let i = 0; i < wavePoints.length - 1; i++) {
        const xc = (wavePoints[i].x + wavePoints[i + 1].x) / 2;
        const yc = (wavePoints[i].y + wavePoints[i + 1].y) / 2;
        ctx.quadraticCurveTo(wavePoints[i].x, wavePoints[i].y, xc, yc);
    }
    ctx.lineTo(wavePoints[wavePoints.length - 1].x, wavePoints[wavePoints.length - 1].y);
    ctx.strokeStyle = '#E09930';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Fill soft gradient under curve
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(250, 217, 128, 0.45)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    ctx.fillStyle = grad;
    ctx.fill();
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
function refreshLiveStream() {
    const img = document.getElementById('fertilityCameraStream');
    if (img) {
        img.src = `/api/camera/stream?t=${Date.now()}`;
        img.style.display = 'block';
    }
    const overlay = document.getElementById('camOverlayIcon');
    if (overlay) overlay.style.display = 'none';
}

function onCameraStreamError() {
    // If live stream is idle, show camera center icon
    const overlay = document.getElementById('camOverlayIcon');
    if (overlay) overlay.style.display = 'block';
}

async function toggleCandlingLight() {
    candlingLightState = !candlingLightState;
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
    if (btnLabel) btnLabel.innerText = "Running YOLOv8 Audit...";

    try {
        const res = await fetch('/api/candling/trigger', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success' && data.result) {
            renderAuditScores(data.result);
        }
    } catch (e) {
        alert("Candling audit error: " + e);
    } finally {
        if (btnLabel) btnLabel.innerText = "Run AI Candling Audit";
    }
}

function renderAuditScores(audit) {
    if (!audit) return;

    const fertileScore = document.getElementById('scoreFertile');
    const infertileScore = document.getElementById('scoreInfertile');

    if (fertileScore) fertileScore.innerText = `${audit.fertility_rate || 0}%`;
    if (infertileScore) {
        const infertileRate = (100 - (audit.fertility_rate || 0)).toFixed(1);
        infertileScore.innerText = `${infertileRate}%`;
    }

    // Switch camera viewport to the annotated scan photo
    if (audit.annotated_image_url) {
        const cam = document.getElementById('fertilityCameraStream');
        if (cam) {
            cam.src = `${audit.annotated_image_url}?t=${Date.now()}`;
        }
    }

    // Update 56-Egg Matrix
    if (audit.matrix) {
        eggMatrixData = [];
        audit.matrix.forEach(row => {
            row.forEach(egg => {
                eggMatrixData.push(egg);
                const slot = document.getElementById(`eggSlot-${egg.index}`);
                if (slot) {
                    slot.className = `egg-slot-pill ${egg.status}`;
                }
            });
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
    
    if (egg) {
        const statusColor = egg.status === 'fertile' ? '#15803D' : '#B91C1C';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #E5E7EB; padding-bottom:8px;">
                    <span style="color:#6B7280;">Tray Coordinate</span>
                    <span style="font-weight:700;">Row ${egg.row}, Col ${egg.col}</span>
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
        body.innerHTML = `<p style="color:#6B7280; font-size:0.85rem;">No AI candling scan recorded for this slot yet. Run Candling Audit to scan.</p>`;
    }

    modal.classList.add('open');
}

function closeModal(e) {
    const modal = document.getElementById('eggModal');
    if (modal) modal.classList.remove('open');
}

// =============================================================================
// MENU SETPOINTS & PROTOCOL
// =============================================================================
async function setIncubationDayFromMenu() {
    const day = parseInt(document.getElementById('menuDayInput').value);
    currentDay = day;
    const daysLeft = Math.max(0, 21 - currentDay);
    document.getElementById('homeDaysLeft').innerText = `${daysLeft} Days Left`;

    try {
        await fetch('/api/control/day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day: day })
        });
        alert(`Day set to ${day}. Protocol updated.`);
    } catch (e) {
        alert("Error saving day: " + e);
    }
}

async function saveMenuSetpoints() {
    const temp = parseFloat(document.getElementById('menuTempInput').value);
    const rh = parseFloat(document.getElementById('menuRHInput').value);
    const co2 = parseInt(document.getElementById('menuCO2Input').value);

    try {
        await fetch('/api/control/setpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temp, rh, co2 })
        });
        alert("Setpoints sent to ESP32 incubator controller.");
    } catch (e) {
        alert("Error updating setpoints: " + e);
    }
}
