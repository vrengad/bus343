// =======================================================================
// Bus 343 Commute App
// =======================================================================
// Shows live/scheduled departures for bus line 343 in Hoofddorp.
// Fetches data via a Cloudflare Worker proxy that relays ovzoeker.nl.
// =======================================================================

// ---------- Configuration ----------

// Your Cloudflare Worker base URL (from Phase 2a).
// Change this if you redeploy the proxy under a different name.
const PROXY_BASE = "https://bus343-proxy.vrengad.workers.dev";

// Travel time from home/station to the bus stop (minutes).
// Used to calculate whether you can still catch a departure.
const HOME_TRAVEL_MINUTES = 6;    // cycling from home to Floriande stop
const STATION_WALK_MINUTES = 2;   // walk from train platform to bus platform C

// The two stops we care about. Each one has:
//   - id:         ovzoeker's internal stop_id (used in the API path)
//   - cardId:     DOM id of the card where this stop's data should render
//   - direction:  the trip_headsign we want to filter to
//   - walkMinutes: travel time to reach this stop (for catchability indicator)
const STOPS = [
  {
    id: "3894530",
    cardId: "card-home-to-station",
    direction: "Hoofddorp Station",
    walkMinutes: HOME_TRAVEL_MINUTES,
  },
  {
    id: "3894616",
    cardId: "card-station-to-home",
    direction: "Hoofddorp Floriande Zuidoost",
    walkMinutes: STATION_WALK_MINUTES,
  },
];

// How many departures to show per card
const MAX_DEPARTURES = 2;

// How often to auto-refresh (milliseconds)
const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds

// Approximate one-way travel time for the 343 loop (seconds).
// Station ↔ Floriande is ~12 min with 1 intermediate stop (Calatravabrug).
const TRIP_DURATION_SECS = 720;

// ---------- Core fetch ----------

/**
 * Fetch raw departure data for a single stop from the proxy.
 * Returns the parsed JSON, or throws if something goes wrong.
 */
async function fetchStop(stopId) {
  const url = `${PROXY_BASE}/${stopId}`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from proxy`);
  }

  return await response.json();
}

// ---------- Data shaping ----------

/**
 * Take raw ovzoeker arrivals, filter to line 343 in the right direction,
 * skip anything in the past, sort by time, and return up to MAX_DEPARTURES.
 */
function extractLine343(data, direction) {
  const arrivals = data?.arrivals ?? [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  return arrivals
    .filter((a) => a.route_short_name === "343")
    .filter((a) => a.trip_headsign === direction)
    .filter((a) => a.ts >= nowSeconds - 30) // keep "now" (up to 30s ago)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, MAX_DEPARTURES)
    .map(toDepartureObject);
}

/**
 * Get the soonest line-343 arrival at a stop, regardless of direction.
 * Used by the position strip to determine where the bus is.
 */
function extractNextArrivalAtStop(data) {
  const arrivals = data?.arrivals ?? [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  const upcoming = arrivals
    .filter((a) => a.route_short_name === "343")
    .filter((a) => a.ts >= nowSeconds - 30)
    .sort((a, b) => a.ts - b.ts);

  return upcoming.length > 0 ? upcoming[0] : null;
}

/**
 * Derive the bus's approximate position on the 3-stop loop from arrival data.
 * Returns { state, stripPercent (0–100), label, isLate }.
 *
 * Layout: Floriande (0%) ——— Calatravabrug (50%) ——— Station (100%)
 * Direction is inferred by comparing the next arrival at each endpoint.
 */
function deriveBusPosition(floriandeData, stationData) {
  const nextFloriande = extractNextArrivalAtStop(floriandeData);
  const nextStation = extractNextArrivalAtStop(stationData);
  const nowSecs = Math.floor(Date.now() / 1000);
  const noService = {
    state: "no-service",
    stripPercent: 0,
    label: "No bus running",
    isLate: false,
  };

  if (!nextFloriande && !nextStation) return noService;

  const secsUntil = (a) => Math.max(0, a.ts - nowSecs);

  // Only Floriande data → bus heading toward Floriande
  if (!nextStation) {
    const secs = secsUntil(nextFloriande);
    if (secs <= 30)
      return { state: "at-stop", stripPercent: 0, label: "Bus at Floriande", isLate: false };
    const progress = Math.min(1, Math.max(0, 1 - secs / TRIP_DURATION_SECS));
    return {
      state: "moving",
      stripPercent: (1 - progress) * 100,
      label: `Approaching Floriande in ${Math.ceil(secs / 60)} min`,
      isLate: (nextFloriande.punctuality || 0) > 60,
    };
  }

  // Only Station data → bus heading toward Station
  if (!nextFloriande) {
    const secs = secsUntil(nextStation);
    if (secs <= 30)
      return { state: "at-stop", stripPercent: 100, label: "Bus at Station", isLate: false };
    const progress = Math.min(1, Math.max(0, 1 - secs / TRIP_DURATION_SECS));
    return {
      state: "moving",
      stripPercent: progress * 100,
      label: `Approaching Station in ${Math.ceil(secs / 60)} min`,
      isLate: (nextStation.punctuality || 0) > 60,
    };
  }

  // Both stops have data — compare arrival times to determine direction
  const secsToStation = secsUntil(nextStation);
  const secsToFloriande = secsUntil(nextFloriande);
  const avgPunctuality =
    ((nextStation.punctuality || 0) + (nextFloriande.punctuality || 0)) / 2;
  const isLate = avgPunctuality > 60;

  // Bus is at (or just arrived at) a stop
  if (secsToStation <= 30)
    return { state: "at-stop", stripPercent: 100, label: "Bus at Station", isLate };
  if (secsToFloriande <= 30)
    return { state: "at-stop", stripPercent: 0, label: "Bus at Floriande", isLate };

  if (secsToStation <= secsToFloriande) {
    // Heading toward Station (left → right on strip)
    const progress = Math.min(1, Math.max(0, 1 - secsToStation / TRIP_DURATION_SECS));
    const mins = Math.ceil(secsToStation / 60);
    return {
      state: "moving",
      stripPercent: progress * 100,
      label: mins <= 1 ? "Arriving at Station" : `Approaching Station in ${mins} min`,
      isLate,
    };
  } else {
    // Heading toward Floriande (right → left on strip)
    const progress = Math.min(1, Math.max(0, 1 - secsToFloriande / TRIP_DURATION_SECS));
    const mins = Math.ceil(secsToFloriande / 60);
    return {
      state: "moving",
      stripPercent: (1 - progress) * 100,
      label: mins <= 1 ? "Arriving at Floriande" : `Approaching Floriande in ${mins} min`,
      isLate,
    };
  }
}

/**
 * Convert a raw arrival into a clean, presentation-ready object.
 * This is the shape the render function expects.
 */
function toDepartureObject(arrival) {
  const departureDate = new Date(arrival.ts * 1000);
  const now = new Date();
  const minutesLeft = Math.round((departureDate - now) / 60000);

  return {
    line: arrival.route_short_name,
    destination: arrival.trip_headsign,
    clockTime: formatClockTime(departureDate),
    minutesLeft,
    isLive: arrival.type !== "scheduled", // ovzoeker uses "scheduled" vs realtime
    delaySeconds: arrival.punctuality || 0,
  };
}

// ---------- Formatting helpers ----------

/**
 * Format a Date as HH:MM in 24-hour, Europe/Amsterdam.
 */
function formatClockTime(date) {
  return date.toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Amsterdam",
  });
}

/**
 * Turn minutesLeft into a human-friendly string.
 * "now" for ≤0, "1 min", "2 min", etc.
 */
function formatMinutesLeft(minutesLeft) {
  if (minutesLeft <= 0) return "now";
  return `${minutesLeft} min`;
}

/**
 * Format the delay (if any) as "+2m" or empty string.
 * Uses minutes, rounded up, because the raw value is in seconds.
 */
function formatDelay(delaySeconds) {
  if (!delaySeconds || delaySeconds < 30) return "";
  const delayMinutes = Math.round(delaySeconds / 60);
  return `+${delayMinutes}m late`;
}

// ---------- Rendering ----------

/**
 * Render a list of departures into a card, or an empty-state message.
 */
function renderCard(cardId, departures, walkMinutes) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const body = card.querySelector(".card__body");

  if (departures.length === 0) {
    body.dataset.state = "empty";
    body.innerHTML = `<p class="card__status">No bus 343 in the next hour</p>`;
    return;
  }

  body.dataset.state = "ok";
  body.innerHTML = `
    <ul class="departures">
      ${departures.map((d) => renderDepartureRow(d, walkMinutes)).join("")}
    </ul>
  `;
}

/**
 * Render one departure row. Returns an HTML string.
 */
function renderDepartureRow(d, walkMinutes) {
  const liveTag = d.isLive
    ? `<span class="live">● live</span>`
    : `<span>scheduled</span>`;

  const delayTag = d.delaySeconds >= 30
    ? ` · <span class="delay">${formatDelay(d.delaySeconds)}</span>`
    : "";

  // Catchability: can you still reach the stop in time?
  let catchClass = "";
  let catchLabel = "";
  if (walkMinutes != null) {
    if (d.minutesLeft >= walkMinutes + 1) {
      catchClass = " departure--catchable";
      const leaveIn = d.minutesLeft - walkMinutes;
      catchLabel = `<div class="departure__catch departure__catch--go">Leave in ${leaveIn} min</div>`;
    } else if (d.minutesLeft >= walkMinutes - 1) {
      catchClass = " departure--run";
      catchLabel = `<div class="departure__catch departure__catch--run">Leave now!</div>`;
    } else {
      catchClass = " departure--missed";
    }
  }

  return `
    <li class="departure${catchClass}">
      <div class="departure__line">${escapeHtml(d.line)}</div>
      <div class="departure__main">
        <div class="departure__destination">${escapeHtml(d.destination)}</div>
        <div class="departure__meta">${liveTag}${delayTag}</div>
      </div>
      <div class="departure__time">
        <div class="departure__minutes">${formatMinutesLeft(d.minutesLeft)}</div>
        <div class="departure__clock">${d.clockTime}</div>
        ${catchLabel}
      </div>
    </li>
  `;
}

/**
 * Render an error state into a card.
 */
function renderError(cardId, message) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const body = card.querySelector(".card__body");
  body.dataset.state = "error";
  body.innerHTML = `<p class="card__status">⚠ ${escapeHtml(message)}</p>`;
}

/**
 * Update the position strip with the bus's current location.
 */
function renderPositionStrip(pos) {
  const busEl = document.getElementById("strip-bus");
  const statusEl = document.getElementById("strip-status");
  if (!busEl || !statusEl) return;

  if (pos.state === "no-service") {
    busEl.style.display = "none";
    statusEl.textContent = pos.label;
    statusEl.className = "strip__status";
    return;
  }

  busEl.style.display = "";
  busEl.style.left = pos.stripPercent + "%";

  const label = pos.isLate ? pos.label + " · running late" : pos.label;
  statusEl.textContent = label;
  statusEl.className = pos.isLate
    ? "strip__status strip__status--late"
    : "strip__status";
}

/**
 * Tiny escape-html helper to prevent any weird data from breaking the page.
 * Not strictly needed for trusted data, but good hygiene.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Orchestration ----------

/**
 * Fetch one stop, process it, render it. Isolated in its own function so
 * a failure on one card never affects the other.
 */
async function refreshOneStop(stop) {
  try {
    const data = await fetchStop(stop.id);
    const departures = extractLine343(data, stop.direction);
    renderCard(stop.cardId, departures, stop.walkMinutes);
    return data;
  } catch (err) {
    console.error(`Failed to load stop ${stop.id}:`, err);
    renderError(stop.cardId, "Could not load departures");
    return null;
  }
}

/**
 * Refresh all cards in parallel and update the "last updated" timestamp.
 */
async function refreshAll() {
  const rawData = await Promise.all(STOPS.map(refreshOneStop));

  // STOPS[0] = Floriande (3894530), STOPS[1] = Station (3894616)
  const pos = deriveBusPosition(rawData[0], rawData[1]);
  renderPositionStrip(pos);

  updateLastUpdated();
}

/**
 * Update the "Last updated: HH:MM:SS" footer.
 */
function updateLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  const now = new Date();
  const time = now.toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Amsterdam",
  });
  el.textContent = `Last updated: ${time}`;
}

// ---------- Startup ----------

// Initial load as soon as the script runs (which is after HTML is parsed,
// thanks to the `defer` attribute on the script tag).
refreshAll();

// Auto-refresh every 60 seconds.
setInterval(refreshAll, REFRESH_INTERVAL_MS);

// Also refresh when the tab becomes visible again (e.g. after your phone
// was locked). Otherwise you'd stare at stale data for up to 60 seconds.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshAll();
  }
});