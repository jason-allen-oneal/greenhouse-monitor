"use strict";

const WET_STATES = new Set(["wet", "rain", "raining", "true", "1", "yes"]);

function getPayload(record) {
  return record && record.payload ? record.payload : {};
}

function getReading(record) {
  return getPayload(record).reading || {};
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wet(record) {
  const payload = getPayload(record);
  const reading = getReading(record);
  const state = String(payload.rain_sensor_state || reading.rain_sensor_state || "").trim().toLowerCase();
  if (WET_STATES.has(state)) return true;
  const value = num(payload.rain_sensor_value ?? reading.rain_sensor_value);
  return value !== null && value > 0;
}

function rowsFromState(latestPayload, snapshotsPayload) {
  const snapshots = Array.isArray(snapshotsPayload?.snapshots) ? snapshotsPayload.snapshots : [];
  const records = snapshots.map((snapshot) => snapshot.record).filter(Boolean);
  if (latestPayload?.reading) records.push(latestPayload.reading);
  const byTs = new Map();
  for (const record of records) {
    const ts = Date.parse(record.received_at);
    if (!Number.isFinite(ts)) continue;
    const reading = getReading(record);
    byTs.set(ts, {
      timestamp: new Date(ts).toISOString(),
      ts,
      device_id: getPayload(record).node_id || "esp32-greenhouse-1",
      bme680_temperature: num(reading.temperature_c),
      bme680_humidity: num(reading.humidity_percent),
      bme680_pressure: num(reading.pressure_hpa),
      bme680_gas_resistance: num(reading.gas_ohms),
      rain_sensor_wet: wet(record),
      raw: record,
    });
  }
  return Array.from(byTs.values())
    .filter((row) => row.bme680_temperature !== null && row.bme680_humidity !== null && row.bme680_pressure !== null)
    .sort((a, b) => a.ts - b.ts);
}

function valueAtOrBefore(rows, ts, toleranceMs = 8 * 60 * 1000) {
  let best = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].ts <= ts) {
      best = rows[i];
      break;
    }
  }
  if (!best || Math.abs(best.ts - ts) > toleranceMs) return null;
  return best;
}

function average(rows, field, sinceTs) {
  const values = rows.filter((row) => row.ts >= sinceTs).map((row) => row[field]).filter((v) => v !== null);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function slope(rows, field, sinceTs) {
  const points = rows.filter((row) => row.ts >= sinceTs && row[field] !== null);
  if (points.length < 2) return null;
  const firstTs = points[0].ts;
  const xs = points.map((p) => (p.ts - firstTs) / 3600000);
  const ys = points.map((p) => p[field]);
  const n = points.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (!denom) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function delta(rows, latest, field, minutes) {
  const previous = valueAtOrBefore(rows, latest.ts - minutes * 60 * 1000);
  if (!previous || previous[field] === null || latest[field] === null) return null;
  return latest[field] - previous[field];
}

function dewPoint(tempC, humidity) {
  if (tempC === null || humidity === null || humidity <= 0) return null;
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(humidity / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

function absoluteHumidity(tempC, humidity) {
  if (tempC === null || humidity === null) return null;
  const saturation = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  const actual = (humidity / 100) * saturation;
  return 216.74 * actual / (273.15 + tempC);
}

function season(month) {
  if ([12, 1, 2].includes(month)) return "winter";
  if ([3, 4, 5].includes(month)) return "spring";
  if ([6, 7, 8].includes(month)) return "summer";
  return "fall";
}

function buildFeatures(rows) {
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  const now = latest.ts;
  const recentWet = (minutes) => rows.some((row) => row.ts >= now - minutes * 60000 && row.rain_sensor_wet);
  const previous = rows[rows.length - 2];
  const dt = new Date(now);
  return {
    timestamp: latest.timestamp,
    device_id: latest.device_id,
    pressure_now: latest.bme680_pressure,
    pressure_delta_15m: delta(rows, latest, "bme680_pressure", 15),
    pressure_delta_30m: delta(rows, latest, "bme680_pressure", 30),
    pressure_delta_1h: delta(rows, latest, "bme680_pressure", 60),
    pressure_delta_3h: delta(rows, latest, "bme680_pressure", 180),
    pressure_delta_6h: delta(rows, latest, "bme680_pressure", 360),
    pressure_rolling_avg_1h: average(rows, "bme680_pressure", now - 60 * 60000),
    pressure_rolling_avg_3h: average(rows, "bme680_pressure", now - 180 * 60000),
    pressure_rolling_slope_3h: slope(rows, "bme680_pressure", now - 180 * 60000),
    humidity_now: latest.bme680_humidity,
    humidity_delta_15m: delta(rows, latest, "bme680_humidity", 15),
    humidity_delta_1h: delta(rows, latest, "bme680_humidity", 60),
    humidity_delta_3h: delta(rows, latest, "bme680_humidity", 180),
    humidity_rolling_avg_1h: average(rows, "bme680_humidity", now - 60 * 60000),
    humidity_rolling_avg_3h: average(rows, "bme680_humidity", now - 180 * 60000),
    temperature_now: latest.bme680_temperature,
    temperature_delta_15m: delta(rows, latest, "bme680_temperature", 15),
    temperature_delta_1h: delta(rows, latest, "bme680_temperature", 60),
    temperature_delta_3h: delta(rows, latest, "bme680_temperature", 180),
    temperature_rolling_avg_1h: average(rows, "bme680_temperature", now - 60 * 60000),
    temperature_rolling_avg_3h: average(rows, "bme680_temperature", now - 180 * 60000),
    rain_sensor_now: latest.rain_sensor_wet ? 1 : 0,
    rain_sensor_wet_now: latest.rain_sensor_wet,
    rain_sensor_wet_last_30m: recentWet(30),
    rain_sensor_wet_last_1h: recentWet(60),
    rain_sensor_wet_last_3h: recentWet(180),
    rain_sensor_transitioned_to_wet: Boolean(latest.rain_sensor_wet && previous && !previous.rain_sensor_wet),
    dew_point: dewPoint(latest.bme680_temperature, latest.bme680_humidity),
    absolute_humidity: absoluteHumidity(latest.bme680_temperature, latest.bme680_humidity),
    temp_humidity_spread: latest.bme680_temperature - latest.bme680_humidity,
    pressure_humidity_interaction: latest.bme680_pressure * latest.bme680_humidity,
    hour_of_day: dt.getUTCHours(),
    day_of_week: dt.getUTCDay(),
    month: dt.getUTCMonth() + 1,
    season: season(dt.getUTCMonth() + 1),
    snapshot_count: rows.length,
  };
}

function predictLinear(rows, field, hours) {
  const recent = rows.slice(-96).filter((row) => row[field] !== null);
  if (recent.length < 3) return 0;
  const fieldSlope = slope(recent, field, recent[0].ts);
  return fieldSlope === null ? 0 : fieldSlope * hours;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function externalPrecipProbability(external, horizonHours) {
  const openMeteo = external?.sources?.open_meteo;
  const nws = external?.sources?.nws;
  const om = horizonHours <= 1
    ? openMeteo?.hourly?.precipitation_probability_next_1h
    : openMeteo?.hourly?.precipitation_probability_next_3h;
  const nwsPeriod = nws?.hourly?.[horizonHours <= 1 ? 0 : Math.min(2, (nws.hourly || []).length - 1)];
  const nwsPop = nwsPeriod?.probability_of_precipitation;
  const values = [om, nwsPop].map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return clamp((values.reduce((a, b) => a + b, 0) / values.length) / 100);
}

function rainProbability(features, horizonHours, external = null) {
  if (!features) return 0;
  if (features.rain_sensor_wet_now) return horizonHours <= 1 ? 0.9 : 0.85;
  if (features.rain_sensor_wet_last_1h) return horizonHours <= 1 ? 0.65 : 0.7;
  let score = 0.04;
  const p3 = features.pressure_delta_3h ?? 0;
  const p1 = features.pressure_delta_1h ?? 0;
  const h1 = features.humidity_delta_1h ?? 0;
  const slope3 = features.pressure_rolling_slope_3h ?? 0;
  if (p3 <= -2.5) score += 0.28;
  else if (p3 <= -1.5) score += 0.18;
  else if (p3 <= -0.8) score += 0.08;
  if (p1 <= -0.8) score += 0.12;
  if (slope3 <= -0.6) score += 0.12;
  if (h1 >= 6) score += 0.16;
  else if (h1 >= 3) score += 0.08;
  if (features.humidity_now >= 90) score += 0.12;
  else if (features.humidity_now >= 80) score += 0.05;
  if (horizonHours === 3) score += 0.05;
  const localProbability = clamp(score);
  const externalProbability = externalPrecipProbability(external, horizonHours);
  if (externalProbability === null) return localProbability;
  // Local greenhouse trends stay primary, public forecast supplements them.
  return clamp(localProbability * 0.65 + externalProbability * 0.35);
}

function externalSignals(external) {
  const signals = [];
  const openMeteo = external?.sources?.open_meteo;
  const nws = external?.sources?.nws;
  const pop1 = openMeteo?.hourly?.precipitation_probability_next_1h;
  const pop3 = openMeteo?.hourly?.precipitation_probability_next_3h;
  if (Number.isFinite(Number(pop1)) && Number(pop1) >= 40) signals.push(`Open-Meteo shows ${Math.round(Number(pop1))}% precipitation chance next hour`);
  else if (Number.isFinite(Number(pop3)) && Number(pop3) >= 40) signals.push(`Open-Meteo shows ${Math.round(Number(pop3))}% precipitation chance within 3 hours`);
  const nwsPeriod = nws?.hourly?.[0];
  if (nwsPeriod?.short_forecast) signals.push(`NWS hourly: ${nwsPeriod.short_forecast}`);
  if ((nws?.alerts || []).length) signals.push(`${nws.alerts.length} active NWS alert${nws.alerts.length === 1 ? "" : "s"}`);
  return signals;
}

function topSignals(features, external = null) {
  if (!features) return ["collecting local sensor history"];
  const signals = [];
  if ((features.pressure_delta_3h ?? 0) <= -1.5) signals.push("pressure dropped over the last 3 hours");
  else if ((features.pressure_rolling_slope_3h ?? 0) < -0.4) signals.push("pressure trend is falling");
  if ((features.humidity_delta_1h ?? 0) >= 5) signals.push("humidity increased over the last hour");
  if (features.rain_sensor_wet_now) signals.push("rain sensor is currently wet");
  else if (features.rain_sensor_wet_last_3h) signals.push("rain sensor recently showed wet readings");
  signals.push(...externalSignals(external));
  if (!signals.length) signals.push("local sensor trends are relatively steady");
  return signals.slice(0, 5);
}

function riskWord(probability) {
  if (probability >= 0.7) return "high";
  if (probability >= 0.45) return "elevated";
  if (probability >= 0.2) return "moderate";
  return "low";
}

function buildNowcast(latestPayload, snapshotsPayload, externalWeather = null) {
  const rows = rowsFromState(latestPayload, snapshotsPayload);
  const features = buildFeatures(rows);
  if (!features) {
    return {
      ok: false,
      error: "no valid greenhouse snapshots available for local nowcast",
      model_version: "greenhouse-local-nowcast-v1",
    };
  }
  const output = {
    timestamp: features.timestamp,
    rain_next_30m_probability: rainProbability(features, 0.5, externalWeather),
    rain_next_1h_probability: rainProbability(features, 1, externalWeather),
    rain_next_3h_probability: rainProbability(features, 3, externalWeather),
    storm_risk: "unknown",
    temperature_change_next_1h: predictLinear(rows, "bme680_temperature", 1),
    humidity_change_next_1h: predictLinear(rows, "bme680_humidity", 1),
    pressure_change_next_1h: predictLinear(rows, "bme680_pressure", 1),
    top_signals: topSignals(features, externalWeather),
    model_version: externalWeather?.ok ? "greenhouse-local-nowcast-v1+open-meteo+nws" : "greenhouse-local-nowcast-v1",
    basis: externalWeather?.ok
      ? "local greenhouse BME680 15-minute snapshots supplemented by Open-Meteo/NWS"
      : "local greenhouse BME680 15-minute snapshots",
    training_status: rows.some((row) => row.rain_sensor_wet)
      ? "rain sensor labels available for baseline evaluation"
      : "waiting for rain sensor wet/dry labels before trained rain classifier",
    snapshot_count: rows.length,
    external_weather: externalWeather ? {
      ok: Boolean(externalWeather.ok),
      configured: Boolean(externalWeather.configured),
      open_meteo: externalWeather.sources?.open_meteo || null,
      nws: externalWeather.sources?.nws || null,
      errors: externalWeather.errors || [],
    } : null,
    features,
  };
  output.explanation = `Local greenhouse nowcast: rain risk is ${riskWord(output.rain_next_1h_probability)} over the next hour. Signals: ${output.top_signals.join(", ")}. Storm risk is unknown because lightning or official alert data has not been integrated. This is experimental local sensor data only, not an official forecast; NWS alerts take precedence.`;
  return { ok: true, prediction: output };
}

module.exports = { buildNowcast };
