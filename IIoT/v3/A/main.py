# =====================================================================
#  WSKZ2026 IIoT (marking scheme v3) — Модуль A. Ультразвуковой дальномер
#  ESP32 (ZL-02B) + HC-SR04 + OLED SSD1306. Рабочее место: XX
#  Назначение: измеряет расстояние каждые 200 мс, фильтрует медианой
#  по 5 корректным измерениям, показывает расстояние, зону и шкалу,
#  пишет CSV-журнал в консоль. Wi-Fi — только статус и автопереподключение.
#  Пароль Wi-Fi — только в secrets.py на плате (в Git его нет).
# =====================================================================
import time
import network
from machine import Pin, Timer
try:
    from machine import SoftI2C          # MicroPython >= 1.14
except ImportError:                      # старая прошивка 1.13
    from machine import I2C

    def SoftI2C(scl, sda):
        return I2C(-1, scl=scl, sda=sda)

import ssd1306
from HCSR04 import HCSR04                # драйвер площадки, не менять

try:                                     # secrets.py лежит только на плате
    import secrets
except ImportError:
    secrets = None

# ---------------- Константы: пины, пороги, интервалы ----------------
STATION = "XX"            # номер рабочего места
PIN_SDA = 23              # OLED, разъём «23 19»
PIN_SCL = 19
PIN_TRIG = 14             # HC-SR04, разъём «12 14»: TRIG -> 14
PIN_ECHO = 12             #                          ECHO -> 12

MEASURE_MS = 200          # период таймера измерения, мс
DIST_MIN = 2              # см: меньше — некорректно
DIST_MAX = 100            # см: больше — некорректно
ZONE_NEAR = 20            # < 20 см        -> NEAR
ZONE_FAR = 50             # 20..50 см -> MID, > 50 см -> FAR
FILTER_N = 5              # буфер из 5 последних корректных измерений

BAR_X, BAR_Y = 0, 54      # рамка шкалы
BAR_W, BAR_H = 122, 10
BAR_RANGE = 100           # см: >= 100 — шкала пустая, 0 — полная

WIFI_TIMEOUT_MS = 10000   # ожидание подключения при старте
WIFI_RETRY_MS = 10000     # пауза между попытками переподключения
START_SCREEN_MS = 2000    # экран запуска 2 с

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
sensor = HCSR04(PIN_TRIG, PIN_ECHO)      # конструктор HCSR04(tri, ech)
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние программы ----------------
buf = []                  # последние корректные измерения (не больше 5)
dist = None               # отфильтрованное расстояние, None = OUT OF RANGE
zone = ""                 # NEAR / MID / FAR
tick = False              # флаг, который ставит таймер
next_wifi = 0             # когда можно снова пробовать Wi-Fi


# ---------------- Wi-Fi ----------------
def wifi_connect():
    """Подключение при старте. Возвращает True/False, никогда не падает."""
    if secrets is None:
        return False
    try:
        wlan.active(True)
        if not wlan.isconnected():
            wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASS)
            t0 = time.ticks_ms()
            while (not wlan.isconnected()
                   and time.ticks_diff(time.ticks_ms(), t0) < WIFI_TIMEOUT_MS):
                time.sleep_ms(200)
        return wlan.isconnected()
    except Exception as e:
        print("WiFi error:", e)
        return False


def wifi_keepalive(now):
    """Если сеть пропала — раз в 10 с запускает connect() без ожидания,
    чтобы измерения не останавливались. Перезагрузка не нужна."""
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


# ---------------- Измерение и фильтр ----------------
def read_cm():
    """Одно измерение в см или None, если оно некорректно
    (вне 2..100 см, датчик отключён, драйвер бросил исключение)."""
    try:
        d = sensor.distance()        # см; метод по руководству ZL-02B (табл. 16-1)
    except Exception:
        return None
    if d is None or d < DIST_MIN or d > DIST_MAX:
        return None
    return d


def median(values):
    """Медиана: один-два случайных «скачка» в буфере её не сдвигают."""
    s = sorted(values)
    n = len(s)
    if n % 2:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def zone_of(d):
    """Зона по расстоянию d (см)."""
    if d < ZONE_NEAR:
        return "NEAR"
    if d <= ZONE_FAR:
        return "MID"
    return "FAR"


def log_csv(now):
    """Строка журнала: время_мс,расстояние_см,зона или время_мс,-1,OUT."""
    if dist is None:
        print("%d,-1,OUT" % now)
    else:
        print("%d,%.1f,%s" % (now, dist, zone))


def measure():
    """Вызывается каждые 200 мс (по флагу таймера): измерение,
    буфер, фильтр, зона, журнал, экран."""
    global dist, zone
    d = read_cm()
    if d is None:
        dist = None                      # ошибку в буфер не кладём
    else:
        buf.append(d)
        if len(buf) > FILTER_N:
            buf.pop(0)
        dist = median(buf)
        zone = zone_of(dist)
    log_csv(time.ticks_ms())
    draw()


# ---------------- Экран ----------------
def draw_bar(d):
    """Шкала: чем ближе объект, тем больше заполнение."""
    fill = int(BAR_W * (BAR_RANGE - min(d, BAR_RANGE)) / BAR_RANGE)
    oled.rect(BAR_X, BAR_Y, BAR_W, BAR_H, 1)
    if fill > 0:
        oled.fill_rect(BAR_X, BAR_Y, fill, BAR_H, 1)


def draw():
    """Экран измерения; перед каждым обновлением очищается."""
    oled.fill(0)
    oled.text("HCSR04", 0, 0)
    if dist is None:
        oled.text("OUT OF RANGE", 0, 24)     # без расстояния, зоны и шкалы
    else:
        oled.text("Dist: %.1f cm" % dist, 0, 14)
        oled.text("Zone: " + zone, 0, 28)
        draw_bar(dist)
    oled.show()


def start_screen():
    """Экран запуска на 2 с: номер станции и статус Wi-Fi."""
    oled.fill(0)
    oled.text("IoT STATION " + STATION, 0, 0)
    oled.show()
    ok = wifi_connect()
    oled.text("WiFi: " + ("OK" if ok else "FAIL"), 0, 24)
    oled.show()
    time.sleep_ms(START_SCREEN_MS)


# ---------------- Таймер ----------------
def on_timer(t):
    # В прерывании только ставим флаг: датчик, I2C и print — в основном цикле
    global tick
    tick = True


# ---------------- Основная программа ----------------
def main():
    global tick
    start_screen()
    timer = Timer(0)
    timer.init(period=MEASURE_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            if tick:
                tick = False
                measure()
            wifi_keepalive(time.ticks_ms())
        except Exception as e:           # программа не должна останавливаться
            print("ERR:", e)
        time.sleep_ms(5)


main()
