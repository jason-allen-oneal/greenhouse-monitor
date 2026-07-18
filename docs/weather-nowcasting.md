# Weather nowcasting

This is experimental local sensor-based nowcasting, not an official forecast.

Inputs:

- BME680 temperature, humidity, pressure, and gas resistance
- 15-minute historical snapshots from the greenhouse receiver
- Optional public weather supplement from Open-Meteo and NWS

Rules:

- Local sensor trends remain primary.
- Open-Meteo/NWS data supplements local probabilities and explanations.
- NWS alerts are displayed separately and must not be overridden.
- Storm risk remains `unknown` until lightning sensor data or official severe-weather data is integrated.
- Do not use this for life-safety severe-weather decisions.
