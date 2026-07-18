from machine import I2C, Pin
import time


SDA_PIN = 21
SCL_PIN = 22


i2c = I2C(0, sda=Pin(SDA_PIN), scl=Pin(SCL_PIN), freq=100000)
print("Scanning I2C bus on SDA GPIO%d / SCL GPIO%d..." % (SDA_PIN, SCL_PIN))
time.sleep(0.2)

devices = i2c.scan()
if not devices:
    print("No I2C devices found")
else:
    for addr in devices:
        print("Found I2C device: 0x%02x" % addr)
