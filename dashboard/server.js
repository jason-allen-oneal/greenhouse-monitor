#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildNowcast } = require("./nowcast");
const { fetchExternalWeather } = require("./weather_external");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5179);
const SENSOR_RECEIVER = process.env.SENSOR_RECEIVER_URL || "http://SENSOR_RECEIVER.lan:8081";
const PUBLIC_DIR = path.join(__dirname, "public");
let externalWeatherCache = { value: null, fetchedAt: 0 };
const EXTERNAL_WEATHER_CACHE_MS = Number(process.env.EXTERNAL_WEATHER_CACHE_MS || 10 * 60 * 1000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function proxy(res, targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${SENSOR_RECEIVER}${targetPath}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    send(res, 502, JSON.stringify({
      ok: false,
      error: error.name === "AbortError" ? "SENSOR_RECEIVER request timed out" : error.message,
      target: SENSOR_RECEIVER,
    }), "application/json; charset=utf-8");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSensorReceiverJson(targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${SENSOR_RECEIVER}${targetPath}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${targetPath} returned ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getExternalWeatherCached(force = false) {
  const now = Date.now();
  if (!force && externalWeatherCache.value && now - externalWeatherCache.fetchedAt < EXTERNAL_WEATHER_CACHE_MS) {
    return externalWeatherCache.value;
  }
  const value = await fetchExternalWeather();
  externalWeatherCache = { value, fetchedAt: now };
  return value;
}

async function readNowcast() {
  const [latest, snapshots, externalWeather] = await Promise.all([
    fetchSensorReceiverJson("/latest.json"),
    fetchSensorReceiverJson("/snapshots.json"),
    getExternalWeatherCached(),
  ]);
  return buildNowcast(latest, snapshots, externalWeather);
}

async function servePage(req, res, page) {
  const filePath = path.join(PUBLIC_DIR, `${page}.html`);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, TYPES[".html"]);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, TYPES[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  
  // API routes
  if (url.pathname === "/api/latest") {
    proxy(res, "/latest.json");
    return;
  }
  if (url.pathname === "/api/snapshots") {
    proxy(res, "/snapshots.json");
    return;
  }
  if (url.pathname === "/api/health") {
    proxy(res, "/health");
    return;
  }
  if (url.pathname === "/api/nowcast") {
    readNowcast()
      .then((payload) => send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8"))
      .catch((error) => send(res, 502, JSON.stringify({
        ok: false,
        error: error.name === "AbortError" ? "SENSOR_RECEIVER request timed out" : error.message,
        target: SENSOR_RECEIVER,
      }), "application/json; charset=utf-8"));
    return;
  }
  if (url.pathname === "/api/external-weather") {
    getExternalWeatherCached(url.searchParams.get("refresh") === "1")
      .then((payload) => send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8"))
      .catch((error) => send(res, 502, JSON.stringify({ ok: false, error: error.message }), "application/json; charset=utf-8"));
    return;
  }
  if (url.pathname === "/api/stream") {
    streamDashboard(req, res);
    return;
  }

  // Page routes
  if (url.pathname === "/" || url.pathname === "/index.html") {
    servePage(req, res, "index");
    return;
  }
  if (url.pathname === "/temperature") {
    servePage(req, res, "temperature");
    return;
  }
  if (url.pathname === "/humidity") {
    servePage(req, res, "humidity");
    return;
  }
  if (url.pathname === "/pressure") {
    servePage(req, res, "pressure");
    return;
  }
  if (url.pathname === "/gas") {
    servePage(req, res, "gas");
    return;
  }
  if (url.pathname === "/history") {
    servePage(req, res, "history");
    return;
  }

  serveStatic(req, res);
});

async function readDashboardState() {
  const [latest, snapshots, externalWeather] = await Promise.all([
    fetchSensorReceiverJson("/latest.json"),
    fetchSensorReceiverJson("/snapshots.json"),
    getExternalWeatherCached(),
  ]);
  return {
    ok: true,
    latest,
    snapshots,
    nowcast: buildNowcast(latest, snapshots, externalWeather),
    external_weather: externalWeather,
    streamed_at: new Date().toISOString(),
  };
}

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamDashboard(req, res) {
  req.socket.setTimeout(0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  let stopped = false;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      sendEvent(res, "state", await readDashboardState());
    } catch (error) {
      sendEvent(res, "stream-error", {
        ok: false,
        error: error.name === "AbortError" ? "SENSOR_RECEIVER request timed out" : error.message,
        streamed_at: new Date().toISOString(),
      });
    } finally {
      inFlight = false;
    }
  }

  tick();
  const interval = setInterval(tick, 5000);
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25000);

  req.on("close", () => {
    stopped = true;
    clearInterval(interval);
    clearInterval(heartbeat);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`GREENHOUSE_WIFI dashboard: http://${HOST}:${PORT}`);
  console.log(`Proxying SENSOR_RECEIVER: ${SENSOR_RECEIVER}`);
});
