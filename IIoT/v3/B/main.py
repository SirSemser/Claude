# =====================================================================
#  WSKZ2026 IIoT (marking scheme v3) — Модуль B. Индукционная лампа
#  ESP32 (ZL-02B) + PIR + датчик освещённости (АЦП) + OLED + ThingsBoard
#  Рабочее место: XX. Устройство в ThingsBoard: IoT_STATION_XX
#  Назначение: лампа (значок на OLED) включается, когда темно И есть
#  движение, и горит HOLD секунд после последнего движения. Каждую
#  секунду телеметрия за последние 60 с уходит в ThingsBoard по MQTT,
#  время удержания HOLD приходит общим атрибутом hold.
#  Wi-Fi и токен — только в secrets.py на плате (см. secrets_example.py).
# =====================================================================
import time
import json
import network
from machine import Pin, ADC, Timer
try:
    from machine import SoftI2C          # MicroPython >= 1.14
except ImportError:                      # старая прошивка 1.13
    from machine import I2C

    def SoftI2C(scl, sda):
        return I2C(-1, scl=scl, sda=sda)

import ssd1306
from umqtt.simple import MQTTClient

try:                                     # secrets.py лежит только на плате
    import secrets
except ImportError:
    secrets = None

# ---------------- Константы: пины, пороги, интервалы ----------------
STATION = "XX"
PIN_SDA = 23              # OLED, разъём «23 19»
PIN_SCL = 19
PIN_PIR = 27              # PIR, разъём «27 26»: OUT -> 27
PIN_LIGHT = 34            # освещённость, разъём «35 34»: ADC -> 34 (ADC1, работает с Wi-Fi)

LIGHT_MS = 200            # период измерения освещённости, мс
LIGHT_AVG_N = 4           # среднее по 4 последним измерениям
CAL_S = 5                 # калибровка 5 с
DARK_RATIO = 0.5          # порог = 50 % от среднего в сторону затемнения
HYST_RATIO = 0.10         # гистерезис 10 % от порога
DARK_IS_HIGH = False      # СВЕРИТЬ НА СТЕНДЕ: True, если при затемнении АЦП растёт

HOLD_DEFAULT = 10         # с, начальное время удержания
HOLD_MIN = 5              # допустимые значения атрибута hold
HOLD_MAX = 30
STAT_WINDOW_S = 60        # статистика за последние 60 с

TB_HOST = "mqtt.thingsboard.cloud"
TB_PORT = 1883
TOPIC_TELEMETRY = b"v1/devices/me/telemetry"
TOPIC_ATTR = b"v1/devices/me/attributes"
TOPIC_ATTR_REQ = b"v1/devices/me/attributes/request/1"
TOPIC_ATTR_RESP = b"v1/devices/me/attributes/response/+"
TELEMETRY_MS = 1000       # телеметрия раз в секунду

WIFI_TIMEOUT_MS = 10000
NET_RETRY_MS = 10000      # пауза между попытками переподключения Wi-Fi / TB
START_SCREEN_MS = 2000

LAMP_CX, LAMP_CY, LAMP_R = 113, 39, 9   # значок лампы: x 104..122, y 30..48

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
pir = Pin(PIN_PIR, Pin.IN)
adc = ADC(Pin(PIN_LIGHT))
adc.atten(ADC.ATTN_11DB)                 # вход 0..3,3 В
adc.width(ADC.WIDTH_12BIT)               # значения 0..4095
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние ----------------
light_buf = []            # 4 последних значения АЦП
light_avg = 0
threshold = 0             # порог темноты после калибровки
light_low = False
motion = False
lamp_on = False
lamp_off_at = 0           # ticks_ms, когда лампа должна погаснуть
hold = HOLD_DEFAULT       # последнее принятое значение hold
cycle_hold = HOLD_DEFAULT # hold, действующий в текущем включении лампы

# Скользящее окно 60 с: по одной «корзине» на каждую секунду.
# Каждая корзина = [срабатываний PIR, мс лампы, мс темноты].
stat_buckets = []
cur_bucket = [0, 0, 0]

mqtt = None               # клиент MQTT или None, если нет связи с TB
tick = False
next_telemetry = 0
next_net = 0


def log(event):
    """Журнал событий: время_мс,СОБЫТИЕ (только изменения состояний)."""
    print("%d,%s" % (time.ticks_ms(), event))


# ---------------- Wi-Fi ----------------
def wifi_connect():
    """Подключение при старте. True/False, не падает."""
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


# ---------------- ThingsBoard (MQTT) ----------------
def parse_hold(value):
    """Проверяет значение hold: целое 5..30, иначе None (не применяем)."""
    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, float) and value != int(value):
            return None
        n = int(value)                   # "abc" -> ValueError
    except Exception:
        return None
    return n if HOLD_MIN <= n <= HOLD_MAX else None


def on_message(topic, msg):
    """Атрибут hold: изменение ({"hold":15}) или ответ на запрос
    ({"shared":{"hold":15}}). Новое значение — со следующего включения."""
    global hold
    try:
        data = json.loads(msg)
    except Exception:
        return
    if isinstance(data, dict) and isinstance(data.get("shared"), dict):
        data = data["shared"]
    if not isinstance(data, dict) or "hold" not in data:
        return
    n = parse_hold(data["hold"])
    if n is None:
        print("HOLD rejected:", data["hold"])   # 3, 31, "abc" не применяем
        return
    if n != hold:
        hold = n
        log("HOLD,%d" % hold)


def tb_connect():
    """Подключение к ThingsBoard: имя пользователя — Access token.
    Возвращает True/False, не падает."""
    global mqtt
    if secrets is None or not wlan.isconnected():
        return False
    try:
        c = MQTTClient("IoT_STATION_" + STATION, TB_HOST, port=TB_PORT,
                       user=secrets.TB_TOKEN, password="", keepalive=60)
        c.set_callback(on_message)
        c.connect()
        c.subscribe(TOPIC_ATTR)
        c.subscribe(TOPIC_ATTR_RESP)
        c.publish(TOPIC_ATTR_REQ, b'{"sharedKeys":"hold"}')  # текущее hold
        mqtt = c
        return True
    except Exception as e:
        print("TB error:", e)
        mqtt = None
        return False


def tb_drop():
    """Связь с TB потеряна: закрываем сокет, дальше — переподключение."""
    global mqtt
    try:
        mqtt.disconnect()
    except Exception:
        pass
    mqtt = None


def net_keepalive(now):
    """Раз в 10 с восстанавливает Wi-Fi и ThingsBoard без перезагрузки.
    Основные функции лампы в это время продолжают работать."""
    global next_net
    if wlan.isconnected() and mqtt is not None:
        return
    if secrets is None or time.ticks_diff(now, next_net) < 0:
        return
    next_net = time.ticks_add(now, NET_RETRY_MS)
    if not wlan.isconnected():
        if mqtt is not None:
            tb_drop()
        try:
            wlan.disconnect()
            wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASS)
        except Exception as e:
            print("WiFi retry:", e)
    else:
        tb_connect()


def stats():
    """Сумма по окну 60 с -> (motion, lamp_s, low_s)."""
    m, lamp_ms, low_ms = cur_bucket
    for b in stat_buckets:
        m += b[0]
        lamp_ms += b[1]
        low_ms += b[2]
    return m, lamp_ms // 1000, low_ms // 1000


def roll_stats():
    """Раз в секунду закрывает текущую корзину; старые (> 60 с) выбрасывает."""
    global cur_bucket
    stat_buckets.append(cur_bucket)
    if len(stat_buckets) > STAT_WINDOW_S:
        stat_buckets.pop(0)
    cur_bucket = [0, 0, 0]


def send_telemetry():
    """Телеметрия в v1/devices/me/telemetry: motion, lamp_s, low_s, hold."""
    m, lamp_s, low_s = stats()
    if mqtt is None:
        return
    payload = json.dumps({"motion": m, "lamp_s": lamp_s,
                          "low_s": low_s, "hold": hold})
    try:
        mqtt.publish(TOPIC_TELEMETRY, payload.encode())
    except Exception as e:
        print("TB send:", e)
        tb_drop()


def tb_poll():
    """Неблокирующая проверка входящих сообщений (атрибут hold)."""
    if mqtt is None:
        return
    try:
        mqtt.check_msg()
    except Exception as e:
        print("TB recv:", e)
        tb_drop()


# ---------------- Освещённость ----------------
def calibrate():
    """5 с измеряем фон и считаем порог темноты (50 % в сторону затемнения)."""
    global threshold
    total, n = 0, 0
    for left in range(CAL_S, 0, -1):
        oled.fill(0)
        oled.text("CALIBRATING", 0, 24)
        oled.text("Wait %ds" % left, 0, 40)
        oled.show()
        t0 = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), t0) < 1000:
            total += adc.read()
            n += 1
            time.sleep_ms(LIGHT_MS)
    avg = total // n
    if DARK_IS_HIGH:                     # темнее -> больше
        threshold = min(4095, int(avg * (1 + DARK_RATIO)))
    else:                                # темнее -> меньше
        threshold = int(avg * (1 - DARK_RATIO))
    print("CAL,%d,%d" % (avg, threshold))


def update_light():
    """Среднее по 4 измерениям и гистерезис 10 % от порога:
    вход в Low — за порогом, выход — только за порогом ± гистерезис."""
    global light_avg, light_low
    light_buf.append(adc.read())
    if len(light_buf) > LIGHT_AVG_N:
        light_buf.pop(0)
    light_avg = sum(light_buf) // len(light_buf)
    h = threshold * HYST_RATIO
    if DARK_IS_HIGH:
        new_low = light_avg > (threshold - h if light_low else threshold)
    else:
        new_low = light_avg < (threshold + h if light_low else threshold)
    if new_low != light_low:
        light_low = new_low
        log("LIGHT_LOW" if light_low else "LIGHT_NORMAL")


# ---------------- Лампа ----------------
def update_lamp(now):
    """Лампа: ON при Light:Low И Motion:YES; горит HOLD с после
    последнего движения; при свете выключается сразу."""
    global motion, lamp_on, lamp_off_at, cycle_hold
    m = pir.value() == 1
    if m and not motion:                 # фронт 0 -> 1 = новое движение
        cur_bucket[0] += 1
        log("MOTION")
    motion = m
    if light_low and motion:
        if not lamp_on:
            lamp_on = True
            cycle_hold = hold            # новое hold — только с нового включения
            log("LAMP_ON")
        lamp_off_at = time.ticks_add(now, cycle_hold * 1000)  # перезапуск отсчёта
    if lamp_on and (not light_low or time.ticks_diff(now, lamp_off_at) >= 0):
        lamp_on = False
        log("LAMP_OFF")


def lamp_left_s(now):
    """Сколько секунд осталось гореть (округление вверх)."""
    ms = time.ticks_diff(lamp_off_at, now)
    return max(0, (ms + 999) // 1000)


# ---------------- Экран ----------------
def draw_circle(filled):
    """Значок лампы: закрашенный круг — ON, контур — OFF."""
    if hasattr(oled, "ellipse"):         # MicroPython >= 1.20
        oled.ellipse(LAMP_CX, LAMP_CY, LAMP_R, LAMP_R, 1, filled)
        return
    r2 = LAMP_R * LAMP_R                 # запасной вариант для старой прошивки
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
    """Экран запуска 2 с: станция, Wi-Fi, ThingsBoard."""
    oled.fill(0)
    oled.text("IoT STATION " + STATION, 0, 0)
    oled.show()
    wifi_ok = wifi_connect()
    tb_ok = wifi_ok and tb_connect()
    oled.text("WiFi: " + ("OK" if wifi_ok else "FAIL"), 0, 24)
    oled.text("TB: " + ("OK" if tb_ok else "FAIL"), 0, 40)
    oled.show()
    time.sleep_ms(START_SCREEN_MS)


def on_timer(t):
    # В прерывании только флаг: АЦП, I2C, MQTT — в основном цикле
    global tick
    tick = True


# ---------------- Основная программа ----------------
def main():
    global tick, next_telemetry, next_net
    start_screen()
    calibrate()
    now = time.ticks_ms()
    next_telemetry = time.ticks_add(now, TELEMETRY_MS)
    next_net = time.ticks_add(now, NET_RETRY_MS)
    timer = Timer(0)
    timer.init(period=LIGHT_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            now = time.ticks_ms()
            if tick:                     # каждые 200 мс
                tick = False
                update_light()
                if lamp_on:
                    cur_bucket[1] += LIGHT_MS
                if light_low:
                    cur_bucket[2] += LIGHT_MS
                draw(now)
            update_lamp(now)
            if time.ticks_diff(now, next_telemetry) >= 0:   # каждую секунду
                next_telemetry = time.ticks_add(next_telemetry, TELEMETRY_MS)
                roll_stats()
                send_telemetry()
            tb_poll()
            net_keepalive(now)
        except Exception as e:           # программа не должна останавливаться
            print("ERR:", e)
        time.sleep_ms(20)


main()
