# =====================================================================
#  WSKZ2026 AI-IoT — Модуль A (части A1+A2+A3). Парктроник
#  ESP32 + HC-SR04 + OLED + WS2812 (4 LED) + зуммер BEEP
#  A1: дальномер, OUT OF RANGE   A2: зоны, свет, звук   A3: медиана, шкала, журнал
# =====================================================================
import time
from machine import Pin, Timer
try:
    from machine import SoftI2C          # MicroPython >= 1.14
except ImportError:                      # 1.13 (прошивка набора ZL-02B)
    from machine import I2C

    def SoftI2C(scl, sda):
        return I2C(-1, scl=scl, sda=sda)

from neopixel import NeoPixel
import ssd1306
from HCSR04 import HCSR04

# ---------------- Константы ----------------
PIN_TRIG = 14
PIN_ECHO = 12
PIN_SDA = 23
PIN_SCL = 19
PIN_RGB = 25              # ОБЪЯВЛЯЕТ ЭКСПЕРТ
PIN_BEEP = 26             # ОБЪЯВЛЯЕТ ЭКСПЕРТ
BEEP_ON = 1               # уровень включения зуммера (у некоторых модулей 0!)
LED_N = 4

MEASURE_MS = 200
DIST_MIN = 2
DIST_MAX = 400
ZONE_STOP = 20            # < 20 см  -> STOP
ZONE_SAFE = 50            # > 50 см  -> SAFE, иначе WARN
FILTER_N = 5

BAR_X = 0
BAR_Y = 50
BAR_W = 122
BAR_H = 10
BAR_RANGE = 100

BEEP_ON_MS = 200          # WARN: 200 мс звук
BEEP_PERIOD_MS = 800      #       + 600 мс пауза

BRIGHT = 60               # яркость светодиодов 0..255
COLORS = {"SAFE": (0, BRIGHT, 0),          # зелёный
          "WARN": (BRIGHT, BRIGHT, 0),     # жёлтый
          "STOP": (BRIGHT, 0, 0)}          # красный
OFF = (0, 0, 0)

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
sensor = HCSR04(PIN_TRIG, PIN_ECHO)
np = NeoPixel(Pin(PIN_RGB), LED_N)
beep = Pin(PIN_BEEP, Pin.OUT, value=1 - BEEP_ON)   # сразу выключен

# ---------------- Состояние ----------------
buf = []
dist = None
zone = None               # None = OUT OF RANGE
zone_since = 0
tick = False


def set_leds(color):
    for i in range(LED_N):
        np[i] = color
    np.write()


def set_beep(on):
    beep.value(BEEP_ON if on else 1 - BEEP_ON)


def led_test():
    """A2: при запуске все 4 LED: красный, зелёный, синий по 0.5 с, затем гаснут."""
    for c in ((BRIGHT, 0, 0), (0, BRIGHT, 0), (0, 0, BRIGHT)):
        set_leds(c)
        time.sleep_ms(500)
    set_leds(OFF)


def read_cm():
    try:
        d = sensor.distance()      # метод из руководства ZL-02B (табл. 16-1)
    except Exception:
        return None
    if d is None or d < DIST_MIN or d > DIST_MAX:
        return None
    return d


def median(values):
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def zone_of(d):
    if d < ZONE_STOP:
        return "STOP"
    if d <= ZONE_SAFE:
        return "WARN"
    return "SAFE"


def draw():
    oled.fill(0)
    oled.text("HCSR04", 0, 0)
    if zone is None:
        oled.text("OUT OF RANGE", 0, 24)
    else:
        oled.text("Dist: %.1f cm" % dist, 0, 16)
        oled.text("ZONE: " + zone, 0, 32)
        fill = int(BAR_W * (BAR_RANGE - min(dist, BAR_RANGE)) / BAR_RANGE)
        oled.rect(BAR_X, BAR_Y, BAR_W, BAR_H, 1)
        oled.fill_rect(BAR_X, BAR_Y, fill, BAR_H, 1)
    oled.show()


def measure():
    global dist, zone, zone_since
    d = read_cm()
    old = zone
    if d is None:
        zone = None
        print("%d,-1,OUT" % time.ticks_ms())
    else:
        buf.append(d)
        if len(buf) > FILTER_N:
            buf.pop(0)
        dist = median(buf)                  # всё дальше — по медиане
        zone = zone_of(dist)
        print("%d,%.1f,%s" % (time.ticks_ms(), dist, zone))
    if zone != old:
        zone_since = time.ticks_ms()
        set_leds(COLORS[zone] if zone else OFF)
    draw()


def update_beep(now):
    if zone == "STOP":
        set_beep(True)                      # непрерывный
    elif zone == "WARN":
        phase = time.ticks_diff(now, zone_since) % BEEP_PERIOD_MS
        set_beep(phase < BEEP_ON_MS)        # 200 мс звук / 600 мс пауза
    else:
        set_beep(False)                     # SAFE и OUT OF RANGE


def on_timer(t):
    global tick
    tick = True


def main():
    global tick
    set_beep(False)
    led_test()
    timer = Timer(0)
    timer.init(period=MEASURE_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            if tick:
                tick = False
                measure()
            update_beep(time.ticks_ms())
        except Exception as e:
            print("ERR:", e)
        time.sleep_ms(10)


main()
