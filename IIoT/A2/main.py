# =====================================================================
#  WSKZ2026 IIoT — Модуль A2. Индукционная лампа
#  ESP32 + PIR + датчик освещённости (АЦП) + OLED + ИИ-сервис
#  Лампа в этом модуле — значок на OLED (отдельного светильника нет).
# =====================================================================
import time
import json
import gc
import network
from machine import Pin, ADC, Timer
try:
    from machine import SoftI2C          # MicroPython >= 1.14
except ImportError:                      # 1.13 (прошивка набора ZL-02B)
    from machine import I2C

    def SoftI2C(scl, sda):
        return I2C(-1, scl=scl, sda=sda)

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
PIN_PIR = 27
PIN_LIGHT = 34            # GPIO34 — только вход, канал ADC1 (работает при Wi-Fi)

LIGHT_MS = 200            # период измерения освещённости
LIGHT_AVG_N = 4           # среднее по 4 измерениям
CAL_S = 5                 # калибровка 5 с
DARK_RATIO = 0.5          # порог = 50 % от среднего в сторону затемнения
HYST_RATIO = 0.10         # гистерезис 10 % от порога
DARK_IS_HIGH = True       # СВЕРИТЬ НА СТЕНДЕ: растёт ли значение АЦП при затемнении

HOLD_DEFAULT = 10         # с, начальное время удержания
HOLD_MIN = 5
HOLD_MAX = 30

AI_PERIOD_MS = 60000      # статистика раз в минуту
AI_TIMEOUT_S = 10
WIFI_RETRY_MS = 10000
START_SCREEN_MS = 2000

LAMP_CX = 113             # значок лампы: круг x=104..122, y=30..48
LAMP_CY = 39
LAMP_R = 9

PROMPT = ("Corridor lamp statistics for the last 60 s: motion triggers={}, "
          "lamp on time={} s, darkness time={} s, current hold time={} s. "
          "Recommend lamp hold time to save energy. "
          "Reply with one integer from 5 to 30 only.")

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
pir = Pin(PIN_PIR, Pin.IN)
adc = ADC(Pin(PIN_LIGHT))
adc.atten(ADC.ATTN_11DB)        # диапазон входа ~0..3.3 В
adc.width(ADC.WIDTH_12BIT)      # значения 0..4095
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние ----------------
light_buf = []
light_avg = 0
threshold = 0
light_low = False
motion = False
lamp_on = False
lamp_off_at = 0           # момент выключения (ticks_ms)
hold = HOLD_DEFAULT       # текущее значение HOLD (меняет ИИ)
cycle_hold = HOLD_DEFAULT # HOLD, действующий в текущем включении
stat_motion = 0           # статистика за минуту
stat_lamp_ms = 0
stat_low_ms = 0
tick = False
next_ai = 0
next_wifi = 0


def log(*parts):
    print(",".join([str(time.ticks_ms())] + [str(p) for p in parts]))


# ---------------- Wi-Fi и ИИ (одинаковы во всех модулях) ----------------
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
    """Все целые числа из текста (в MicroPython нет re.findall)."""
    nums, cur = [], ""
    for ch in text + " ":
        if "0" <= ch <= "9":
            cur += ch
        elif cur:
            nums.append(int(cur))
            cur = ""
    return nums


def ai_step(now):
    """Раз в минуту: статистика -> ИИ -> новое HOLD (5..30)."""
    global next_ai, hold, stat_motion, stat_lamp_ms, stat_low_ms
    if time.ticks_diff(now, next_ai) < 0:
        return
    next_ai = time.ticks_add(now, AI_PERIOD_MS)
    prompt = PROMPT.format(stat_motion, stat_lamp_ms // 1000,
                           stat_low_ms // 1000, hold)
    stat_motion, stat_lamp_ms, stat_low_ms = 0, 0, 0   # новая минута
    log("AI_REQ")
    try:
        nums = integers_in(ai_request(prompt))
        if len(nums) == 1 and HOLD_MIN <= nums[0] <= HOLD_MAX:
            log("AI_ANS", nums[0])
            if nums[0] != hold:
                hold = nums[0]                 # применится со след. включения
                log("HOLD", hold)
        else:
            log("AI_BAD")                      # HOLD не меняем
    except Exception as e:
        log("AI_ERR", e)                       # HOLD не меняем


# ---------------- Освещённость ----------------
def calibrate():
    """5 с измеряем фон, считаем порог темноты."""
    global threshold
    total, n = 0, 0
    for left in range(CAL_S, 0, -1):
        oled.fill(0)
        oled.text("Induction Lamp", 0, 0)
        oled.text("CALIBRATING", 0, 24)
        oled.text("Wait %ds" % left, 0, 40)
        oled.show()
        t0 = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t0) < 1000:
            total += adc.read()
            n += 1
            time.sleep_ms(LIGHT_MS)
    avg = total // n
    if DARK_IS_HIGH:                       # темнее -> больше
        threshold = min(4095, int(avg * (1 + DARK_RATIO)))
    else:                                  # темнее -> меньше
        threshold = int(avg * (1 - DARK_RATIO))
    print("CAL,%d,%d" % (avg, threshold))


def update_light():
    """Среднее по 4 измерениям + гистерезис 10 % от порога."""
    global light_avg, light_low
    light_buf.append(adc.read())
    if len(light_buf) > LIGHT_AVG_N:
        light_buf.pop(0)
    light_avg = sum(light_buf) // len(light_buf)
    h = threshold * HYST_RATIO
    if DARK_IS_HIGH:                       # темнее -> больше
        if light_low:
            new_low = light_avg > threshold - h   # выйти из Low чуть ниже порога
        else:
            new_low = light_avg > threshold
    else:                                  # темнее -> меньше
        if light_low:
            new_low = light_avg < threshold + h
        else:
            new_low = light_avg < threshold
    if new_low != light_low:
        light_low = new_low
        log("LIGHT_LOW" if light_low else "LIGHT_NORMAL")


# ---------------- Лампа ----------------
def update_lamp(now):
    global motion, lamp_on, lamp_off_at, cycle_hold, stat_motion
    m = pir.value() == 1
    if m and not motion:                   # фронт 0->1 = новое срабатывание
        stat_motion += 1
        log("MOTION")
    motion = m
    if light_low and motion:
        if not lamp_on:
            lamp_on = True
            cycle_hold = hold              # новое HOLD — только с нового включения
            log("LAMP_ON")
        lamp_off_at = time.ticks_add(now, cycle_hold * 1000)  # перезапуск отсчёта
    if lamp_on and (not light_low or time.ticks_diff(now, lamp_off_at) >= 0):
        lamp_on = False                    # стало светло или вышло время
        log("LAMP_OFF")


def lamp_left_s(now):
    ms = time.ticks_diff(lamp_off_at, now)
    return max(0, (ms + 999) // 1000)      # округляем вверх


# ---------------- Экран ----------------
def draw_circle(filled):
    if hasattr(oled, "ellipse"):           # MicroPython >= 1.20
        oled.ellipse(LAMP_CX, LAMP_CY, LAMP_R, LAMP_R, 1, filled)
        return
    r2 = LAMP_R * LAMP_R                   # запасной вариант для старой прошивки
    for dy in range(-LAMP_R, LAMP_R + 1):
        for dx in range(-LAMP_R, LAMP_R + 1):
            d2 = dx * dx + dy * dy
            if d2 <= r2 and (filled or d2 > r2 - 2 * LAMP_R):
                oled.pixel(LAMP_CX + dx, LAMP_CY + dy, 1)


def draw(now):
    oled.fill(0)
    oled.text("Induction Lamp", 0, 0)
    oled.text("Light:Low" if light_low else "Light:Normal", 0, 16)
    oled.text("Motion:YES" if motion else "Motion:NO", 0, 32)
    if lamp_on:
        oled.text("Lamp:ON %ds" % lamp_left_s(now), 0, 48)
    else:
        oled.text("Lamp:OFF H:%ds" % hold, 0, 48)
    draw_circle(lamp_on)
    oled.show()


def start_screen():
    oled.fill(0)
    oled.text("IoT STATION " + STATION, 0, 0)
    oled.show()
    wifi_ok = wifi_connect()
    ai_ok = wifi_ok and ai_check()
    oled.text("WiFi: " + ("OK" if wifi_ok else "FAIL"), 0, 24)
    oled.text("AI: " + ("READY" if ai_ok else "OFFLINE"), 0, 40)
    oled.show()
    time.sleep_ms(START_SCREEN_MS)


def on_timer(t):
    global tick
    tick = True


def main():
    global tick, next_ai, stat_lamp_ms, stat_low_ms
    start_screen()
    calibrate()
    next_ai = time.ticks_add(time.ticks_ms(), AI_PERIOD_MS)
    timer = Timer(0)
    timer.init(period=LIGHT_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            now = time.ticks_ms()
            if tick:
                tick = False
                update_light()
                if lamp_on:
                    stat_lamp_ms += LIGHT_MS
                if light_low:
                    stat_low_ms += LIGHT_MS
                draw(now)
            update_lamp(now)
            wifi_keepalive(now)
            ai_step(now)                   # отсчёт лампы по ticks_ms — не сбивается
        except Exception as e:
            print("ERR:", e)
        time.sleep_ms(50)


main()
