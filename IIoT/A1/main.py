# =====================================================================
#  WSKZ2026 IIoT — Модуль A1. Ультразвуковой дальномер (парктроник)
#  ESP32 + HC-SR04 + OLED SSD1306 + ИИ-сервис (Chat Completions API)
#  Эталонное учебное решение. Перед использованием сверить имена
#  методов с файлами драйверов на площадке (см. пометки "СВЕРИТЬ").
# =====================================================================
import time
import json
import gc
import network
from machine import Pin, SoftI2C, Timer
import ssd1306
from HCSR04 import HCSR04

try:                      # в новых прошивках модуль называется requests
    import requests
except ImportError:       # в старых — urequests
    import urequests as requests

try:                      # secrets.py лежит только на плате, не в Git
    import secrets
except ImportError:
    secrets = None

# ---------------- Константы (пины, пороги, тайминги) ----------------
STATION = "XX"            # номер рабочего места
PIN_SDA = 23
PIN_SCL = 19
PIN_TRIG = 14
PIN_ECHO = 12

MEASURE_MS = 200          # период таймера измерения
DIST_MIN = 2              # см, меньше — некорректно
DIST_MAX = 400            # см, больше — некорректно
ZONE_NEAR = 20            # < 20 см  -> NEAR
ZONE_FAR = 50             # > 50 см  -> FAR, иначе MID
FILTER_N = 5              # размер буфера медианы

LINE_Y = (0, 14, 28, 42)  # в A1 строки идут через 14 px
BAR_X = 0
BAR_Y = 54
BAR_W = 122
BAR_H = 10
BAR_RANGE = 100           # см: >= 100 -> шкала пустая

HIST_N = 10               # сколько значений отправляем ИИ
HIST_MS = 500             # интервал между этими значениями
AI_PERIOD_MS = 10000      # запрос раз в 10 с
AI_RETRY_MS = 10000       # после ошибки — не раньше чем через 10 с
AI_TIMEOUT_S = 10
WIFI_RETRY_MS = 10000
START_SCREEN_MS = 2000

AI_WORDS = ("APPROACH", "AWAY", "STILL")
PROMPT = ("Parking sensor. Distances to an object in cm, measured every "
          "0.5 s, oldest first: {}. Is the object approaching, moving away "
          "or standing still? Reply with exactly one word: "
          "APPROACH, AWAY or STILL.")

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)          # адрес 0x3C по умолчанию
sensor = HCSR04(PIN_TRIG, PIN_ECHO)               # конструктор HCSR04(tri, ech)
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние программы ----------------
buf = []                  # 5 последних корректных измерений
history = []              # 10 медиан с шагом 0.5 с (для ИИ)
dist = None               # отфильтрованное расстояние или None (OUT)
zone = ""
ai_text = "---"           # что показываем в строке AI
ai_last = None            # последняя допустимая оценка
tick = False              # флаг от таймера
next_ai = 0
next_hist = 0
next_wifi = 0


def log(*parts):
    """Строка журнала: время_мс,поле,поле..."""
    print(",".join([str(time.ticks_ms())] + [str(p) for p in parts]))


# ---------------- Wi-Fi ----------------
def wifi_connect(timeout_ms=10000):
    """Подключение при старте. Возвращает True/False, не падает."""
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
    """Автопереподключение: раз в 10 с, без ожидания (не тормозит цикл)."""
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


# ---------------- ИИ-сервис ----------------
class AIError(Exception):
    pass


def ai_request(prompt):
    """POST в Chat Completions. Возвращает текст ответа или бросает исключение."""
    if secrets is None or not wlan.isconnected():
        raise AIError("NO_WIFI")
    gc.collect()                                   # TLS требует много памяти
    body = {"model": secrets.MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 50, "temperature": 0}
    headers = {"Content-Type": "application/json",
               "Authorization": "Bearer " + secrets.API_KEY}
    r = requests.post(secrets.API_URL, data=json.dumps(body).encode(),
                      headers=headers, timeout=AI_TIMEOUT_S)
    try:
        if r.status_code != 200:
            raise AIError("HTTP%d" % r.status_code)  # 401 / 429 / 5xx
        return r.json()["choices"][0]["message"]["content"]
    finally:
        r.close()                                  # всегда освобождаем сокет


def pick_word(text, allowed):
    """Ищет в свободном тексте ровно одно допустимое слово, иначе None."""
    t = text.upper()
    found = [w for w in allowed if w in t]
    return found[0] if len(found) == 1 else None


def ai_check():
    """Проверочный запрос при запуске -> True, если сервис отвечает."""
    log("AI_REQ")
    try:
        ai_request("Reply with one word: OK")   # важен сам код 200
        log("AI_ANS", "OK")
        return True
    except Exception as e:
        log("AI_ERR", e)
        return False


def ai_step(now):
    """Раз в 10 с отправляет 10 последних значений и ждёт оценку."""
    global ai_text, ai_last, next_ai
    if time.ticks_diff(now, next_ai) < 0 or len(history) < HIST_N:
        return
    values = ",".join(["%.1f" % v for v in history])
    ai_text = "..."
    draw()                                         # показать "AI: ..." до запроса
    log("AI_REQ")
    try:
        word = pick_word(ai_request(PROMPT.format(values)), AI_WORDS)
        if word is None:
            log("AI_BAD")
            ai_text, ai_last = "---", None
        else:
            log("AI_ANS", word)
            ai_text, ai_last = word, word
        next_ai = time.ticks_add(time.ticks_ms(), AI_PERIOD_MS)
    except Exception as e:
        log("AI_ERR", e)
        ai_text, ai_last = "---", None
        next_ai = time.ticks_add(time.ticks_ms(), AI_RETRY_MS)


# ---------------- Измерение и фильтр ----------------
def read_cm():
    """Одно измерение в см или None, если некорректно."""
    try:
        d = sensor.distance_cm()   # СВЕРИТЬ имя метода с HCSR04.py (dir(sensor))
    except Exception:
        return None                # драйвер вызвал ошибку (тайм-аут эха и т.п.)
    if d is None or d < DIST_MIN or d > DIST_MAX:
        return None
    return d


def median(values):
    s = sorted(values)
    n = len(s)
    if n % 2:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def zone_of(d):
    if d < ZONE_NEAR:
        return "NEAR"
    if d <= ZONE_FAR:              # от 20 до 50 включительно
        return "MID"
    return "FAR"


def measure():
    """Вызывается по флагу таймера каждые 200 мс."""
    global dist, zone
    d = read_cm()
    if d is None:
        dist = None
        log(-1, "OUT")
    else:
        buf.append(d)
        if len(buf) > FILTER_N:
            buf.pop(0)
        dist = median(buf)
        zone = zone_of(dist)
        log("%.1f" % dist, zone)
    draw()


# ---------------- Экран ----------------
def draw_bar(d):
    fill = int(BAR_W * (BAR_RANGE - min(d, BAR_RANGE)) / BAR_RANGE)
    oled.rect(BAR_X, BAR_Y, BAR_W, BAR_H, 1)
    oled.fill_rect(BAR_X, BAR_Y, fill, BAR_H, 1)


def draw():
    oled.fill(0)                                   # очистка перед обновлением
    oled.text("HCSR04", 0, LINE_Y[0])
    if dist is None:
        oled.text("OUT OF RANGE", 0, 24)
        oled.invert(0)
    else:
        oled.text("Dist: %.1f cm" % dist, 0, LINE_Y[1])
        oled.text("Zone: " + zone, 0, LINE_Y[2])
        oled.text("AI: " + ai_text, 0, LINE_Y[3])
        draw_bar(dist)
        warn = zone == "NEAR" and ai_last == "APPROACH"
        oled.invert(1 if warn else 0)              # предупреждение
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


# ---------------- Таймер ----------------
def on_timer(t):
    # В прерывании только ставим флаг: I2C, print и HTTP — в основном цикле
    global tick
    tick = True


# ---------------- Основная программа ----------------
def main():
    global tick, next_hist, next_ai
    start_screen()
    now = time.ticks_ms()
    next_hist = now
    next_ai = time.ticks_add(now, AI_PERIOD_MS)
    timer = Timer(0)
    timer.init(period=MEASURE_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            now = time.ticks_ms()
            if tick:
                tick = False
                measure()
            if time.ticks_diff(now, next_hist) >= 0:   # история для ИИ, шаг 0.5 с
                next_hist = time.ticks_add(now, HIST_MS)
                if dist is not None:
                    history.append(dist)
                    if len(history) > HIST_N:
                        history.pop(0)
            wifi_keepalive(now)
            ai_step(now)
        except Exception as e:                     # программа не должна падать
            print("ERR:", e)
        time.sleep_ms(5)


main()
