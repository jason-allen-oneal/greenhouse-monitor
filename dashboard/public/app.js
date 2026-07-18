const state = {
  latest: null,
  snapshots: [],
  snapshotSchedule: null,
  lastRefresh: null,
  refreshInFlight: false,
  streamConnected: false,
  streamFallbackTimer: null,
  lastPressure: null,
  nowcast: null,
  externalWeather: null,
};

const $ = (id) => document.getElementById(id);

function compactNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  if (parsed >= 1000000) return (parsed / 1000000).toFixed(1) + "M";
  if (parsed >= 1000) return (parsed / 1000).toFixed(1) + "K";
  return parsed.toLocaleString();
}

function number(value, digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  return parsed.toFixed(digits);
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  return Math.round(parsed).toLocaleString();
}

function pressureTrend(current, previous) {
  if (previous === null || current === null) return { label: "--", class: "" };
  const diff = current - previous;
  if (Math.abs(diff) < 0.1) return { label: "→ steady", class: "steady" };
  return diff > 0 ? { label: `↑ rising ${number(diff, 1)}`, class: "rising" } : { label: `↓ falling ${number(-diff, 1)}`, class: "falling" };
}

function gasValidity(valid) {
  if (valid === true) return { label: "valid", class: "valid" };
  if (valid === false) return { label: "invalid", class: "invalid" };
  return { label: "unknown", class: "warn" };
}

function formatUptime(ms) {
  const secs = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(secs)) return "--";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (!parts.length) parts.push(`${secs}s`);
  return parts.join(" ");
}

function ageSeconds(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 1000));
}

function ageLabel(iso) {
  const age = ageSeconds(iso);
  if (age === null) return "--";
  if (age < 90) return `${age}s`;
  if (age < 5400) return `${Math.round(age / 60)}m`;
  return `${Math.round(age / 3600)}h`;
}

function timeLabel(isoOrSeconds) {
  const date = typeof isoOrSeconds === "number"
    ? new Date(isoOrSeconds * 1000)
    : new Date(isoOrSeconds);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getPayload(record) {
  return record?.payload || {};
}

function getReading(record) {
  return getPayload(record).reading || {};
}

function setLive(kind, text) {
  const pill = $("live-pill");
  pill.className = `pill ${kind}`;
  pill.querySelector("b").textContent = text;
}

function drawChart(canvas, items, accessor, color, suffix) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#080a09";
  ctx.fillRect(0, 0, width, height);

  const values = items
    .map((item) => ({item, value: Number(accessor(item))}))
    .filter((item) => Number.isFinite(item.value));

  ctx.strokeStyle = "#29332d";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = Math.round((height / 4) * i);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (!values.length) {
    ctx.fillStyle = "#a3b0a7";
    ctx.font = "24px system-ui";
    ctx.fillText("Waiting for snapshots", 28, 56);
    return;
  }

  const min = Math.min(...values.map((item) => item.value));
  const max = Math.max(...values.map((item) => item.value));
  const pad = Math.max((max - min) * 0.15, max === min ? 1 : 0);
  const low = min - pad;
  const high = max + pad;
  const xStep = values.length <= 1 ? 0 : width / (values.length - 1);
  const yFor = (value) => height - ((value - low) / (high - low || 1)) * (height - 34) - 17;

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  values.forEach((point, index) => {
    const x = values.length === 1 ? width / 2 : xStep * index;
    const y = yFor(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = color;
  values.forEach((point, index) => {
    const x = values.length === 1 ? width / 2 : xStep * index;
    const y = yFor(point.value);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  const latest = values[values.length - 1].value;
  ctx.fillStyle = "#eef4ee";
  ctx.font = "700 26px system-ui";
  ctx.fillText(`${number(latest, 1)}${suffix}`, 22, 38);
  ctx.fillStyle = "#a3b0a7";
  ctx.font = "13px system-ui";
  ctx.fillText(`${number(min, 1)} - ${number(max, 1)}${suffix}`, 22, 60);
}

// Simple linear regression for prediction
function linearRegression(points) {
  // points: [{x: number, y: number}] - x is time index, y is value
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function predictValue(records, accessor, futureSteps = 1) {
  const points = records
    .map((record, idx) => ({ x: idx, y: Number(accessor(record)) }))
    .filter((p) => Number.isFinite(p.y));
  if (points.length < 3) return null;
  const model = linearRegression(points);
  if (!model) return null;
  const nextX = points.length - 1 + futureSteps;
  return model.slope * nextX + model.intercept;
}

function percent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  return `${Math.round(parsed * 100)}%`;
}

function change(value, suffix, digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "--";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(digits)}${suffix}`;
}

function renderExternalWeather() {
  const weather = state.externalWeather || state.nowcast?.prediction?.external_weather;
  const source = $("external-weather-source");
  const forecast = $("external-weather-forecast");
  const pop = $("external-weather-pop");
  const alerts = $("external-weather-alerts");
  const note = $("external-weather-note");
  if (!source && !forecast && !pop && !alerts && !note) return;
  if (!weather || weather.configured === false) {
    if (source) source.textContent = "not configured";
    if (forecast) forecast.textContent = "--";
    if (pop) pop.textContent = "--";
    if (alerts) alerts.textContent = "--";
    if (note) note.textContent = "Set GREENHOUSE_LAT and GREENHOUSE_LON on the dashboard server to enable Open-Meteo and NWS supplement.";
    return;
  }
  const openMeteo = weather.sources?.open_meteo || weather.open_meteo;
  const nws = weather.sources?.nws || weather.nws;
  const sources = [openMeteo ? "Open-Meteo" : null, nws ? "NWS" : null].filter(Boolean).join(" + ") || "unavailable";
  const nwsForecast = nws?.hourly?.[0]?.short_forecast || "--";
  const omPop = openMeteo?.hourly?.precipitation_probability_next_1h;
  const nwsPop = nws?.hourly?.[0]?.probability_of_precipitation;
  const popValues = [omPop, nwsPop].map(Number).filter(Number.isFinite);
  if (source) source.textContent = sources;
  if (forecast) forecast.textContent = nwsForecast;
  if (pop) pop.textContent = popValues.length ? `${Math.round(popValues.reduce((a, b) => a + b, 0) / popValues.length)}%` : "--";
  if (alerts) alerts.textContent = nws?.alerts?.length ? `${nws.alerts.length} active` : "none";
  if (note) note.textContent = weather.ok ? "Public weather supplements local greenhouse trends; local sensor data remains primary." : (weather.errors || []).join("; ") || "External weather unavailable.";
}

function renderNowcast() {
  const payload = state.nowcast;
  const prediction = payload?.prediction || payload;
  if (!prediction || prediction.ok === false) return;
  const rain30 = $("rain-30m"); if (rain30) rain30.textContent = percent(prediction.rain_next_30m_probability);
  const rain1 = $("rain-1h"); if (rain1) rain1.textContent = percent(prediction.rain_next_1h_probability);
  const rain3 = $("rain-3h"); if (rain3) rain3.textContent = percent(prediction.rain_next_3h_probability);
  const temp = $("nowcast-temp-change"); if (temp) temp.textContent = change(prediction.temperature_change_next_1h, " C", 2);
  const humidity = $("nowcast-humidity-change"); if (humidity) humidity.textContent = change(prediction.humidity_change_next_1h, "%", 1);
  const pressure = $("nowcast-pressure-change"); if (pressure) pressure.textContent = change(prediction.pressure_change_next_1h, " hPa", 2);
  const storm = $("nowcast-storm-risk"); if (storm) storm.textContent = prediction.storm_risk || "unknown";
  const model = $("nowcast-model"); if (model) model.textContent = prediction.model_version || "local";
  const expl = $("nowcast-explanation"); if (expl) expl.textContent = prediction.explanation || "Local greenhouse nowcast unavailable.";
  const signals = $("nowcast-signals");
  if (signals) {
    signals.innerHTML = (prediction.top_signals || []).map((signal) => `<li>${signal}</li>`).join("");
  }
}

function renderPredictions() {
  if (!state.snapshots.length) return;
  const snapshots = state.snapshots.map((s) => s.record);
  const current = state.latest?.reading;
  if (current) snapshots.push(current);
  if (snapshots.length < 3) return;

  const steps = {
    "30 min": 1,
    "1 hour": 2,
    "3 hours": 6,
    "6 hours": 12,
  };

  const metrics = [
    { label: "Temperature", accessor: (r) => getReading(r).temperature_f, suffix: "°F", color: "#70d46f" },
    { label: "Humidity", accessor: (r) => getReading(r).humidity_percent, suffix: "%", color: "#72c8d6" },
    { label: "Pressure", accessor: (r) => getReading(r).pressure_hpa, suffix: " hPa", color: "#e0bd63" },
    { label: "Gas", accessor: (r) => getReading(r).gas_ohms ? getReading(r).gas_ohms / 1000 : null, suffix: " kΩ", color: "#e16f63" },
  ];

  const list = $("predictions-list");
  if (!list) return;
  list.innerHTML = metrics.map((metric) => {
    const currentVal = metric.accessor(snapshots[snapshots.length - 1]);
    const rows = Object.entries(steps).map(([label, step]) => {
      const predicted = predictValue(snapshots, metric.accessor, step);
      if (predicted === null) return "";
      const diff = predicted - currentVal;
      const dir = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
      const diffColor = diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--amber)";
      return `<div><dt>${label}</dt><dd style="color:${diffColor}">${dir} ${number(predicted, 1)}${metric.suffix}</dd></div>`;
    }).join("");
    return rows ? `<div style="margin-bottom:12px"><b style="color:${metric.color}">${metric.label}</b><dl>${rows}</dl></div>` : "";
  }).join("");
}

function renderLatest() {
  if (!state.latest?.reading) return;
  const record = state.latest.reading;
  const payload = getPayload(record);
  const reading = getReading(record);
  const age = ageSeconds(record.received_at);

  const tempF = $("temp-f"); if (tempF) tempF.textContent = number(reading.temperature_f, 1);
  const tempC = $("temp-c"); if (tempC) tempC.textContent = `${number(reading.temperature_c, 1)} C`;
  const humidityEl = $("humidity"); if (humidityEl) humidityEl.textContent = number(reading.humidity_percent, 1);
  const pressureEl = $("pressure"); if (pressureEl) pressureEl.textContent = number(reading.pressure_hpa, 1);
  
  // Pressure trend
  const pressureTrendResult = pressureTrend(reading.pressure_hpa, state.lastPressure);
  const pressureTrendEl = $("pressure-trend");
  if (pressureTrendEl) {
    pressureTrendEl.textContent = pressureTrendResult.label;
    pressureTrendEl.className = `trend-indicator ${pressureTrendResult.class}`;
  }
  state.lastPressure = reading.pressure_hpa;

  // Gas in kΩ with validity
  const gasEl = $("gas");
  const gasKohms = reading.gas_ohms ? reading.gas_ohms / 1000 : null;
  if (gasEl) gasEl.textContent = number(gasKohms, 1);
  const gasValidityResult = gasValidity(reading.gas_valid);
  const gasValidityEl = $("gas-validity");
  if (gasValidityEl) {
    gasValidityEl.querySelector(".text").textContent = gasValidityResult.label;
    gasValidityEl.className = `validity-indicator ${gasValidityResult.class}`;
  }

  // Detail fields (only on overview page)
  const nodeEl = $("node"); if (nodeEl) nodeEl.textContent = payload.node_id || "--";
  const routeEl = $("route"); if (routeEl) routeEl.textContent = payload.wifi_ssid || "--";
  const ipEl = $("ip"); if (ipEl) ipEl.textContent = payload.ip || "--";
  const seqEl = $("seq"); if (seqEl) seqEl.textContent = payload.seq ?? "--";
  const receivedEl = $("received"); if (receivedEl) receivedEl.textContent = timeLabel(record.received_at);
  const ageEl = $("age"); if (ageEl) ageEl.textContent = ageLabel(record.received_at);
  const forwardingEl = $("forwarding"); if (forwardingEl) forwardingEl.textContent = state.latest?.upstream?.last_ok === true ? "OK" : "local";

  // ESP32 Status
  const freeMemEl = $("free-mem"); if (freeMemEl) freeMemEl.textContent = compactNumber(payload.free_mem);
  const uptimeEl = $("uptime"); if (uptimeEl) uptimeEl.textContent = formatUptime(payload.uptime_ms);
  const wifiEl = $("wifi-ssid"); if (wifiEl) wifiEl.textContent = payload.wifi_ssid || "--";

  const subtitleEl = $("subtitle");
  if (subtitleEl) {
    const routeStr = payload.wifi_ssid ? `via ${payload.wifi_ssid}` : "route unknown";
    subtitleEl.textContent = `${payload.node_id || "sensor"} ${routeStr} - updated ${ageLabel(record.received_at)} ago`;
  }

  if (age === null) setLive("warn", "Waiting");
  else if (age < 120) setLive("ok", "Live");
  else if (age < 600) setLive("warn", "Recent");
  else setLive("bad", "Stale");
}

function renderSnapshots() {
  const snapshots = state.snapshots;
  const snapshotEl = $("snapshot");
  if (snapshotEl) snapshotEl.textContent = state.snapshotLatest
    ? timeLabel(state.snapshotLatest.snapshot_at)
    : "--";
  const nextSnapshotEl = $("next-snapshot");
  if (nextSnapshotEl) nextSnapshotEl.textContent = state.snapshotSchedule?.next_snapshot_at
    ? timeLabel(state.snapshotSchedule.next_snapshot_at)
    : "--";

  const chartItems = snapshots.map((snapshot) => snapshot.record);
  const current = state.latest?.reading;
  if (current) chartItems.push(current);

  // Overview page charts (4 small)
  if ($("temp-chart")) {
    drawChart($("temp-chart"), chartItems, (record) => getReading(record).temperature_f, "#70d46f", "F");
    drawChart($("humidity-chart"), chartItems, (record) => getReading(record).humidity_percent, "#72c8d6", "%");
    drawChart($("pressure-chart"), chartItems, (record) => getReading(record).pressure_hpa, "#e0bd63", " hPa");
    drawChart($("gas-chart"), chartItems, (record) => getReading(record).gas_ohms ? getReading(record).gas_ohms / 1000 : null, "#e16f63", " kΩ");
  }

  // Detail pages - single chart with duration filter
  renderDetailChart("temp-chart", chartItems, "temp-duration", "temp-trend-count", (r) => getReading(r).temperature_f, "F", "#70d46f");
  renderDetailChart("humidity-chart", chartItems, "humidity-duration", "humidity-trend-count", (r) => getReading(r).humidity_percent, "%", "#72c8d6");
  renderDetailChart("pressure-chart", chartItems, "pressure-duration", "pressure-trend-count", (r) => getReading(r).pressure_hpa, " hPa", "#e0bd63");
  renderDetailChart("gas-chart", chartItems, "gas-duration", "gas-trend-count", (r) => getReading(r).gas_ohms ? getReading(r).gas_ohms / 1000 : null, " kΩ", "#e16f63");

  // History page
  if (window.location.pathname === "/history") {
    renderHistoryPage();
    renderStorageStats();
  }
}

function getDurationMs(value) {
  if (value === "1h") return 60 * 60 * 1000;
  if (value === "6h") return 6 * 60 * 60 * 1000;
  if (value === "12h") return 12 * 60 * 60 * 1000;
  if (value === "24h") return 24 * 60 * 60 * 1000;
  if (value === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (value === "30d") return 30 * 24 * 60 * 60 * 1000;
  return Infinity; // "all"
}

function renderDetailChart(chartId, durationSelectId, countId, items, accessor, suffix, color) {
  const canvas = $(chartId);
  const select = $(durationSelectId);
  const countEl = $(countId);
  if (!canvas || !select) return;

  const durationMs = getDurationMs(select.value);
  const now = Date.now();
  const cutoff = durationMs === Infinity ? 0 : now - durationMs;
  
  const filteredItems = items.filter(item => {
    const ts = Date.parse(item.received_at);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  drawChart(canvas, filteredItems, accessor, color, suffix);
  if (countEl) countEl.textContent = `${filteredItems.length} snapshots (${select.options[select.selectedIndex].text})`;

  // Auto-attach change listener once
  if (!select.dataset.listener) {
    select.addEventListener("change", () => renderDetailChart(chartId, durationSelectId, countId, items, accessor, suffix, color));
    select.dataset.listener = "1";
  }
}

function renderHistoryPage() {
  const metricSelect = $("history-metric");
  const durationSelect = $("history-duration");
  const limitSelect = $("history-limit");
  const list = $("history-list");
  if (!list) return;

  const chartItems = state.snapshots.map(s => s.record);
  const current = state.latest?.reading;
  if (current) chartItems.push(current);

  function applyFilters() {
    const metric = metricSelect.value;
    const durationMs = getDurationMs(durationSelect.value);
    const limit = limitSelect.value === "all" ? Infinity : parseInt(limitSelect.value);
    const now = Date.now();
    const cutoff = durationMs === Infinity ? 0 : now - durationMs;

    let filtered = chartItems.filter(item => {
      const ts = Date.parse(item.received_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    // For "all" metric, we don't need to filter further, just use the record
    // For specific metric, we filter the display but still show all columns
    // The table will show all metrics regardless, just filtered by time

    if (!filtered.length) {
      list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--muted);">No snapshots in selected range</div>`;
      return;
    }

    filtered = filtered.slice().reverse().slice(0, limit);

    list.innerHTML = filtered.map((record) => {
      const payload = getPayload(record);
      const reading = getReading(record);
      const bucketTime = record.received_at ? Date.parse(record.received_at) / 1000 : null;
      const tempF = reading.temperature_f ? number(reading.temperature_f, 1) + "°F" : "--";
      const humidity = reading.humidity_percent ? number(reading.humidity_percent, 1) + "%" : "--";
      const pressure = reading.pressure_hpa ? number(reading.pressure_hpa, 1) + " hPa" : "--";
      const gas = reading.gas_ohms ? number(reading.gas_ohms / 1000, 1) + " kΩ" : "--";
      
      return `
        <article class="snapshot">
          <time>${bucketTime ? timeLabel(bucketTime) : "--"}</time>
          <b>${metric === "temperature" ? tempF : metric === "humidity" ? humidity : metric === "pressure" ? pressure : metric === "gas" ? gas : tempF}</b>
          <dl>
            <div><dt>Temp</dt><dd>${tempF}</dd></div>
            <div><dt>Humidity</dt><dd>${humidity}</dd></div>
            <div><dt>Pressure</dt><dd>${pressure}</dd></div>
            <div><dt>Gas</dt><dd>${gas}</dd></div>
            <div><dt>Route</dt><dd>${payload.wifi_ssid || "--"}</dd></div>
          </dl>
        </article>
      `;
    }).join("");
  }

  applyFilters();
  
  // Attach listeners once
  if (!metricSelect.dataset.listener) {
    metricSelect.addEventListener("change", applyFilters);
    durationSelect.addEventListener("change", applyFilters);
    limitSelect.addEventListener("change", applyFilters);
    metricSelect.dataset.listener = "1";
  }

  // Export button
  const exportBtn = $("history-export");
  if (exportBtn && !exportBtn.dataset.listener) {
    exportBtn.addEventListener("click", () => {
      const metric = metricSelect.value;
      const durationMs = getDurationMs(durationSelect.value);
      const limit = limitSelect.value === "all" ? Infinity : parseInt(limitSelect.value);
      const now = Date.now();
      const cutoff = durationMs === Infinity ? 0 : now - durationMs;

      let filtered = chartItems.filter(item => {
        const ts = Date.parse(item.received_at);
        return Number.isFinite(ts) && ts >= cutoff;
      });

      const csv = [
        "timestamp,temperature_f,humidity_percent,pressure_hpa,gas_kohms,wifi_ssid,node_id,free_mem,uptime_ms,seq",
        ...filtered.slice().reverse().slice(0, limit).map(record => {
          const payload = getPayload(record);
          const reading = getReading(record);
          return [
            record.received_at || "",
            reading.temperature_f || "",
            reading.humidity_percent || "",
            reading.pressure_hpa || "",
            reading.gas_ohms ? reading.gas_ohms / 1000 : "",
            payload.wifi_ssid || "",
            payload.node_id || "",
            payload.free_mem || "",
            payload.uptime_ms || "",
            payload.seq || ""
          ].join(",");
        })
      ].join("\n");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `greenhouse-history-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
    exportBtn.dataset.listener = "1";
  }
}

function renderStorageStats() {
  const container = $("storage-stats");
  if (!container) return;

  const snapshots = state.snapshots;
  const total = snapshots.length;
  const latest = snapshots[0]?.record?.received_at || "--";
  const oldest = snapshots[snapshots.length - 1]?.record?.received_at || "--";
  
  // Calculate approximate storage (rough estimate)
  const avgRecordSize = 500; // bytes per record (JSON)
  const estimatedBytes = total * avgRecordSize;
  const sizeStr = estimatedBytes > 1024 * 1024 
    ? (estimatedBytes / (1024 * 1024)).toFixed(2) + " MB"
    : estimatedBytes > 1024 
    ? (estimatedBytes / 1024).toFixed(1) + " KB"
    : estimatedBytes + " B";

  container.innerHTML = `
    <div class="stat-card"><dt>Total Snapshots</dt><dd>${total}</dd></div>
    <div class="stat-card"><dt>Latest</dt><dd>${timeLabel(latest)}</dd></div>
    <div class="stat-card"><dt>Oldest</dt><dd>${timeLabel(oldest)}</dd></div>
    <div class="stat-card"><dt>Est. Storage</dt><dd>${sizeStr}</dd></div>
  `;
}

function applyDashboardState(payload) {
  const latest = payload.latest || payload;
  const snapshotsPayload = payload.snapshots || {};
  state.latest = latest;
  // Handle both SSE format (snapshots: {snapshots: [...], latest, schedule}) and REST format (snapshots: [...])
  if (Array.isArray(snapshotsPayload)) {
    state.snapshots = snapshotsPayload;
    state.snapshotLatest = payload.latest || null;
    state.snapshotSchedule = payload.schedule || null;
  } else {
    state.snapshots = snapshotsPayload.snapshots || [];
    state.snapshotLatest = snapshotsPayload.latest || null;
    state.snapshotSchedule = snapshotsPayload.schedule || null;
  }
  state.lastRefresh = new Date(payload.streamed_at || Date.now());
  state.nowcast = payload.nowcast || state.nowcast;
  state.externalWeather = payload.external_weather || state.externalWeather;
  renderLatest();
  renderSnapshots();
  renderPredictions();
  renderNowcast();
  renderExternalWeather();
}

async function fetchJson(path) {
  const response = await fetch(path, {cache: "no-store"});
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function refresh() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const [latest, snapshots, nowcast] = await Promise.all([
      fetchJson("/api/latest"),
      fetchJson("/api/snapshots"),
      fetchJson("/api/nowcast"),
    ]);
    applyDashboardState({latest, snapshots, nowcast, streamed_at: new Date().toISOString()});
  } catch (error) {
    console.error("refresh error:", error);
    setLive("bad", "Offline");
    const sub = $("subtitle");
    if (sub) sub.textContent = error.message;
  } finally {
    state.refreshInFlight = false;
  }
}

function startPollingFallback() {
  if (state.streamFallbackTimer) return;
  state.streamFallbackTimer = setInterval(refresh, 15000);
}

function stopPollingFallback() {
  if (!state.streamFallbackTimer) return;
  clearInterval(state.streamFallbackTimer);
  state.streamFallbackTimer = null;
}

function startStream() {
  if (!window.EventSource) {
    refresh();
    startPollingFallback();
    return;
  }

  const events = new EventSource("/api/stream");
  events.addEventListener("state", (event) => {
    state.streamConnected = true;
    stopPollingFallback();
    try {
      applyDashboardState(JSON.parse(event.data));
    } catch (error) {
      console.error("SSE state handler error:", error);
      setLive("bad", "Bad data");
      const sub = $("subtitle");
      if (sub) sub.textContent = error.message;
    }
  });
  events.addEventListener("stream-error", (event) => {
    state.streamConnected = false;
    startPollingFallback();
    try {
      const payload = JSON.parse(event.data);
      setLive("bad", "Offline");
      const sub = $("subtitle");
      if (sub) sub.textContent = payload.error || "Stream interrupted";
    } catch {
      setLive("bad", "Offline");
    }
  });
  events.addEventListener("error", () => {
    state.streamConnected = false;
    startPollingFallback();
  });
}

const refreshBtn = $("refresh");
if (refreshBtn) refreshBtn.addEventListener("click", refresh);
startStream();
setInterval(renderLatest, 1000);

// Initial REST fetch for immediate data on page load (before SSE delivers)
refresh();

// Highlight active nav tab based on pathname
const path = window.location.pathname;
document.querySelectorAll(".nav-tabs a").forEach((a) => {
  const href = a.getAttribute("href");
  if ((path === "/" && href === "/") || (path !== "/" && path === href)) {
    a.classList.add("active");
  } else {
    a.classList.remove("active");
  }
});
