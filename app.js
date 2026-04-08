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
const APP_TIMEZONE = "Europe/Amsterdam";

const departureTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: APP_TIMEZONE,
});

const footerTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: APP_TIMEZONE,
});

const headerDateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: APP_TIMEZONE,
});

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
 * Get the soonest line-343 arrival at a stop for one specific headsign.
 * This lets us track each direction independently.
 */
function extractNextArrivalForDirection(data, direction, maxPastSeconds = 30) {
  const arrivals = data?.arrivals ?? [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  const upcoming = arrivals
    .filter((a) => a.route_short_name === "343")
    .filter((a) => a.trip_headsign === direction)
    .filter((a) => a.ts >= nowSeconds - maxPastSeconds)
    .sort((a, b) => a.ts - b.ts);

  return upcoming.length > 0 ? upcoming[0] : null;
}

/**
 * Fallback candidate when destination-arrival data is unavailable:
 * infer in-trip progress from departures at the origin stop.
 */
function extractDepartureFallback(data, direction) {
  const arrivals = data?.arrivals ?? [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  const candidates = arrivals
    .filter((a) => a.route_short_name === "343")
    .filter((a) => a.trip_headsign === direction)
    .filter((a) => a.ts >= nowSeconds - TRIP_DURATION_SECS)
    .sort((a, b) => a.ts - b.ts);

  if (candidates.length === 0) return null;

  const pastOrNow = [...candidates].reverse().find((a) => a.ts <= nowSeconds + 30);
  const next = candidates.find((a) => a.ts > nowSeconds + 30);
  const chosen = pastOrNow || next;
  if (!chosen) return null;

  return {
    ...chosen,
    inferredArrivalTs: chosen.ts + TRIP_DURATION_SECS,
  };
}

/**
 * Derive up to two independent bus positions from arrival data.
 * Returns { state, buses, label, isLate } where each bus has:
 * { key, stripPercent (0-100), directionLabel, minsUntilStop, isLate }.
 *
 * Layout: Floriande (0%) ——— Calatravabrug (50%) ——— Station (100%)
 *
 * Key insight used:
 * - Floriande stop + "Hoofddorp Station" = bus heading to Station.
 * - Station stop + "Hoofddorp Floriande Zuidoost" = bus heading to Floriande.
 */
function deriveBusPositions(floriandeData, stationData) {
  // Prefer destination-stop arrivals for interpolation; fallback to origin departures.
  const toStationArrival = extractNextArrivalForDirection(
    stationData,
    "Hoofddorp Station"
  );
  const toStationDeparture = extractDepartureFallback(
    floriandeData,
    "Hoofddorp Station"
  );
  const toFloriandeArrival = extractNextArrivalForDirection(
    floriandeData,
    "Hoofddorp Floriande Zuidoost"
  );
  const toFloriandeDeparture = extractDepartureFallback(
    stationData,
    "Hoofddorp Floriande Zuidoost"
  );
  const toStation = toStationArrival || toStationDeparture;
  const toFloriande = toFloriandeArrival || toFloriandeDeparture;
  const nowSecs = Math.floor(Date.now() / 1000);
  const noService = {
    state: "no-service",
    buses: [],
    label: "No bus running",
    isLate: false,
  };

  if (!toStation && !toFloriande) return noService;

  const secsUntilDestination = (a) =>
    Math.max(0, (a.inferredArrivalTs || a.ts) - nowSecs);
  const buses = [];

  if (toStation) {
    const secs = secsUntilDestination(toStation);
    if (secs <= TRIP_DURATION_SECS) {
      const progress = Math.min(1, Math.max(0, 1 - secs / TRIP_DURATION_SECS));
      buses.push({
        key: "to-station",
        stripPercent: progress * 100,
        directionLabel: "to Station",
        minsUntilStop: Math.ceil(secs / 60),
        isLate: (toStation.punctuality || 0) > 60,
      });
    }
  }

  if (toFloriande) {
    const secs = secsUntilDestination(toFloriande);
    if (secs <= TRIP_DURATION_SECS) {
      const progress = Math.min(1, Math.max(0, 1 - secs / TRIP_DURATION_SECS));
      buses.push({
        key: "to-floriande",
        stripPercent: (1 - progress) * 100,
        directionLabel: "to Floriande",
        minsUntilStop: Math.ceil(secs / 60),
        isLate: (toFloriande.punctuality || 0) > 60,
      });
    }
  }

  if (buses.length === 0) {
    return {
      state: "no-service",
      buses: [],
      label: "No bus currently on this segment",
      isLate: false,
    };
  }

  const statuses = buses.map((bus) => {
    if (bus.minsUntilStop <= 0) return `Arriving ${bus.directionLabel}`;
    if (bus.minsUntilStop <= 1) return `${bus.directionLabel} in 1 min`;
    return `${bus.directionLabel} in ${bus.minsUntilStop} min`;
  });
  const hasLateBus = buses.some((bus) => bus.isLate);

  return {
    state: buses.length > 1 ? "dual-moving" : "moving",
    buses,
    label: statuses.join(" · "),
    isLate: hasLateBus,
  };
}

/**
 * Update the position strip with up to two buses (one per direction).
 */
function renderPositionStrip(pos) {
  const busToStationEl = document.getElementById("strip-bus-to-station");
  const busToFloriandeEl = document.getElementById("strip-bus-to-floriande");
  const statusEl = document.getElementById("strip-status");
  if (!busToStationEl || !busToFloriandeEl || !statusEl) return;

  const busEls = {
    "to-station": busToStationEl,
    "to-floriande": busToFloriandeEl,
  };

  // Reset visibility first, then show only available buses.
  busToStationEl.style.display = "none";
  busToFloriandeEl.style.display = "none";

  if (pos.state === "no-service") {
    statusEl.textContent = pos.label;
    statusEl.className = "strip__status";
    return;
  }

  for (const bus of pos.buses) {
    const busEl = busEls[bus.key];
    if (!busEl) continue;
    busEl.style.display = "";
    busEl.style.left = bus.stripPercent + "%";
  }

  const label = pos.isLate ? `${pos.label} · running late` : pos.label;
  statusEl.textContent = label;
  statusEl.className = pos.isLate
    ? "strip__status strip__status--late"
    : "strip__status";
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
  return departureTimeFormatter.format(date);
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

/**
 * Format and render current weekday/date/time in the app header.
 */
function updateHeaderDateTime() {
  const el = document.getElementById("app-datetime");
  if (!el) return;

  const now = new Date();
  const dateTime = headerDateFormatter.format(now);

  el.textContent = dateTime;
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
  const pos = deriveBusPositions(rawData[0], rawData[1]);
  renderPositionStrip(pos);

  updateLastUpdated();
}

/**
 * Update the "Last updated: HH:MM:SS" footer.
 */
function updateLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  const time = footerTimeFormatter.format(new Date());
  el.textContent = `Last updated: ${time}`;
}

// ---------- Startup ----------

// Initial load as soon as the script runs (which is after HTML is parsed,
// thanks to the `defer` attribute on the script tag).
refreshAll();
updateHeaderDateTime();

// Auto-refresh every 60 seconds.
setInterval(refreshAll, REFRESH_INTERVAL_MS);
setInterval(updateHeaderDateTime, 1000);

// Also refresh when the tab becomes visible again (e.g. after your phone
// was locked). Otherwise you'd stare at stale data for up to 60 seconds.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshAll();
    updateHeaderDateTime();
  }
});
