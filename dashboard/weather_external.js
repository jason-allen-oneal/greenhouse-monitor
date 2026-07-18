"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS || 5000);
const CONFIG_PATH = process.env.GREENHOUSE_WEATHER_CONFIG || path.join(__dirname, "greenhouse-weather.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

const CONFIG = readConfig();
const LAT = process.env.GREENHOUSE_LAT || process.env.WEATHER_LAT || String(CONFIG.latitude || "");
const LON = process.env.GREENHOUSE_LON || process.env.WEATHER_LON || String(CONFIG.longitude || "");
const LOCATION_LABEL = process.env.GREENHOUSE_LOCATION_LABEL || CONFIG.label || "greenhouse";
const USER_AGENT = process.env.NWS_USER_AGENT || "greenhouse-local-nowcast/1.0 (local dashboard)";

function configured() {
  return LAT.trim() !== "" && LON.trim() !== "" && Number.isFinite(Number(LAT)) && Number.isFinite(Number(LON));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/geo+json, application/json",
        "User-Agent": USER_AGENT,
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isoHour(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13);
}

function hourlyValue(openMeteo, name, offsetHours) {
  const times = openMeteo?.hourly?.time || [];
  const values = openMeteo?.hourly?.[name] || [];
  const target = new Date(Date.now() + offsetHours * 3600000);
  const targetHour = isoHour(target);
  let idx = times.findIndex((time) => time.startsWith(targetHour));
  if (idx < 0) {
    const now = Date.now();
    idx = times.findIndex((time) => Date.parse(time) >= now + offsetHours * 3600000 - 1800000);
  }
  if (idx < 0 || idx >= values.length) return null;
  const parsed = Number(values[idx]);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeOpenMeteo(data) {
  return {
    source: "open-meteo",
    current: data.current ? {
      temperature_2m_c: data.current.temperature_2m ?? null,
      relative_humidity_2m: data.current.relative_humidity_2m ?? null,
      pressure_msl_hpa: data.current.pressure_msl ?? null,
      surface_pressure_hpa: data.current.surface_pressure ?? null,
      precipitation_mm: data.current.precipitation ?? null,
      rain_mm: data.current.rain ?? null,
      showers_mm: data.current.showers ?? null,
      weather_code: data.current.weather_code ?? null,
      wind_speed_10m_kmh: data.current.wind_speed_10m ?? null,
      wind_gusts_10m_kmh: data.current.wind_gusts_10m ?? null,
    } : null,
    hourly: {
      precipitation_probability_next_1h: hourlyValue(data, "precipitation_probability", 1),
      precipitation_probability_next_3h: hourlyValue(data, "precipitation_probability", 3),
      precipitation_mm_next_1h: hourlyValue(data, "precipitation", 1),
      precipitation_mm_next_3h: hourlyValue(data, "precipitation", 3),
      cape_next_1h: hourlyValue(data, "cape", 1),
      cloud_cover_next_1h: hourlyValue(data, "cloud_cover", 1),
    },
    fetched_at: new Date().toISOString(),
  };
}

async function fetchOpenMeteo() {
  const params = new URLSearchParams({
    latitude: LAT,
    longitude: LON,
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "rain",
      "showers",
      "weather_code",
      "pressure_msl",
      "surface_pressure",
      "wind_speed_10m",
      "wind_gusts_10m",
    ].join(","),
    hourly: [
      "precipitation_probability",
      "precipitation",
      "rain",
      "showers",
      "cloud_cover",
      "cape",
      "pressure_msl",
      "surface_pressure",
      "relative_humidity_2m",
      "temperature_2m",
    ].join(","),
    forecast_days: "2",
    timezone: "auto",
  });
  return summarizeOpenMeteo(await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`));
}

async function fetchNws() {
  const point = await fetchJson(`https://api.weather.gov/points/${LAT},${LON}`);
  const props = point.properties || {};
  const [forecastHourly, alerts] = await Promise.all([
    props.forecastHourly ? fetchJson(props.forecastHourly) : Promise.resolve(null),
    fetchJson(`https://api.weather.gov/alerts/active?point=${LAT},${LON}`),
  ]);
  const periods = forecastHourly?.properties?.periods || [];
  const activeAlerts = (alerts?.features || []).map((feature) => ({
    event: feature.properties?.event || "Alert",
    severity: feature.properties?.severity || "Unknown",
    urgency: feature.properties?.urgency || "Unknown",
    headline: feature.properties?.headline || feature.properties?.event || "NWS alert",
    effective: feature.properties?.effective || null,
    expires: feature.properties?.expires || null,
  }));
  return {
    source: "nws",
    grid: props.gridId ? `${props.gridId}/${props.gridX},${props.gridY}` : null,
    relative_location: props.relativeLocation?.properties ? {
      city: props.relativeLocation.properties.city,
      state: props.relativeLocation.properties.state,
      distance_m: props.relativeLocation.properties.distance?.value ?? null,
      bearing_deg: props.relativeLocation.properties.bearing?.value ?? null,
    } : null,
    hourly: periods.slice(0, 6).map((period) => ({
      start_time: period.startTime,
      temperature_f: period.temperature,
      short_forecast: period.shortForecast,
      probability_of_precipitation: period.probabilityOfPrecipitation?.value ?? null,
      wind_speed: period.windSpeed,
      wind_direction: period.windDirection,
    })),
    alerts: activeAlerts,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchExternalWeather() {
  if (!configured()) {
    return {
      ok: false,
      configured: false,
      error: "Set GREENHOUSE_LAT and GREENHOUSE_LON to enable Open-Meteo and NWS weather supplement.",
      sources: {},
    };
  }
  const [openMeteoResult, nwsResult] = await Promise.allSettled([fetchOpenMeteo(), fetchNws()]);
  const sources = {};
  const errors = [];
  if (openMeteoResult.status === "fulfilled") sources.open_meteo = openMeteoResult.value;
  else errors.push(`open-meteo: ${openMeteoResult.reason.message}`);
  if (nwsResult.status === "fulfilled") sources.nws = nwsResult.value;
  else errors.push(`nws: ${nwsResult.reason.message}`);
  return {
    ok: Object.keys(sources).length > 0,
    configured: true,
    latitude: Number(LAT),
    longitude: Number(LON),
    location_label: LOCATION_LABEL,
    sources,
    errors,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { fetchExternalWeather };
