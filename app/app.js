// IncuVision Professional Dashboard Controller

let ws = null;
let currentDay = 1;
let eggData = [];
let isLocalFileMode = window.location.protocol === 'file:';

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initEggGrid();
    if (!isLocalFileMode) {
        initWebSocket();
        fetchInitialData();
    } else {
        // Standalone preview mode: Show clean status & load sample simulation
        setConnectionStatus(true, "Offline Preview Mode");
        loadSampleAuditData();
    }
});

// Theme Management
function initTheme() {
    const savedTheme = localStorage.getItem('incuvision_theme') || 'light';
    applyTheme(savedTheme);
}

function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextTheme = isDark ? 'light' : 'dark';
    applyTheme(nextTheme);
    localStorage.setItem('incuvision_theme', nextTheme);
}

function applyTheme(theme) {
    const themeText = document.getElementById('themeText');
    const themeIcon = document.getElementById('themeIcon');

    if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        if (themeText) themeText.innerText = 'Dark';
        if (themeIcon) {
            themeIcon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
        }
    } else {
        document.documentElement.removeAttribute('data-theme');
        if (themeText) themeText.innerText = 'Light';
        if (themeIcon) {
            themeIcon.innerHTML = `
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            `;
        }
    }
}

// Render 56-egg grid (7 rows x 8 cols)
function initEggGrid() {
    const grid = document.getElementById('eggGrid');
    if (!grid) return;
    grid.innerHTML = '';

    for (let i = 1; i <= 56; i++) {
        const slot = document.createElement('div');
        slot.className = 'egg-unit';
        slot.id = `egg-${i}`;
        slot.innerHTML = `
            <span class="egg-unit-index">#${i.toString().padStart(2, '0')}</span>
            <span class="egg-unit-label">---</span>
        `;
        slot.onclick = () => openEggModal(i);
        grid.appendChild(slot);
    }
}

// WebSocket Live Telemetry Link
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            setConnectionStatus(true, "System Connected");
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                updateDashboard(data);
            } catch (e) {
                console.error("WS Parse error:", e);
            }
        };

        ws.onclose = () => {
            setConnectionStatus(false, "Reconnecting...");
            setTimeout(initWebSocket, 3000);
        };
    } catch (e) {
        console.warn("WebSocket init fallback to polling:", e);
        setInterval(fetchInitialData, 3000);
    }
}

function setConnectionStatus(isOnline, text) {
    const badge = document.getElementById('connectionBadge');
    const label = document.getElementById('connectionText');
    if (!badge || !label) return;

    badge.className = `status-indicator ${isOnline ? 'online' : 'offline'}`;
    label.innerText = text;
}

async function fetchInitialData() {
    try {
        const res = await fetch('/api/telemetry');
        if (res.ok) {
            const data = await res.json();
            updateDashboard(data);
        }
    } catch (e) {
        // Backend not active yet
    }
}

// Update UI with telemetry data
function updateDashboard(data) {
    if (!data) return;

    currentDay = data.day || 1;
    document.getElementById('dayBadge').innerHTML = `Day ${currentDay.toString().padStart(2, '0')} <span class="total-days">/ 21</span>`;
    document.getElementById('daySelect').value = currentDay;

    const phase = data.phase || 'SETTING';
    document.getElementById('phaseBadge').innerText = `${phase} Phase`;

    // Highlight timeline milestone nodes
    updateTimelineMilestones(currentDay);

    const telem = data.telemetry || {};
    
    // Telemetry Figures
    if (telem.temp !== undefined) document.getElementById('valTemp').innerText = Number(telem.temp).toFixed(1);
    if (telem.rh !== undefined) document.getElementById('valRH').innerText = Number(telem.rh).toFixed(1);
    if (telem.co2 !== undefined) document.getElementById('valCO2').innerText = Number(telem.co2).toLocaleString();
    if (telem.o2 !== undefined) document.getElementById('valO2').innerText = Number(telem.o2).toFixed(1);

    // Actuators
    const act = telem.actuators || {};
    setChipState('actHeater', act.heater);
    setChipState('actExhaust', act.exhaust);
    setChipState('actCirculate', act.circulate !== undefined ? act.circulate : true);
    setChipState('actMotor', act.motor);
    setChipState('actCandling', act.candling);

    // Auditing Button State
    const btn = document.getElementById('btnTriggerCandling');
    if (data.is_auditing) {
        btn.disabled = true;
        btn.innerText = "YOLOv8 Scanning...";
    } else {
        btn.disabled = false;
        btn.innerText = "Run Candling Audit";
    }

    if (data.latest_audit) {
        renderAuditResults(data.latest_audit);
    }
}

function updateTimelineMilestones(day) {
    const d7 = document.getElementById('schedDay7');
    const d10 = document.getElementById('schedDay10');
    const d18 = document.getElementById('schedDay18');
    if (d7) d7.className = `milestone-node ${day >= 7 ? 'active' : ''}`;
    if (d10) d10.className = `milestone-node ${day >= 10 ? 'active' : ''}`;
    if (d18) d18.className = `milestone-node ${day >= 18 ? 'active' : ''}`;
}

function setChipState(id, isActive) {
    const el = document.getElementById(id);
    if (!el) return;
    if (isActive) {
        el.classList.add('active');
    } else {
        el.classList.remove('active');
    }
}

function renderAuditResults(audit) {
    if (!audit || !audit.matrix) return;

    const sumFertileEl = document.getElementById('sumFertile');
    const sumInfertileEl = document.getElementById('sumInfertile');
    const sumDeadEl = document.getElementById('sumDead');
    const sumRateEl = document.getElementById('sumRate');

    if (sumFertileEl) sumFertileEl.innerText = audit.fertile;
    if (sumInfertileEl) sumInfertileEl.innerText = audit.infertile;
    if (sumDeadEl) sumDeadEl.innerText = audit.early_dead || 0;
    if (sumRateEl) sumRateEl.innerText = `${audit.fertility_rate}%`;

    eggData = [];

    audit.matrix.forEach(row => {
        row.forEach(egg => {
            eggData.push(egg);
            const slot = document.getElementById(`egg-${egg.index}`);
            if (slot) {
                slot.className = `egg-unit ${egg.status}`;
                slot.innerHTML = `
                    <span class="egg-unit-index">#${egg.index.toString().padStart(2, '0')}</span>
                    <span class="egg-unit-label">${egg.status.replace('_', ' ')}</span>
                `;
            }
        });
    });

    // Update Annotated Camera Image View if available
    const imgScan = document.getElementById('imgCandlingScan');
    const placeholder = document.getElementById('candlingPlaceholder');
    const badge = document.getElementById('candlingPhotoBadge');
    const btnDownload = document.getElementById('btnDownloadScan');

    if (audit.annotated_image_url && imgScan) {
        imgScan.src = `${audit.annotated_image_url}?t=${Date.now()}`;
        imgScan.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
        if (btnDownload) btnDownload.href = audit.annotated_image_url;
        if (badge) {
            badge.innerText = `Day ${audit.day || currentDay} YOLOv8 Scan (${audit.fertility_rate}% Fertile)`;
        }
    }
}

// User Actions
async function triggerCandlingAudit() {
    const btn = document.getElementById('btnTriggerCandling');
    btn.disabled = true;
    btn.innerHTML = `Analyzing YOLOv8...`;

    if (isLocalFileMode) {
        // Simulate immediate preview audit
        setTimeout(() => {
            loadSampleAuditData();
            btn.disabled = false;
            btn.innerHTML = `
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                Run Candling Audit
            `;
        }, 500);
        return;
    }

    try {
        const res = await fetch('/api/candling/trigger', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success' && data.result) {
            renderAuditResults(data.result);
        }
    } catch (e) {
        alert('Could not trigger backend audit: ' + e);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            Run Candling Audit
        `;
    }
}

function loadSampleAuditData() {
    let fertile = 0, infertile = 0;
    const matrix = [];

    for (let r = 0; r < 7; r++) {
        const row = [];
        for (let c = 0; c < 8; c++) {
            const index = r * 8 + c + 1;
            const seed = (r * 13 + c * 19 + currentDay * 7) % 100;
            let status = "fertile";
            let conf = 0.88 + (seed % 10) * 0.01;

            if (seed >= 86) {
                status = "infertile";
                infertile++;
            } else {
                fertile++;
            }

            row.push({
                index: index,
                row: r + 1,
                col: c + 1,
                status: status,
                confidence: conf
            });
        }
        matrix.push(row);
    }

    const total = 56;
    const rate = ((fertile / total) * 100).toFixed(1);

    renderAuditResults({
        total_eggs: total,
        fertile: fertile,
        infertile: infertile,
        early_dead: 0,
        fertility_rate: rate,
        matrix: matrix
    });
}

async function updateIncubationDay() {
    const day = parseInt(document.getElementById('daySelect').value);
    currentDay = day;
    document.getElementById('dayBadge').innerHTML = `Day ${currentDay.toString().padStart(2, '0')} <span class="total-days">/ 21</span>`;
    updateTimelineMilestones(day);

    if (isLocalFileMode) {
        loadSampleAuditData();
        return;
    }

    try {
        await fetch('/api/control/day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day: day })
        });
    } catch (e) {
        alert('Error: ' + e);
    }
}

async function manualEggTurn() {
    if (isLocalFileMode) {
        setChipState('actMotor', true);
        setTimeout(() => setChipState('actMotor', false), 2000);
        return;
    }

    try {
        await fetch('/api/control/egg_turning', { method: 'POST' });
    } catch (e) {
        alert('Error: ' + e);
    }
}

async function saveSetpoints() {
    const temp = parseFloat(document.getElementById('inputTemp').value);
    const rh = parseFloat(document.getElementById('inputRH').value);
    const co2 = parseInt(document.getElementById('inputCO2').value);

    document.getElementById('targetTemp').innerText = `${temp.toFixed(1)} °C`;
    document.getElementById('targetRH').innerText = `${rh.toFixed(1)} %`;
    document.getElementById('targetCO2').innerText = `${co2.toLocaleString()} ppm`;

    if (isLocalFileMode) return;

    try {
        await fetch('/api/control/setpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temp, rh, co2 })
        });
    } catch (e) {
        alert('Error: ' + e);
    }
}

// Modal Details
function openEggModal(index) {
    const egg = eggData.find(e => e.index === index);
    const modal = document.getElementById('eggModal');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');

    title.innerText = `Egg Slot #${index.toString().padStart(2, '0')}`;
    
    if (egg) {
        const statusClass = egg.status === 'fertile' ? 'tag-success' : 'tag-warning';
        body.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; font-size:0.85rem;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--border-subtle); padding-bottom:8px;">
                    <span style="color:var(--text-secondary);">Grid Coordinate</span>
                    <span style="font-family:var(--font-digits); font-weight:600; color:var(--text-primary);">Row ${egg.row}, Col ${egg.col}</span>
                </div>
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--border-subtle); padding-bottom:8px;">
                    <span style="color:var(--text-secondary);">Viability Status</span>
                    <span class="metric-status-tag ${statusClass}" style="text-transform:uppercase;">${egg.status.replace('_', ' ')}</span>
                </div>
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--border-subtle); padding-bottom:8px;">
                    <span style="color:var(--text-secondary);">Confidence Score</span>
                    <span style="font-family:var(--font-digits); color:var(--brand-accent); font-weight:700;">${(egg.confidence * 100).toFixed(1)}%</span>
                </div>
                <p style="font-size:0.75rem; color:var(--text-muted); margin-top:4px; line-height:1.4;">
                    Embryo development verified using YOLOv8 candling vision analysis.
                </p>
            </div>
        `;
    } else {
        body.innerHTML = `<p style="color:var(--text-muted); font-size:0.8rem;">No scan data for this slot yet.</p>`;
    }

    modal.classList.add('open');
}

function closeModal(e) {
    document.getElementById('eggModal').classList.remove('open');
}

// Vision Tab Switcher (Matrix vs AI Candling Photo vs Live Camera)
function switchVisionView(mode) {
    const tabGrid = document.getElementById('tabGrid');
    const tabCandlingPhoto = document.getElementById('tabCandlingPhoto');
    const tabLiveCam = document.getElementById('tabLiveCam');

    const viewGrid = document.getElementById('viewGrid');
    const viewCandlingPhoto = document.getElementById('viewCandlingPhoto');
    const viewLiveCam = document.getElementById('viewLiveCam');

    const heading = document.getElementById('panelHeading');
    const subheading = document.getElementById('panelSubheading');

    [tabGrid, tabCandlingPhoto, tabLiveCam].forEach(t => t && t.classList.remove('active'));
    [viewGrid, viewCandlingPhoto, viewLiveCam].forEach(v => v && (v.style.display = 'none'));

    if (mode === 'grid') {
        if (tabGrid) tabGrid.classList.add('active');
        if (viewGrid) viewGrid.style.display = 'block';
        if (heading) heading.innerText = '56-Egg Candling Vision Matrix';
        if (subheading) subheading.innerText = '7 × 8 Grid Layout • YOLOv8 Multi-Egg Fertility & Vascular Analysis';
    } else if (mode === 'candling') {
        if (tabCandlingPhoto) tabCandlingPhoto.classList.add('active');
        if (viewCandlingPhoto) viewCandlingPhoto.style.display = 'block';
        if (heading) heading.innerText = 'AI Candling High-Res Photo';
        if (subheading) subheading.innerText = 'YOLOv8 Full-Frame Detection with Viability Bounding Boxes & Confidence Labels';
    } else if (mode === 'live') {
        if (tabLiveCam) tabLiveCam.classList.add('active');
        if (viewLiveCam) viewLiveCam.style.display = 'block';
        if (heading) heading.innerText = 'Live Incubator Chamber Feed';
        if (subheading) subheading.innerText = 'Real-Time Camera Monitoring of Egg Tray, Turning Mechanism & Interior Environment';
        refreshLiveStream();
    }
}

function refreshLiveStream() {
    const img = document.getElementById('imgLiveStream');
    if (img) {
        img.src = `/api/camera/stream?t=${Date.now()}`;
    }
}

let candlingLightState = false;
async function toggleCandlingLight() {
    candlingLightState = !candlingLightState;
    setChipState('actCandling', candlingLightState);
    try {
        await fetch('/api/control/candling_light', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: candlingLightState })
        });
    } catch (e) {
        console.warn("Could not toggle candling light via API:", e);
    }
}
