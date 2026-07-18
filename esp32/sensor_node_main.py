import gc
import json
import machine
import network
import socket
import time
import ubinascii
from machine import I2C, Pin, WDT

try:
    from secrets import NETWORKS
except ImportError:
    NETWORKS = [
        ("GREENHOUSE_WIFI", "CHANGE_ME"),
        ("FALLBACK_WIFI", "CHANGE_ME"),
    ]

RECEIVER_URLS = {
    # Primary path: ESP32 joins GREENHOUSE_EDGE's GREENHOUSE_WIFI AP; GREENHOUSE_EDGE bridges/forwards over Ethernet.
    "GREENHOUSE_WIFI": ("GREENHOUSE_AP_IP", 8080),
    # Fallback path: if GREENHOUSE_EDGE AP is unavailable, ESP32 joins house WiFi and posts direct to SENSOR_RECEIVER.
    "FALLBACK_WIFI": ("RECEIVER_IP", 8081),
}

NODE_ID = "esp32-greenhouse-1"
SDA_PIN = 21
SCL_PIN = 22
READ_INTERVAL_S = 30
MAX_POST_FAILURES = 3
MAX_WIFI_RECONNECT_ATTEMPTS = 5
WDT_TIMEOUT_MS = 120000  # 2 min - longer than read+post cycle

SENSOR_ERROR_COUNT = 0
MAX_SENSOR_ERRORS = 5


def blink(times=1, on_ms=80, off_ms=80):
    led = machine.PWM(machine.Pin(2), freq=1)
    for _ in range(times):
        led.duty(512)
        time.sleep_ms(on_ms)
        led.duty(0)
        time.sleep_ms(off_ms)
    led.deinit()


def scan_ssids(wlan):
    found = []
    try:
        for net in wlan.scan():
            ssid = net[0].decode() if isinstance(net[0], bytes) else str(net[0])
            found.append(ssid)
            print("AP:", ssid, "channel:", net[2], "rssi:", net[3], "auth:", net[4])
    except Exception as exc:
        print("Scan failed:", repr(exc))
    return found


def ensure_wifi(wlan, ssid, password):
    """Reconnect WiFi if disconnected. Returns (wlan, True/False)."""
    if wlan.isconnected():
        return wlan, True
    
    print("WiFi disconnected, attempting reconnect...")
    wlan.disconnect()
    time.sleep(1)
    wlan.connect(ssid, password)
    for attempt in range(MAX_WIFI_RECONNECT_ATTEMPTS):
        if wlan.isconnected():
            print("Reconnected:", ssid, wlan.ifconfig())
            return wlan, True
        print(f"  reconnect attempt {attempt + 1}/{MAX_WIFI_RECONNECT_ATTEMPTS}")
        time.sleep(2)
    print("WiFi reconnect failed")
    return wlan, False


def connect_wifi():
    ap = network.WLAN(network.AP_IF)
    try:
        ap.active(False)
    except Exception:
        pass

    wlan = network.WLAN(network.STA_IF)
    wlan.active(False)
    time.sleep(1)
    wlan.active(True)
    time.sleep(2)

    print("MAC:", ubinascii.hexlify(wlan.config("mac")).decode())
    available = scan_ssids(wlan)

    for ssid, password in NETWORKS:
        if ssid not in available:
            continue
        print("Connecting to WiFi:", ssid)
        try:
            wlan.disconnect()
        except Exception:
            pass
        time.sleep(0.5)
        wlan.connect(ssid, password)
        for second in range(20):
            if wlan.isconnected():
                print("Connected:", ssid, wlan.ifconfig())
                return wlan, ssid
            print("Waiting...", second + 1, "status:", wlan.status())
            time.sleep(1)
        print("Failed:", ssid, "status:", wlan.status())
        try:
            wlan.disconnect()
        except Exception:
            pass
        time.sleep(1)
    return wlan, None


def init_sensor():
    i2c = I2C(0, sda=Pin(SDA_PIN), scl=Pin(SCL_PIN), freq=100000)
    print("I2C devices:", ["0x%02x" % addr for addr in i2c.scan()])

    module = None
    for module_name in ("azbme680", "bme680"):
        try:
            module = __import__(module_name)
            print("Loaded sensor module:", module_name)
            break
        except ImportError:
            pass
    if module is None:
        print("Missing azbme680.py or bme680.py driver on ESP32")
        return None

    for name in ("BME680_I2C", "BME680"):
        cls = getattr(module, name, None)
        if cls is None:
            continue
        try:
            sensor = cls(i2c=i2c)
        except TypeError:
            try:
                sensor = cls(i2c)
            except Exception as exc:
                print("Sensor init failed with", name, repr(exc))
                continue
        except Exception as exc:
            print("Sensor init failed with", name, repr(exc))
            continue
        print("Sensor ready with driver class:", name)
        return sensor

    print("bme680.py did not expose BME680_I2C or BME680")
    return None


def read_attr(sensor, names):
    for name in names:
        if hasattr(sensor, name):
            value = getattr(sensor, name)
            return value() if callable(value) else value
    return None


def read_sensor(sensor):
    if hasattr(sensor, "measure") and callable(sensor.measure):
        try:
            sensor.measure(gas=True)
        except TypeError:
            sensor.measure()
    elif hasattr(sensor, "forced_read") and callable(sensor.forced_read):
        sensor.forced_read()

    gas = read_attr(sensor, ("gas", "gas_resistance"))
    if isinstance(gas, dict):
        gas_ohms = gas.get("ohms")
        gas_valid = gas.get("valid")
    else:
        gas_ohms = gas
        gas_valid = None

    return {
        "temperature_c": read_attr(sensor, ("temperature", "temperature_c")),
        "humidity_percent": read_attr(sensor, ("humidity", "relative_humidity")),
        "pressure_hpa": read_attr(sensor, ("pressure", "pressure_hpa")),
        "gas_ohms": gas_ohms,
        "gas_valid": gas_valid,
    }


def post_json(host, port, path, payload):
    body = json.dumps(payload)
    addr = socket.getaddrinfo(host, port)[0][-1]
    sock = socket.socket()
    try:
        sock.settimeout(6)
        sock.connect(addr)
        request = (
            "POST %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: %d\r\n"
            "Connection: close\r\n\r\n%s"
        ) % (path, host, port, len(body), body)
        sock.send(request.encode())
        response = sock.recv(128)
        print("POST response:", response)
        return response.startswith(b"HTTP/1.1 200") or response.startswith(b"HTTP/1.0 200")
    finally:
        sock.close()


def main():
    wlan, ssid = connect_wifi()
    sensor = init_sensor()
    if ssid is None:
        print("No WiFi joined; rebooting in 30s")
        time.sleep(30)
        machine.reset()
    if sensor is None:
        print("No BME680 sensor driver/device ready; rebooting in 30s")
        time.sleep(30)
        machine.reset()

    # Start watchdog
    wdt = WDT(timeout=WDT_TIMEOUT_MS)
    print(f"Watchdog started ({WDT_TIMEOUT_MS}ms)")

    host, port = RECEIVER_URLS.get(ssid, RECEIVER_URLS["FALLBACK_WIFI"])
    password = next((pw for s, pw in NETWORKS if s == ssid), None)
    seq = 0
    consecutive_post_failures = 0
    sensor_error_count = 0

    while True:
        try:
            # Feed watchdog early
            wdt.feed()
            
            # Ensure WiFi is connected
            wlan, wifi_ok = ensure_wifi(wlan, ssid, password)
            if not wifi_ok:
                print("WiFi lost, resetting...")
                machine.reset()
            
            # Read sensor with error handling
            try:
                reading = read_sensor(sensor)
                sensor_error_count = 0
            except Exception as exc:
                sensor_error_count += 1
                print(f"Sensor read error ({sensor_error_count}/{MAX_SENSOR_ERRORS}):", repr(exc))
                blink(3, on_ms=100, off_ms=50)
                if sensor_error_count >= MAX_SENSOR_ERRORS:
                    print("Too many sensor errors, resetting...")
                    machine.reset()
                time.sleep(READ_INTERVAL_S)
                continue

            seq += 1
            payload = {
                "node_id": NODE_ID,
                "seq": seq,
                "wifi_ssid": ssid,
                "ip": wlan.ifconfig()[0],
                "uptime_ms": time.ticks_ms(),
                "free_mem": gc.mem_free(),
                "reading": reading,
            }
            print("Reading:", payload)

            # POST with retry
            ok = False
            for attempt in range(3):
                try:
                    ok = post_json(host, port, "/api/readings", payload)
                    if ok:
                        break
                except Exception as exc:
                    print(f"POST attempt {attempt + 1}/3 failed:", repr(exc))
                    time.sleep(1)
            
            if ok:
                consecutive_post_failures = 0
                blink(2)
            else:
                consecutive_post_failures += 1
                print(f"POST failed ({consecutive_post_failures}/{MAX_POST_FAILURES})")
                blink(1, on_ms=300, off_ms=100)
                if consecutive_post_failures >= MAX_POST_FAILURES:
                    print("Too many POST failures, forcing WiFi reconnect...")
                    wlan.disconnect()
                    time.sleep(2)
            
            # Feed watchdog before sleep
            wdt.feed()
            time.sleep(READ_INTERVAL_S)

        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print("Main loop error:", repr(exc))
            blink(5, on_ms=50, off_ms=50)
            time.sleep(5)


main()
