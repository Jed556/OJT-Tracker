let currentCalDate = new Date(2026, 2, 1);
let ojtData = new Map();
let finalEndDateStr = null;
let events = [];
let themeTransitionTimeout = null;
let isHolidaySyncing = false;

const STORAGE_KEYS = {
    theme: "ojt-theme",
    primaryColor: "ojt-primary-color",
    events: "ojt-events",
    settings: "ojt-settings"
};

const DEFAULT_PRIMARY_COLOR = "#61dafb";
const SETTINGS_FIELD_IDS = ["targetHours", "startDate", "h0", "h1", "h2", "h3", "h4", "h5", "h6", "holidayNameLocalToggle"];

function pad(n) {
    return n.toString().padStart(2, "0");
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getStoredValue(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function setStoredValue(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Ignore storage errors (e.g. private mode or storage blocked).
    }
}

function normalizeHex(hex) {
    if (typeof hex !== "string") {
        return null;
    }

    const normalized = hex.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return null;
    }

    return `#${normalized.toLowerCase()}`;
}

function hexToRgb(hex) {
    const safeHex = normalizeHex(hex);
    if (!safeHex) {
        return null;
    }

    const intVal = Number.parseInt(safeHex.slice(1), 16);
    return {
        r: (intVal >> 16) & 255,
        g: (intVal >> 8) & 255,
        b: intVal & 255
    };
}

function adjustColor(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) {
        return DEFAULT_PRIMARY_COLOR;
    }

    const r = clamp(rgb.r + amount, 0, 255);
    const g = clamp(rgb.g + amount, 0, 255);
    const b = clamp(rgb.b + amount, 0, 255);
    return `#${[r, g, b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
}

function runThemeTransition() {
    document.documentElement.classList.add("ui-theme-transition");

    if (themeTransitionTimeout) {
        clearTimeout(themeTransitionTimeout);
    }

    themeTransitionTimeout = window.setTimeout(() => {
        document.documentElement.classList.remove("ui-theme-transition");
    }, 260);
}

function applyTheme(themeName, animate = true) {
    if (animate) {
        runThemeTransition();
    }

    const isLight = themeName === "light";
    document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");

    const themeToggleButton = document.getElementById("themeToggleBtn");
    if (themeToggleButton) {
        themeToggleButton.setAttribute("aria-pressed", isLight ? "false" : "true");
    }

    setStoredValue(STORAGE_KEYS.theme, isLight ? "light" : "dark");
}

function applyPrimaryColor(colorValue, animate = true) {
    if (animate) {
        runThemeTransition();
    }

    const safeColor = normalizeHex(colorValue) || DEFAULT_PRIMARY_COLOR;
    const root = document.documentElement;
    const rgb = hexToRgb(safeColor);

    root.style.setProperty("--accent", safeColor);
    root.style.setProperty("--accent-hover", adjustColor(safeColor, -30));

    if (rgb) {
        root.style.setProperty("--accent-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
    }

    const colorInput = document.getElementById("primaryColor");
    if (colorInput && colorInput.value.toLowerCase() !== safeColor) {
        colorInput.value = safeColor;
    }

    setStoredValue(STORAGE_KEYS.primaryColor, safeColor);
}

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
}

function buildPHEventId(prefix, start, name) {
    return `${prefix}-${start}-${slugify(name) || "holiday"}`;
}

function sortEvents(list) {
    return list.sort((a, b) => {
        const startDiff = a.start.localeCompare(b.start);
        if (startDiff !== 0) {
            return startDiff;
        }

        return a.name.localeCompare(b.name);
    });
}

function isPHEvent(eventItem) {
    return eventItem.source === "ph-api" || eventItem.source === "ph-default";
}

function holidaySignature(eventItem) {
    const canonicalName = eventItem.enName || eventItem.name || "";
    return `${eventItem.start}|${eventItem.end}|${canonicalName}`;
}

function useLocalHolidayNames() {
    const toggle = document.getElementById("holidayNameLocalToggle");
    return Boolean(toggle && toggle.checked);
}

function getEventDisplayName(eventItem) {
    if (useLocalHolidayNames()) {
        return eventItem.localName || eventItem.enName || eventItem.name;
    }

    return eventItem.enName || eventItem.name || eventItem.localName;
}

function normalizeStoredEvent(rawEvent, index) {
    if (!rawEvent || typeof rawEvent !== "object") {
        return null;
    }

    const start = typeof rawEvent.start === "string" ? rawEvent.start : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        return null;
    }

    const endCandidate = typeof rawEvent.end === "string" ? rawEvent.end : start;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(endCandidate) ? endCandidate : start;
    const name = typeof rawEvent.name === "string" && rawEvent.name.trim() ? rawEvent.name.trim() : "Unnamed Event";
    const enName = typeof rawEvent.enName === "string" && rawEvent.enName.trim() ? rawEvent.enName.trim() : name;
    const localName = typeof rawEvent.localName === "string" && rawEvent.localName.trim() ? rawEvent.localName.trim() : enName;

    let source = typeof rawEvent.source === "string" ? rawEvent.source : "";
    if (!source) {
        const rawId = String(rawEvent.id || "");
        source = rawId.startsWith("h") || rawId.startsWith("ph-") ? "ph-api" : "user";
    }

    const id = rawEvent.id
        ? String(rawEvent.id)
        : source === "ph-api" || source === "ph-default"
            ? buildPHEventId("ph-api", start, enName)
            : `user-${Date.now()}-${index}`;

    return {
        id,
        start,
        end,
        name,
        enName,
        localName,
        active: rawEvent.active !== false,
        source: source === "ph-default" ? "ph-api" : source
    };
}

function normalizeStoredEvents(rawEvents) {
    if (!Array.isArray(rawEvents)) {
        return [];
    }

    const byId = new Map();
    rawEvents.forEach((rawEvent, index) => {
        const normalized = normalizeStoredEvent(rawEvent, index);
        if (normalized) {
            byId.set(normalized.id, normalized);
        }
    });

    return Array.from(byId.values());
}

function saveEventsToStorage() {
    setStoredValue(STORAGE_KEYS.events, JSON.stringify(events));
}

function loadEventsFromStorage() {
    const raw = getStoredValue(STORAGE_KEYS.events);
    if (!raw) {
        return [];
    }

    try {
        return normalizeStoredEvents(JSON.parse(raw));
    } catch {
        return [];
    }
}

function initializeEvents() {
    const storedEvents = loadEventsFromStorage();
    events = sortEvents(storedEvents);
    if (storedEvents.length > 0) {
        saveEventsToStorage();
    }
}

function saveSettingsToStorage() {
    const settings = {};
    SETTINGS_FIELD_IDS.forEach((id) => {
        const input = document.getElementById(id);
        if (input) {
            settings[id] = input.type === "checkbox" ? input.checked : input.value;
        }
    });

    setStoredValue(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function restoreSettingsFromStorage() {
    const raw = getStoredValue(STORAGE_KEYS.settings);
    if (!raw) {
        const holidayNameToggle = document.getElementById("holidayNameLocalToggle");
        if (holidayNameToggle) {
            holidayNameToggle.checked = false;
        }
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return;
    }

    SETTINGS_FIELD_IDS.forEach((id) => {
        const input = document.getElementById(id);
        if (!input || parsed[id] === undefined) {
            return;
        }

        if (input.type === "checkbox") {
            input.checked = parsed[id] === true || parsed[id] === "true";
        } else if (typeof parsed[id] === "string") {
            input.value = parsed[id];
        }
    });
}

function resetAppData() {
    const resetModal = document.getElementById("resetAppModal");
    if (resetModal && typeof resetModal.showModal === "function") {
        resetModal.showModal();
        return;
    }

    // Fallback when <dialog> is unsupported.
    const shouldReset = window.confirm("Reset all saved app data and return to default settings?");
    if (!shouldReset) {
        return;
    }

    confirmResetAppData();
}

function closeResetAppDialog() {
    const resetModal = document.getElementById("resetAppModal");
    if (resetModal && resetModal.open) {
        resetModal.close();
    }
}

function confirmResetAppData() {
    closeResetAppDialog();

    Object.values(STORAGE_KEYS).forEach((key) => {
        try {
            localStorage.removeItem(key);
        } catch {
            // Ignore storage errors.
        }
    });

    window.location.reload();
}

function mergePHEvents(phEvents, keepExistingActive = true) {
    const manualEvents = events.filter((eventItem) => !isPHEvent(eventItem));
    const existingPHEvents = events.filter((eventItem) => isPHEvent(eventItem));
    const existingActiveMap = new Map(existingPHEvents.map((eventItem) => [holidaySignature(eventItem), eventItem.active]));

    const deduped = new Map();
    phEvents.forEach((eventItem) => {
        deduped.set(holidaySignature(eventItem), eventItem);
    });

    const normalizedPH = Array.from(deduped.values()).map((eventItem) => {
        const signature = holidaySignature(eventItem);
        return {
            ...eventItem,
            active: keepExistingActive && existingActiveMap.has(signature)
                ? existingActiveMap.get(signature)
                : eventItem.active !== false
        };
    });

    events = sortEvents([...manualEvents, ...normalizedPH]);
    saveEventsToStorage();
}

async function fetchPHHolidaysByYear(year) {
    const endpoint = `https://date.nager.at/api/v3/PublicHolidays/${year}/PH`;
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Holiday API failed with status ${response.status}`);
    }

    const holidays = await response.json();
    if (!Array.isArray(holidays)) {
        throw new Error("Holiday API returned an invalid payload.");
    }

    return holidays
        .filter((item) => item && typeof item.date === "string")
        .map((item) => {
            const enName = (item.name || item.localName || "Philippine Holiday").trim();
            const localName = (item.localName || item.name || "Philippine Holiday").trim();
            return {
                id: buildPHEventId("ph-api", item.date, enName),
                start: item.date,
                end: item.date,
                name: enName,
                enName,
                localName,
                active: true,
                source: "ph-api"
            };
        });
}

async function syncPHHolidays(keepExistingActive = true) {
    if (isHolidaySyncing) {
        return false;
    }

    const syncButton = document.getElementById("syncPHBtn");
    const setSyncButtonState = (syncing) => {
        isHolidaySyncing = syncing;
        if (!syncButton) {
            return;
        }

        syncButton.disabled = syncing;
        syncButton.classList.toggle("is-syncing", syncing);
    };

    setSyncButtonState(true);

    const startDateInput = document.getElementById("startDate");
    const startYear = startDateInput && /^\d{4}-\d{2}-\d{2}$/.test(startDateInput.value)
        ? Number.parseInt(startDateInput.value.slice(0, 4), 10)
        : new Date().getFullYear();

    const years = [startYear, startYear + 1];

    try {
        const responses = await Promise.allSettled(years.map((year) => fetchPHHolidaysByYear(year)));
        const fulfilled = responses.filter((result) => result.status === "fulfilled");

        if (fulfilled.length === 0) {
            return false;
        }

        const mergedFromApi = fulfilled.flatMap((result) => result.value);
        mergePHEvents(mergedFromApi, keepExistingActive);
        updateAll();
        return true;
    } catch {
        return false;
    } finally {
        setSyncButtonState(false);
    }
}

function clearAllEvents() {
    const clearModal = document.getElementById("clearAllModal");
    if (clearModal && typeof clearModal.showModal === "function") {
        clearModal.showModal();
        return;
    }

    // Fallback when <dialog> is unsupported.
    const shouldClear = window.confirm("Clear all holidays and agenda events?");
    if (!shouldClear) {
        return;
    }

    confirmClearAllEvents();
}

function closeClearAllDialog() {
    const clearModal = document.getElementById("clearAllModal");
    if (clearModal && clearModal.open) {
        clearModal.close();
    }
}

function confirmClearAllEvents() {
    closeClearAllDialog();

    events = [];
    saveEventsToStorage();
    updateAll();
}

function getEventForDate(dateStr) {
    for (const eventItem of events) {
        if (!eventItem.active) {
            continue;
        }

        const startStr = eventItem.start;
        const endStr = eventItem.end || eventItem.start;
        if (dateStr >= startStr && dateStr <= endStr) {
            return getEventDisplayName(eventItem);
        }
    }

    return null;
}

function saveEvent() {
    const name = document.getElementById("evName").value.trim();
    const start = document.getElementById("evStart").value;
    const end = document.getElementById("evEnd").value;

    if (!name || !start) {
        alert("Name and Start Date are required.");
        return;
    }

    events.push({
        id: `user-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        name,
        enName: name,
        localName: name,
        start,
        end: end || start,
        active: true,
        source: "user"
    });

    sortEvents(events);
    saveEventsToStorage();

    document.getElementById("eventModal").close();
    document.getElementById("evName").value = "";
    document.getElementById("evStart").value = "";
    document.getElementById("evEnd").value = "";

    updateAll();
}

function toggleEvent(id) {
    const eventItem = events.find((item) => item.id === id);
    if (eventItem) {
        eventItem.active = !eventItem.active;
        saveEventsToStorage();
    }

    updateAll();
}

function deleteEvent(id) {
    events = events.filter((eventItem) => eventItem.id !== id);
    saveEventsToStorage();
    updateAll();
}

function renderCards() {
    const container = document.getElementById("cardsGrid");
    container.innerHTML = "";

    const searchInput = document.getElementById("holidaySearch");
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : "";

    const filteredEvents = events.filter((eventItem) => {
        if (!searchQuery) {
            return true;
        }

        const displayName = getEventDisplayName(eventItem).toLowerCase();
        return displayName.includes(searchQuery)
            || eventItem.start.includes(searchQuery)
            || (eventItem.end || "").includes(searchQuery);
    });

    if (filteredEvents.length === 0) {
        const emptyMessage = searchQuery
            ? "No matching holidays or agendas found."
            : "No holidays or agendas yet.";
        container.innerHTML = `<div class="cards-empty">${emptyMessage}</div>`;
        return;
    }

    filteredEvents.forEach((eventItem) => {
        const isRange = eventItem.end && eventItem.end !== eventItem.start;
        const dateText = isRange ? `${eventItem.start} to ${eventItem.end}` : eventItem.start;
        const displayName = getEventDisplayName(eventItem);

        container.innerHTML += `
      <div class="event-card ${!eventItem.active ? "disabled" : ""}">
                <div class="event-name" title="${displayName}">${displayName}</div>
        <div class="event-dates">${dateText}</div>
        <div class="event-actions">
          <label class="toggle-label">
            <div class="switch">
              <input type="checkbox" ${eventItem.active ? "checked" : ""} onchange="toggleEvent('${eventItem.id}')">
              <span class="slider"></span>
            </div>
            Active
          </label>
          <button class="btn-delete" onclick="deleteEvent('${eventItem.id}')" title="Delete Event">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
    });
}

function calculateDate() {
    ojtData.clear();
    finalEndDateStr = null;

    const targetHours = Number.parseInt(document.getElementById("targetHours").value, 10);
    const startDateVal = document.getElementById("startDate").value;

    if (!startDateVal || targetHours <= 0 || Number.isNaN(targetHours)) {
        document.getElementById("finalDateText").innerHTML = "Waiting for valid inputs...";
        return;
    }

    const hoursMap = {
        0: Math.min(12, Number.parseInt(document.getElementById("h0").value, 10) || 0),
        1: Math.min(12, Number.parseInt(document.getElementById("h1").value, 10) || 0),
        2: Math.min(12, Number.parseInt(document.getElementById("h2").value, 10) || 0),
        3: Math.min(12, Number.parseInt(document.getElementById("h3").value, 10) || 0),
        4: Math.min(12, Number.parseInt(document.getElementById("h4").value, 10) || 0),
        5: Math.min(12, Number.parseInt(document.getElementById("h5").value, 10) || 0),
        6: Math.min(12, Number.parseInt(document.getElementById("h6").value, 10) || 0)
    };

    if (Object.values(hoursMap).every((hours) => hours === 0)) {
        document.getElementById("finalDateText").innerHTML = "No working days selected.";
        return;
    }

    const [y, m, d] = startDateVal.split("-").map(Number);
    let currentDate = new Date(y, m - 1, d);
    let accumulated = 0;
    let iterations = 0;

    currentCalDate = new Date(y, m - 1, 1);

    while (accumulated < targetHours && iterations < 1500) {
        const dateStr = `${currentDate.getFullYear()}-${pad(currentDate.getMonth() + 1)}-${pad(currentDate.getDate())}`;
        const dayOfWeek = currentDate.getDay();
        const dailyHours = hoursMap[dayOfWeek];

        const holidayName = getEventForDate(dateStr);

        if (holidayName) {
            ojtData.set(dateStr, { type: "holiday", name: holidayName });
        } else if (dailyHours > 0) {
            let hoursLogged = dailyHours;
            let runningTotal = accumulated + dailyHours;
            if (accumulated + dailyHours >= targetHours) {
                hoursLogged = targetHours - accumulated;
                accumulated = targetHours;
                runningTotal = accumulated;
                finalEndDateStr = dateStr;
                ojtData.set(dateStr, { type: "work", hours: hoursLogged, total: runningTotal, isEnd: true });
                break;
            }

            accumulated += dailyHours;
            ojtData.set(dateStr, { type: "work", hours: hoursLogged, total: runningTotal });
        }

        currentDate.setDate(currentDate.getDate() + 1);
        iterations += 1;
    }

    const finalStr = finalEndDateStr ? new Date(finalEndDateStr).toDateString() : currentDate.toDateString();
    document.getElementById("finalDateText").innerHTML = `Ends on: <strong>${finalStr}</strong>`;
}

function startOfWeek(dateObj) {
    const weekStart = new Date(dateObj);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    return weekStart;
}

function getISOWeekNumber(dateObj) {
    const tempDate = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
    tempDate.setUTCDate(tempDate.getUTCDate() + 4 - (tempDate.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
    return Math.ceil(((tempDate - yearStart) / 86400000 + 1) / 7);
}

function getOJTWeekNumber(weekStartDate, startDateValue) {
    if (!startDateValue || !/^\d{4}-\d{2}-\d{2}$/.test(startDateValue)) {
        return "-";
    }

    const [startYear, startMonth, startDay] = startDateValue.split("-").map(Number);
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const startWeekDate = startOfWeek(startDate);

    if (weekStartDate < startWeekDate) {
        return "-";
    }

    const weekDiff = Math.floor((weekStartDate - startWeekDate) / (7 * 24 * 60 * 60 * 1000));
    return (weekDiff + 1).toString();
}

function jumpToStartMonth() {
    const startDateVal = document.getElementById("startDate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateVal)) {
        return;
    }

    const [year, month] = startDateVal.split("-").map(Number);
    currentCalDate = new Date(year, month - 1, 1);
    renderCalendar();
}

function jumpToEndMonth() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(finalEndDateStr || "")) {
        calculateDate();
    }

    const fallbackStartDate = document.getElementById("startDate").value;
    const jumpTarget = /^\d{4}-\d{2}-\d{2}$/.test(finalEndDateStr || "")
        ? finalEndDateStr
        : fallbackStartDate;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(jumpTarget || "")) {
        return;
    }

    const [year, month] = jumpTarget.split("-").map(Number);
    currentCalDate = new Date(year, month - 1, 1);
    renderCalendar();
}

function changeMonth(dir) {
    currentCalDate.setMonth(currentCalDate.getMonth() + dir);
    renderCalendar();
}

function renderCalendar() {
    const year = currentCalDate.getFullYear();
    const month = currentCalDate.getMonth();

    const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
    ];
    document.getElementById("calMonthYear").innerText = `${monthNames[month]} ${year}`;

    const grid = document.getElementById("calGrid");
    grid.innerHTML = `
    <div class="cal-day-header week-header">Wk</div>
    <div class="cal-day-header">Sun</div><div class="cal-day-header">Mon</div><div class="cal-day-header">Tue</div>
    <div class="cal-day-header">Wed</div><div class="cal-day-header">Thu</div><div class="cal-day-header">Fri</div><div class="cal-day-header">Sat</div>
  `;

    const firstDay = new Date(year, month, 1).getDay();
    const startDateVal = document.getElementById("startDate").value;
    const firstVisibleDate = new Date(year, month, 1 - firstDay);

    const generateCell = (dateObj, isFaded) => {
        const y = dateObj.getFullYear();
        const m = pad(dateObj.getMonth() + 1);
        const d = pad(dateObj.getDate());
        const dateStr = `${y}-${m}-${d}`;

        const data = ojtData.get(dateStr);
        let cellClass = `cal-cell${isFaded ? " faded" : ""}`;
        let badgesHTML = "";

        if (dateStr === startDateVal) {
            badgesHTML += '<div class="badge start">Start</div>';
        }

        if (data) {
            if (data.type === "work") {
                if (!isFaded) {
                    cellClass += " work-day";
                }
                badgesHTML += `<div class="badge hours">${data.total} hrs</div>`;
                if (data.isEnd) {
                    badgesHTML += '<div class="badge end">End</div>';
                }
            } else if (data.type === "holiday") {
                if (!isFaded) {
                    cellClass += " holiday-day";
                }
                badgesHTML += `<div class="badge holiday" title="${data.name}">${data.name}</div>`;
            }
        }

        return `
      <div class="${cellClass}">
        <div class="date-num">${dateObj.getDate()}</div>
        ${badgesHTML}
      </div>
    `;
    };

    for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
        const weekStart = new Date(firstVisibleDate);
        weekStart.setDate(firstVisibleDate.getDate() + weekIndex * 7);

        const isoWeek = getISOWeekNumber(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 3));
        const ojtWeek = getOJTWeekNumber(weekStart, startDateVal);
        const ojtWeekClass = ojtWeek === "-" ? "na" : "";
        const hoverText = ojtWeek === "-"
            ? `Week ${isoWeek} • OJT Week not started`
            : `Week ${isoWeek} • OJT Week ${ojtWeek}`;

        grid.innerHTML += `
            <div class="week-cell ${ojtWeekClass}" title="${hoverText}">
                <div class="week-ratio">
                    <span class="week-iso">${isoWeek}</span>
                    <span class="week-sep">/</span>
                    <span class="week-ojt">${ojtWeek}</span>
                </div>
            </div>
        `;

        for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
            const dayDate = new Date(weekStart);
            dayDate.setDate(weekStart.getDate() + dayOffset);
            const isFaded = dayDate.getMonth() !== month;
            grid.innerHTML += generateCell(dayDate, isFaded);
        }
    }
}

function updateAll() {
    calculateDate();
    renderCards();
    renderCalendar();
}

function initializeDisplaySettings() {
    const savedTheme = getStoredValue(STORAGE_KEYS.theme) || "dark";
    applyTheme(savedTheme, false);

    const savedColor = getStoredValue(STORAGE_KEYS.primaryColor) || DEFAULT_PRIMARY_COLOR;
    applyPrimaryColor(savedColor, false);

    const themeToggleButton = document.getElementById("themeToggleBtn");
    const colorPicker = document.getElementById("primaryColor");

    if (themeToggleButton) {
        themeToggleButton.addEventListener("click", () => {
            const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
            applyTheme(currentTheme === "dark" ? "light" : "dark");
        });
    }

    if (colorPicker) {
        colorPicker.addEventListener("input", (event) => {
            applyPrimaryColor(event.target.value);
        });
    }
}

function initializeSettingsDrawer() {
    const openButton = document.getElementById("openSettingsDrawer");
    const closeButton = document.getElementById("closeSettingsDrawer");
    const backdrop = document.getElementById("drawerBackdrop");

    if (!openButton || !closeButton || !backdrop) {
        return;
    }

    const mobileQuery = window.matchMedia("(max-width: 740px)");

    const setDrawerState = (isOpen) => {
        document.body.classList.toggle("drawer-open", isOpen);
        openButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
    };

    openButton.addEventListener("click", () => {
        setDrawerState(true);
    });

    closeButton.addEventListener("click", () => {
        setDrawerState(false);
    });

    backdrop.addEventListener("click", () => {
        setDrawerState(false);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            setDrawerState(false);
        }
    });

    mobileQuery.addEventListener("change", (event) => {
        if (!event.matches) {
            setDrawerState(false);
        }
    });
}

document.addEventListener("DOMContentLoaded", () => {
    const shouldAutoSyncOnLoad = getStoredValue(STORAGE_KEYS.settings) === null
        && getStoredValue(STORAGE_KEYS.events) === null;

    restoreSettingsFromStorage();
    initializeEvents();
    initializeDisplaySettings();
    initializeSettingsDrawer();
    updateAll();

    const inputs = document.querySelectorAll(".controls-pane input");
    inputs.forEach((input) => {
        input.addEventListener("input", () => {
            saveSettingsToStorage();
            updateAll();
        });

        input.addEventListener("change", () => {
            saveSettingsToStorage();
            updateAll();
        });
    });

    const holidaySearchInput = document.getElementById("holidaySearch");
    if (holidaySearchInput) {
        holidaySearchInput.addEventListener("input", () => {
            renderCards();
        });
    }

    saveSettingsToStorage();

    if (shouldAutoSyncOnLoad) {
        syncPHHolidays();
    }
});
