# =====================================================================
#  WSKZ2026 IIoT — Модуль B1. Контроль загазованности
#  ESP32 + MQ-2 (АЦП) + WS2812 (4 светодиода) + OLED + ИИ-сервис
#  Этапы: прогрев 30 с -> фон 60 с -> ИИ-порог -> измерение/тревога
# =====================================================================
import time
import json
import gc
import network
from machine import Pin, SoftI2C, ADC, Timer
from neopixel import NeoPixel
import ssd1306

try:
    import requests
except ImportError:
    import urequests as requests

try:
    import secrets
except ImportError:
    secrets = None

# ---------------- Константы ----------------
STATION = "XX"
PIN_SDA = 23
PIN_SCL = 19
PIN_GAS = 34              # ADC1, вход
PIN_RGB = 25              # DI WS2812
LED_N = 4

MEASURE_MS = 1000         # период таймера (как в руководстве)
AVG_N = 5                 # скользящее среднее
PREHEAT_S = 30
CAL_S = 60
THRESHOLD_DEFAULT = 500   # ОБЪЯВЛЯЕТ ЭКСПЕРТ перед модулем
THR_MAX = 4000
HYST = 20                 # выход из тревоги ниже (порог - 20)
BLINK_MS = 1000           # 1 с горят / 1 с не горят
RED = (255, 0, 0)
OFF = (0, 0, 0)

AI_TIMEOUT_S = 10
WIFI_RETRY_MS = 10000
START_SCREEN_MS = 2000

PROMPT = ("Gas sensor MQ-2, 12-bit ADC (0-4095). 60 background readings in "
          "clean air, 1 per second: {}. Max={}. Suggest an alarm threshold "
          "above the background noise. Reply with one integer only.")

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
adc = ADC(Pin(PIN_GAS))
adc.atten(ADC.ATTN_11DB)
adc.width(ADC.WIDTH_12BIT)
np = NeoPixel(Pin(PIN_RGB), LED_N)
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние ----------------
state = "HEAT"            # HEAT -> CAL -> OK / ALARM
seconds = 0               # секунд в текущем этапе
window = []               # последние 5 значений
background = []           # 60 фоновых значений
threshold = THRESHOLD_DEFAULT
thr_src = "DEF"
avg = 0
tick = False
alarm_since = 0
leds_on = None
next_wifi = 0


def log(*parts):
    print(",".join([str(time.ticks_ms())] + [str(p) for p in parts]))


# ---------------- Wi-Fi и ИИ ----------------
class AIError(Exception):
    pass


def wifi_connect(timeout_ms=10000):
    if secrets is None:
        return False
    try:
        wlan.active(True)
        if not wlan.isconnected():
            wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASS)
            t0 = time.ticks_ms()
            while (not wlan.isconnected()
                   and time.ticks_diff(time.ticks_ms(), t0) < timeout_ms):
                time.sleep_ms(200)
        return wlan.isconnected()
    except Exception as e:
        print("WiFi error:", e)
        return False


def wifi_keepalive(now):
    global next_wifi
    if secrets is None or wlan.isconnected():
        return
    if time.ticks_diff(now, next_wifi) >= 0:
        next_wifi = time.ticks_add(now, WIFI_RETRY_MS)
        try:
            wlan.disconnect()
            wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASS)
        except Exception as e:
            print("WiFi retry:", e)


def ai_request(prompt):
    if secrets is None or not wlan.isconnected():
        raise AIError("NO_WIFI")
    gc.collect()
    body = {"model": secrets.MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 50, "temperature": 0}
    headers = {"Content-Type": "application/json",
               "Authorization": "Bearer " + secrets.API_KEY}
    r = requests.post(secrets.API_URL, data=json.dumps(body).encode(),
                      headers=headers, timeout=AI_TIMEOUT_S)
    try:
        if r.status_code != 200:
            raise AIError("HTTP%d" % r.status_code)
        return r.json()["choices"][0]["message"]["content"]
    finally:
        r.close()


def ai_check():
    log("AI_REQ")
    try:
        ai_request("Reply with one word: OK")
        log("AI_ANS", "OK")
        return True
    except Exception as e:
        log("AI_ERR", e)
        return False


def integers_in(text):
    nums, cur = [], ""
    for ch in text + " ":
        if "0" <= ch <= "9":
            cur += ch
        elif cur:
            nums.append(int(cur))
            cur = ""
    return nums


def ai_threshold():
    """Отправляет 60 фоновых значений, применяет порог AI или DEF."""
    global threshold, thr_src
    bg_max = max(background)
    bg_avg = sum(background) // len(background)
    threshold, thr_src = THRESHOLD_DEFAULT, "DEF"
    log("AI_REQ")
    try:
        nums = integers_in(ai_request(
            PROMPT.format(",".join([str(v) for v in background]), bg_max)))
        if len(nums) == 1 and bg_max < nums[0] <= THR_MAX:
            threshold, thr_src = nums[0], "AI"
            log("AI_ANS", nums[0])
        else:
            log("AI_BAD")
    except Exception as e:
        log("AI_ERR", e)
    print("CAL,%d,%d,%d,%s" % (bg_avg, bg_max, threshold, thr_src))


# ---------------- Светодиоды ----------------
def set_leds(on):
    global leds_on
    if on == leds_on:          # пишем в ленту только при изменении
        return
    leds_on = on
    for i in range(LED_N):
        np[i] = RED if on else OFF
    np.write()


def update_leds(now):
    if state == "ALARM":
        phase = (time.ticks_diff(now, alarm_since) // BLINK_MS) % 2
        set_leds(phase == 0)
    else:
        set_leds(False)


# ---------------- Экран ----------------
def screen(lines):
    """lines: список (y, текст)."""
    oled.fill(0)
    for y, txt in lines:
        oled.text(txt, 0, y)
    oled.show()


def draw():
    if state == "HEAT":
        screen([(0, "Gas"), (24, "Preheating"),
                (40, "Left: %d s" % (PREHEAT_S - seconds))])
    elif state == "CAL":
        screen([(0, "Gas"), (24, "AI CALIB"),
                (40, "Left: %d s" % (CAL_S - seconds))])
    else:
        screen([(0, "Gas"), (16, "%d/4095" % avg),
                (32, "Thr: %d %s" % (threshold, thr_src)),
                (48, "Danger!!" if state == "ALARM" else "No Panic")])


def start_screen():
    screen([(0, "IoT STATION " + STATION)])
    wifi_ok = wifi_connect()
    ai_ok = wifi_ok and ai_check()
    screen([(0, "IoT STATION " + STATION),
            (24, "WiFi: " + ("OK" if wifi_ok else "FAIL")),
            (40, "AI: " + ("READY" if ai_ok else "OFFLINE"))])
    time.sleep_ms(START_SCREEN_MS)


# ---------------- Измерение (раз в секунду) ----------------
def measure():
    global state, seconds, avg, alarm_since
    raw = adc.read()
    window.append(raw)
    if len(window) > AVG_N:
        window.pop(0)
    avg = sum(window) // len(window)
    seconds += 1
    # тревога с гистерезисом (только после калибровки)
    if state == "OK" and avg > threshold:
        state = "ALARM"
        alarm_since = time.ticks_ms()
    elif state == "ALARM" and avg < threshold - HYST:
        state = "OK"
    log(raw, avg, state)                    # время_мс,значение,среднее,состояние
    if state == "HEAT" and seconds >= PREHEAT_S:
        state, seconds = "CAL", 0           # прогрев закончен
    elif state == "CAL":
        background.append(raw)              # 1 фоновое значение в секунду
        if seconds >= CAL_S:
            draw()
            ai_threshold()                  # пауза цикла <= 10 с допустима
            state, seconds = "OK", 0
    draw()


def on_timer(t):
    global tick
    tick = True


def main():
    global tick
    set_leds(False)
    start_screen()
    draw()
    timer = Timer(0)
    timer.init(period=MEASURE_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            now = time.ticks_ms()
            if tick:
                tick = False
                measure()
            update_leds(now)
            wifi_keepalive(now)
        except Exception as e:
            print("ERR:", e)
        time.sleep_ms(20)


main()
