let currentCalDate = new Date(2026, 2, 1);
let ojtData = new Map();
let manualHourOverrides = new Map();
let finalEndDateStr = null;
let events = [];
let themeTransitionTimeout = null;
let isHolidaySyncing = false;

const STORAGE_KEYS = {
    theme: "ojt-theme",
    primaryColor: "ojt-primary-color",
    events: "ojt-events",
    settings: "ojt-settings",
    dayHours: "ojt-day-hours",
    calendarPaneWidth: "ojt-calendar-pane-width"
};

const DEFAULT_PRIMARY_COLOR = "#00b3ff";
const MAX_DAILY_HOURS = 24;
const DEFAULT_CALENDAR_WIDTH_RATIO = 0.50;
const MIN_CALENDAR_PANE_WIDTH = 420;
const MIN_RIGHT_PANE_WIDTH = 360;
const LAYOUT_SPLITTER_MIN_VIEWPORT = 1181;
const LAYOUT_SPLITTER_STEP = 28;
const SETTINGS_FIELD_IDS = [
    "targetHours",
    "startDate",
    "h0",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "holidayNameLocalToggle",
    "hoursCardPerDayToggle",
    "followTimeInOutToggle"
];

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

function showPerDayHoursCard() {
    const toggle = document.getElementById("hoursCardPerDayToggle");
    return Boolean(toggle && toggle.checked);
}

function followTimeInOutForComputation() {
    const toggle = document.getElementById("followTimeInOutToggle");
    return !toggle || toggle.checked;
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

function normalizeHours(hoursValue) {
    const parsed = Number.parseFloat(hoursValue);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
        return null;
    }

    const normalized = Math.round(clamp(parsed, 0, MAX_DAILY_HOURS) * 100) / 100;
    return normalized;
}

function formatHours(hoursValue) {
    if (hoursValue === null || hoursValue === undefined || Number.isNaN(hoursValue)) {
        return "";
    }

    const totalMinutes = Math.round(hoursValue * 60);
    return formatMinutesAsHoursAndMinutes(totalMinutes);
}

function formatHoursForNumberInput(hoursValue) {
    if (hoursValue === null || hoursValue === undefined || Number.isNaN(hoursValue)) {
        return "";
    }

    return Number.isInteger(hoursValue)
        ? `${hoursValue}`
        : hoursValue.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function escapeAttribute(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function normalizeWholeNumber(value, min, max, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
        return fallback;
    }

    return clamp(parsed, min, max);
}

function normalizeTimeValue(timeValue) {
    if (typeof timeValue !== "string") {
        return "";
    }

    const trimmed = timeValue.trim();
    if (!trimmed) {
        return "";
    }

    // Accept 24h and AM/PM formats (with optional seconds) from current and older stored data.
    const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([aApP][mM])?$/);
    if (!match) {
        return "";
    }

    let hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    const seconds = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
    const meridiem = match[4] ? match[4].toLowerCase() : "";

    if (meridiem) {
        if (hours < 1 || hours > 12) {
            return "";
        }

        if (meridiem === "am") {
            hours = hours % 12;
        } else {
            hours = (hours % 12) + 12;
        }
    }

    if (
        Number.isNaN(hours)
        || Number.isNaN(minutes)
        || Number.isNaN(seconds)
        || hours < 0
        || hours > 23
        || minutes < 0
        || minutes > 59
        || seconds < 0
        || seconds > 59
    ) {
        return "";
    }

    return `${pad(hours)}:${pad(minutes)}`;
}

function isValidTimeValue(timeValue) {
    return normalizeTimeValue(timeValue) !== "";
}

function parseTimeToMinutes(timeValue) {
    const normalized = normalizeTimeValue(timeValue);
    if (!normalized) {
        return null;
    }

    const [hours, minutes] = normalized.split(":").map(Number);

    return hours * 60 + minutes;
}

function formatMinutesAsHoursAndMinutes(totalMinutes) {
    const safeMinutes = Math.max(0, Math.floor(totalMinutes));
    const hours = Math.floor(safeMinutes / 60);
    const minutes = safeMinutes % 60;

    if (minutes === 0) {
        return `${hours}h`;
    }

    return `${hours}h ${minutes}m`;
}

function roundMinutesToHours(totalMinutes) {
    return Math.round((Math.max(0, totalMinutes) / 60) * 100) / 100;
}

function normalizeDayHoursEntry(rawEntry) {
    if (rawEntry === null || rawEntry === undefined) {
        return null;
    }

    // Backward compatibility: older storage used date => number.
    if (typeof rawEntry === "number" || typeof rawEntry === "string") {
        const creditedHours = normalizeHours(rawEntry);
        if (creditedHours === null) {
            return null;
        }

        return {
            creditedHours,
            timeIn: "",
            timeOut: "",
            deductHours: 0,
            deductMinutes: 0
        };
    }

    if (typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        return null;
    }

    const creditedHours = normalizeHours(rawEntry.creditedHours);
    const timeIn = normalizeTimeValue(rawEntry.timeIn);
    const timeOut = normalizeTimeValue(rawEntry.timeOut);
    const deductHours = normalizeWholeNumber(rawEntry.deductHours, 0, 23, 0);
    const deductMinutes = normalizeWholeNumber(rawEntry.deductMinutes, 0, 59, 0);

    if (creditedHours === null && !timeIn && !timeOut && deductHours === 0 && deductMinutes === 0) {
        return null;
    }

    return {
        creditedHours,
        timeIn,
        timeOut,
        deductHours,
        deductMinutes
    };
}

function buildManualEntrySummary(dateStr, entry) {
    const normalizedEntry = normalizeDayHoursEntry(entry);
    if (!normalizedEntry) {
        return {
            hasOverride: false,
            effectiveHours: 0,
            displayHours: null,
            displaySource: "none",
            tooltip: ""
        };
    }

    const creditedHours = normalizedEntry.creditedHours;
    const hasBothTimes = normalizedEntry.timeIn && normalizedEntry.timeOut;

    let grossMinutes = null;
    let netMinutes = null;
    let timeBasedHours = null;

    if (hasBothTimes) {
        const timeInMinutes = parseTimeToMinutes(normalizedEntry.timeIn);
        const timeOutMinutes = parseTimeToMinutes(normalizedEntry.timeOut);
        if (timeInMinutes !== null && timeOutMinutes !== null && timeOutMinutes > timeInMinutes) {
            grossMinutes = timeOutMinutes - timeInMinutes;
            const deductionTotal = normalizedEntry.deductHours * 60 + normalizedEntry.deductMinutes;
            netMinutes = Math.max(0, grossMinutes - deductionTotal);
            timeBasedHours = roundMinutesToHours(netMinutes);
        }
    }

    const shouldFollowTime = followTimeInOutForComputation();
    const preferredSource = shouldFollowTime ? "time-in-out" : "credited";
    const fallbackSource = shouldFollowTime ? "credited" : "time-in-out";
    const preferredHours = shouldFollowTime ? timeBasedHours : creditedHours;
    const fallbackHours = shouldFollowTime ? creditedHours : timeBasedHours;

    const selectedSourceHours = preferredHours !== null ? preferredHours : fallbackHours;
    const hasSelectedSourceValue = selectedSourceHours !== null;

    const effectiveHours = hasSelectedSourceValue ? selectedSourceHours : 0;
    const computationSource = hasSelectedSourceValue
        ? (preferredHours !== null ? preferredSource : fallbackSource)
        : "none";
    const displayHours = hasSelectedSourceValue ? selectedSourceHours : null;
    const displaySource = hasSelectedSourceValue
        ? (preferredHours !== null ? preferredSource : fallbackSource)
        : "none";

    const tooltipLines = [dateStr];
    tooltipLines.push(`Credited: ${creditedHours === null ? "not set" : formatHours(creditedHours)}`);
    tooltipLines.push(`Time In/Out: ${hasBothTimes ? `${normalizedEntry.timeIn} - ${normalizedEntry.timeOut}` : "not set"}`);
    tooltipLines.push(`Deduction: ${normalizedEntry.deductHours}h ${normalizedEntry.deductMinutes}m`);

    if (grossMinutes !== null && netMinutes !== null && timeBasedHours !== null) {
        tooltipLines.push(`Net Time: ${formatMinutesAsHoursAndMinutes(netMinutes)} (${formatHours(timeBasedHours)})`);
    }

    if (hasSelectedSourceValue && preferredHours === null) {
        tooltipLines.push(`Used for compute: ${computationSource} (fallback from ${preferredSource})`);
    } else {
        tooltipLines.push(`Used for compute: ${computationSource}`);
    }
    tooltipLines.push(`Shown on card: ${displaySource}`);

    return {
        hasOverride: hasSelectedSourceValue,
        normalizedEntry,
        creditedHours,
        timeBasedHours,
        effectiveHours,
        displayHours,
        displaySource,
        computationSource,
        tooltip: tooltipLines.join("\n")
    };
}

function normalizeStoredDayHours(rawHours) {
    if (!rawHours || typeof rawHours !== "object" || Array.isArray(rawHours)) {
        return new Map();
    }

    const normalized = new Map();
    Object.entries(rawHours).forEach(([dateStr, entryValue]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return;
        }

        const safeEntry = normalizeDayHoursEntry(entryValue);
        if (!safeEntry) {
            return;
        }

        normalized.set(dateStr, safeEntry);
    });

    return normalized;
}

function saveDayHoursToStorage() {
    const payload = Object.fromEntries(manualHourOverrides.entries());
    setStoredValue(STORAGE_KEYS.dayHours, JSON.stringify(payload));
}

function loadDayHoursFromStorage() {
    const raw = getStoredValue(STORAGE_KEYS.dayHours);
    if (!raw) {
        return new Map();
    }

    try {
        return normalizeStoredDayHours(JSON.parse(raw));
    } catch {
        return new Map();
    }
}

function initializeDayHours() {
    manualHourOverrides = loadDayHoursFromStorage();
    if (manualHourOverrides.size > 0) {
        saveDayHoursToStorage();
    }
}

function getConfiguredHoursForDay(dayIndex) {
    return Math.min(MAX_DAILY_HOURS, Number.parseInt(document.getElementById(`h${dayIndex}`).value, 10) || 0);
}

function getDefaultHoursForDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return 0;
    }

    const [year, month, day] = dateStr.split("-").map(Number);
    const dateObj = new Date(year, month - 1, day);
    const holidayName = getEventForDate(dateStr);

    if (holidayName) {
        return 0;
    }

    return getConfiguredHoursForDay(dateObj.getDay());
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

function closeDayHoursDialog() {
    const dayHoursModal = document.getElementById("dayHoursModal");
    if (dayHoursModal && dayHoursModal.open) {
        dayHoursModal.close();
    }
}

function openDayHoursDialog(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return;
    }

    const dayHoursModal = document.getElementById("dayHoursModal");
    const dateField = document.getElementById("dayHoursDate");
    const valueField = document.getElementById("dayHoursValue");
    const timeInField = document.getElementById("dayTimeIn");
    const timeOutField = document.getElementById("dayTimeOut");
    const deductHoursField = document.getElementById("dayDeductHours");
    const deductMinutesField = document.getElementById("dayDeductMinutes");
    const dateLabel = document.getElementById("dayHoursDateLabel");
    const defaultHint = document.getElementById("dayHoursDefaultHint");

    if (!dayHoursModal || !dateField || !valueField || !timeInField || !timeOutField
        || !deductHoursField || !deductMinutesField || !dateLabel || !defaultHint) {
        return;
    }

    dateField.value = dateStr;
    const [year, month, day] = dateStr.split("-").map(Number);
    const displayDate = new Date(year, month - 1, day).toDateString();
    dateLabel.textContent = displayDate;

    const defaultHours = getDefaultHoursForDate(dateStr);
    const storedEntry = manualHourOverrides.get(dateStr);
    const normalizedEntry = normalizeDayHoursEntry(storedEntry);
    defaultHint.textContent = `Default for this date: ${formatHours(defaultHours)} (clear all fields to remove override).`;

    if (normalizedEntry && normalizedEntry.creditedHours !== null) {
        valueField.value = formatHoursForNumberInput(normalizedEntry.creditedHours);
    } else {
        valueField.value = "";
    }

    timeInField.value = normalizedEntry ? normalizedEntry.timeIn : "";
    timeOutField.value = normalizedEntry ? normalizedEntry.timeOut : "";
    deductHoursField.value = normalizedEntry ? `${normalizedEntry.deductHours}` : "0";
    deductMinutesField.value = normalizedEntry ? `${normalizedEntry.deductMinutes}` : "0";

    if (typeof dayHoursModal.showModal === "function") {
        dayHoursModal.showModal();
        valueField.focus();
    }
}

function saveDayHoursEntry() {
    const dateField = document.getElementById("dayHoursDate");
    const valueField = document.getElementById("dayHoursValue");
    const timeInField = document.getElementById("dayTimeIn");
    const timeOutField = document.getElementById("dayTimeOut");
    const deductHoursField = document.getElementById("dayDeductHours");
    const deductMinutesField = document.getElementById("dayDeductMinutes");

    if (!dateField || !valueField || !timeInField || !timeOutField || !deductHoursField || !deductMinutesField
        || !/^\d{4}-\d{2}-\d{2}$/.test(dateField.value)) {
        return;
    }

    const rawCreditedValue = valueField.value.trim();
    const rawTimeIn = timeInField.value.trim();
    const rawTimeOut = timeOutField.value.trim();
    const rawDeductHours = deductHoursField.value.trim();
    const rawDeductMinutes = deductMinutesField.value.trim();
    const normalizedTimeIn = normalizeTimeValue(rawTimeIn);
    const normalizedTimeOut = normalizeTimeValue(rawTimeOut);
    const parsedDeductHours = normalizeWholeNumber(rawDeductHours, 0, 23, 0);
    const parsedDeductMinutes = normalizeWholeNumber(rawDeductMinutes, 0, 59, 0);

    if (rawTimeIn && !normalizedTimeIn) {
        window.alert("Please enter a valid Time In value.");
        return;
    }

    if (rawTimeOut && !normalizedTimeOut) {
        window.alert("Please enter a valid Time Out value.");
        return;
    }

    const hasAnyValue = Boolean(rawCreditedValue || normalizedTimeIn || normalizedTimeOut || parsedDeductHours > 0 || parsedDeductMinutes > 0);
    if (!hasAnyValue) {
        manualHourOverrides.delete(dateField.value);
        saveDayHoursToStorage();
        closeDayHoursDialog();
        updateAll();
        return;
    }

    let creditedHours = null;
    if (rawCreditedValue) {
        creditedHours = normalizeHours(rawCreditedValue);
    }

    if (rawCreditedValue && creditedHours === null) {
        window.alert("Please enter a valid number of hours.");
        return;
    }

    if ((normalizedTimeIn && !normalizedTimeOut) || (!normalizedTimeIn && normalizedTimeOut)) {
        window.alert("Please provide both Time In and Time Out.");
        return;
    }

    const timeInMinutes = normalizedTimeIn ? parseTimeToMinutes(normalizedTimeIn) : null;
    const timeOutMinutes = normalizedTimeOut ? parseTimeToMinutes(normalizedTimeOut) : null;
    if (normalizedTimeIn && normalizedTimeOut && (timeInMinutes === null || timeOutMinutes === null || timeOutMinutes <= timeInMinutes)) {
        window.alert("Time Out must be later than Time In.");
        return;
    }

    const deductHours = parsedDeductHours;
    const deductMinutes = parsedDeductMinutes;

    const normalizedEntry = normalizeDayHoursEntry({
        creditedHours,
        timeIn: normalizedTimeIn,
        timeOut: normalizedTimeOut,
        deductHours,
        deductMinutes
    });

    if (!normalizedEntry) {
        manualHourOverrides.delete(dateField.value);
    } else {
        manualHourOverrides.set(dateField.value, normalizedEntry);
    }

    saveDayHoursToStorage();
    closeDayHoursDialog();
    updateAll();
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
        0: getConfiguredHoursForDay(0),
        1: getConfiguredHoursForDay(1),
        2: getConfiguredHoursForDay(2),
        3: getConfiguredHoursForDay(3),
        4: getConfiguredHoursForDay(4),
        5: getConfiguredHoursForDay(5),
        6: getConfiguredHoursForDay(6)
    };

    const hasManualCreditedHours = Array.from(manualHourOverrides.entries())
        .some(([dateStr, entry]) => buildManualEntrySummary(dateStr, entry).effectiveHours > 0);
    if (Object.values(hoursMap).every((hours) => hours === 0) && !hasManualCreditedHours) {
        document.getElementById("finalDateText").innerHTML = "No working days selected.";
        return;
    }

    const [y, m, d] = startDateVal.split("-").map(Number);
    let currentDate = new Date(y, m - 1, d);
    let accumulated = 0;
    let iterations = 0;

    while (accumulated < targetHours && iterations < 1500) {
        const dateStr = `${currentDate.getFullYear()}-${pad(currentDate.getMonth() + 1)}-${pad(currentDate.getDate())}`;
        const dayOfWeek = currentDate.getDay();
        const configuredHours = hoursMap[dayOfWeek];
        const manualSummary = buildManualEntrySummary(dateStr, manualHourOverrides.get(dateStr));
        const hasManualOverride = manualSummary.hasOverride;
        const manualHours = hasManualOverride ? manualSummary.effectiveHours : 0;

        const holidayName = getEventForDate(dateStr);
        const dailyHours = hasManualOverride ? manualHours : configuredHours;
        const shouldRenderHoliday = Boolean(holidayName && (!hasManualOverride || dailyHours === 0));

        if (shouldRenderHoliday) {
            ojtData.set(dateStr, { type: "holiday", name: holidayName });
        } else if (dailyHours > 0) {
            let hoursLogged = dailyHours;
            let runningTotal = accumulated + dailyHours;
            if (accumulated + dailyHours >= targetHours) {
                hoursLogged = targetHours - accumulated;
                accumulated = targetHours;
                runningTotal = accumulated;
                finalEndDateStr = dateStr;
                ojtData.set(dateStr, {
                    type: "work",
                    hours: hoursLogged,
                    total: runningTotal,
                    isEnd: true,
                    isManual: hasManualOverride,
                    displayHours: hasManualOverride && manualSummary.displayHours !== null
                        ? manualSummary.displayHours
                        : hoursLogged,
                    tooltip: hasManualOverride ? manualSummary.tooltip : ""
                });
                break;
            }

            accumulated += dailyHours;
            ojtData.set(dateStr, {
                type: "work",
                hours: hoursLogged,
                total: runningTotal,
                isManual: hasManualOverride,
                displayHours: hasManualOverride && manualSummary.displayHours !== null
                    ? manualSummary.displayHours
                    : hoursLogged,
                tooltip: hasManualOverride ? manualSummary.tooltip : ""
            });
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
        if (!isFaded) {
            cellClass += " clickable";
        }

        let cellTooltip = "";

        let badgesHTML = "";

        if (dateStr === startDateVal) {
            badgesHTML += '<div class="badge start">Start</div>';
        }

        if (data) {
            if (data.type === "work") {
                if (!isFaded) {
                    cellClass += data.isManual ? " credited-day" : " work-day";
                }
                const hoursBadgeClass = data.isManual ? "badge hours credited" : "badge hours";
                const perDayHours = data.displayHours ?? data.hours;
                const displayedHours = showPerDayHoursCard() ? perDayHours : data.total;
                if (data.tooltip) {
                    cellTooltip = data.tooltip;
                }
                badgesHTML += `<div class="${hoursBadgeClass}">${formatHours(displayedHours)}</div>`;
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

        const cellTooltipAttr = cellTooltip ? ` title="${escapeAttribute(cellTooltip)}"` : "";

        return `
                        <div class="${cellClass}"${isFaded ? "" : ` data-date="${dateStr}" role="button" tabindex="0" aria-label="Set credited hours for ${dateStr}"`}${cellTooltipAttr}>
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

    attachCalendarDayEditors();
}

function attachCalendarDayEditors() {
    const editableCells = document.querySelectorAll(".cal-cell[data-date]");
    editableCells.forEach((cell) => {
        const dateStr = cell.dataset.date;
        if (!dateStr) {
            return;
        }

        cell.addEventListener("click", () => {
            openDayHoursDialog(dateStr);
        });

        cell.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openDayHoursDialog(dateStr);
            }
        });
    });
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

function getLayoutSplitterSize(layoutElement) {
    if (!layoutElement) {
        return 12;
    }

    const raw = getComputedStyle(layoutElement).getPropertyValue("--layout-splitter-size");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 12;
}

function getCalendarPaneWidthBounds(layoutElement) {
    const layoutWidth = layoutElement.getBoundingClientRect().width;
    const splitterSize = getLayoutSplitterSize(layoutElement);
    const maxCalendarWidth = Math.max(280, layoutWidth - MIN_RIGHT_PANE_WIDTH - splitterSize);
    const minCalendarWidth = Math.min(MIN_CALENDAR_PANE_WIDTH, maxCalendarWidth);

    return {
        layoutWidth,
        minCalendarWidth,
        maxCalendarWidth,
        splitterSize
    };
}

function applyCalendarPaneWidth(layoutElement, widthPx, persist = true) {
    if (!layoutElement || !Number.isFinite(widthPx)) {
        return null;
    }

    const bounds = getCalendarPaneWidthBounds(layoutElement);
    if (!Number.isFinite(bounds.minCalendarWidth) || !Number.isFinite(bounds.maxCalendarWidth)) {
        return null;
    }

    const clampedWidth = clamp(widthPx, bounds.minCalendarWidth, bounds.maxCalendarWidth);
    layoutElement.style.setProperty("--calendar-pane-width", `${Math.round(clampedWidth)}px`);

    if (persist) {
        setStoredValue(STORAGE_KEYS.calendarPaneWidth, `${Math.round(clampedWidth)}`);
    }

    return clampedWidth;
}

function initializeLayoutSplitter() {
    const layoutElement = document.querySelector(".layout");
    const splitter = document.getElementById("layoutSplitter");
    const calendarPane = document.querySelector(".calendar-pane");

    if (!layoutElement || !splitter || !calendarPane) {
        return;
    }

    let isDragging = false;
    let activePointerId = null;

    const isEnabled = () => window.innerWidth >= LAYOUT_SPLITTER_MIN_VIEWPORT;

    const updateAriaValues = () => {
        const bounds = getCalendarPaneWidthBounds(layoutElement);
        const currentWidth = calendarPane.getBoundingClientRect().width;
        const boundedCurrent = clamp(currentWidth, bounds.minCalendarWidth, bounds.maxCalendarWidth);

        splitter.setAttribute("aria-valuemin", `${Math.round(bounds.minCalendarWidth)}`);
        splitter.setAttribute("aria-valuemax", `${Math.round(bounds.maxCalendarWidth)}`);
        splitter.setAttribute("aria-valuenow", `${Math.round(boundedCurrent)}`);
    };

    const moveSplitter = (clientX, persist = false) => {
        const layoutRect = layoutElement.getBoundingClientRect();
        const splitterSize = getLayoutSplitterSize(layoutElement);
        const targetWidth = clientX - layoutRect.left - splitterSize / 2;
        const appliedWidth = applyCalendarPaneWidth(layoutElement, targetWidth, persist);
        if (appliedWidth !== null) {
            updateAriaValues();
        }
    };

    const stopDragging = () => {
        if (!isDragging) {
            return;
        }

        isDragging = false;
        activePointerId = null;
        document.body.classList.remove("is-resizing-layout");

        if (isEnabled()) {
            const currentWidth = calendarPane.getBoundingClientRect().width;
            applyCalendarPaneWidth(layoutElement, currentWidth, true);
        }

        updateAriaValues();
    };

    splitter.addEventListener("pointerdown", (event) => {
        if (!isEnabled()) {
            return;
        }

        isDragging = true;
        activePointerId = event.pointerId;
        splitter.setPointerCapture(event.pointerId);
        document.body.classList.add("is-resizing-layout");
        moveSplitter(event.clientX, false);
        event.preventDefault();
    });

    splitter.addEventListener("pointermove", (event) => {
        if (!isDragging || event.pointerId !== activePointerId) {
            return;
        }

        moveSplitter(event.clientX, false);
    });

    splitter.addEventListener("pointerup", (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }

        if (splitter.hasPointerCapture(event.pointerId)) {
            splitter.releasePointerCapture(event.pointerId);
        }

        stopDragging();
    });

    splitter.addEventListener("pointercancel", (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }

        if (splitter.hasPointerCapture(event.pointerId)) {
            splitter.releasePointerCapture(event.pointerId);
        }

        stopDragging();
    });

    splitter.addEventListener("lostpointercapture", () => {
        stopDragging();
    });

    splitter.addEventListener("keydown", (event) => {
        if (!isEnabled()) {
            return;
        }

        const bounds = getCalendarPaneWidthBounds(layoutElement);
        const currentWidth = calendarPane.getBoundingClientRect().width;

        let targetWidth = null;
        if (event.key === "ArrowLeft") {
            targetWidth = currentWidth - LAYOUT_SPLITTER_STEP;
        } else if (event.key === "ArrowRight") {
            targetWidth = currentWidth + LAYOUT_SPLITTER_STEP;
        } else if (event.key === "Home") {
            targetWidth = bounds.minCalendarWidth;
        } else if (event.key === "End") {
            targetWidth = bounds.maxCalendarWidth;
        }

        if (targetWidth === null) {
            return;
        }

        event.preventDefault();
        applyCalendarPaneWidth(layoutElement, targetWidth, true);
        updateAriaValues();
    });

    const restoreInitialWidth = () => {
        const bounds = getCalendarPaneWidthBounds(layoutElement);
        const savedWidth = Number.parseFloat(getStoredValue(STORAGE_KEYS.calendarPaneWidth) || "");
        const preferredWidth = Number.isFinite(savedWidth)
            ? savedWidth
            : bounds.layoutWidth * DEFAULT_CALENDAR_WIDTH_RATIO;

        applyCalendarPaneWidth(layoutElement, preferredWidth, false);
        updateAriaValues();
    };

    restoreInitialWidth();

    window.addEventListener("resize", () => {
        if (!isEnabled()) {
            return;
        }

        const currentWidth = calendarPane.getBoundingClientRect().width;
        applyCalendarPaneWidth(layoutElement, currentWidth, false);
        updateAriaValues();
    });
}

document.addEventListener("DOMContentLoaded", () => {
    const shouldAutoSyncOnLoad = getStoredValue(STORAGE_KEYS.settings) === null
        && getStoredValue(STORAGE_KEYS.events) === null;

    restoreSettingsFromStorage();

    const initialStartDate = document.getElementById("startDate").value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(initialStartDate)) {
        const [year, month] = initialStartDate.split("-").map(Number);
        currentCalDate = new Date(year, month - 1, 1);
    }

    initializeEvents();
    initializeDayHours();
    initializeDisplaySettings();
    initializeSettingsDrawer();
    initializeLayoutSplitter();
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
