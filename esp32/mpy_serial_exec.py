#!/usr/bin/env python3
import argparse
import sys
import time

import serial


def read_until(ser, marker, timeout=5):
    deadline = time.time() + timeout
    data = b""
    while time.time() < deadline:
        chunk = ser.read(1)
        if chunk:
            data += chunk
            if marker in data:
                return data
        else:
            time.sleep(0.01)
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("code", nargs="?")
    args = parser.parse_args()

    code = args.code if args.code is not None else sys.stdin.read()
    if not code.endswith("\n"):
        code += "\n"

    with serial.Serial(args.port, args.baud, timeout=0.05, write_timeout=2) as ser:
        ser.write(b"\x03\x03")
        time.sleep(0.2)
        ser.reset_input_buffer()
        ser.write(b"\x01")
        banner = read_until(ser, b">", timeout=5)
        if b"raw REPL" not in banner:
            sys.stderr.write(banner.decode(errors="replace"))
            sys.stderr.write("\nfailed to enter raw REPL\n")
            return 2
        ser.write(code.encode())
        ser.write(b"\x04")
        output = read_until(ser, b"\x04", timeout=20)
        sys.stdout.write(output.replace(b"\x04", b"").decode(errors="replace"))
        ser.write(b"\x02")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
