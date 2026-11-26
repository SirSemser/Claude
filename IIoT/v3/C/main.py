# =====================================================================
#  WSKZ2026 IIoT (marking scheme v3) — Модуль C. Контроль загазованности
#  ESP32 (ZL-02B) + MQ-2 (АЦП) + WS2812 (4 светодиода) + OLED + ThingsBoard
#  Рабочее место: XX. Устройство в ThingsBoard: IoT_STATION_XX
#  Назначение: прогрев датчика 30 с, сбор фона 60 с, затем раз в секунду
#  измерение, скользящее среднее по 5, тревога с гистерезисом, мигание
#  WS2812 красным, телеметрия в ThingsBoard по MQTT, порог threshold —
#  общим атрибутом из ThingsBoard (или THRESHOLD_DEFAULT).
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
import neopixel
from umqtt.simple import MQTTClient

try:                                     # secrets.py лежит только на плате
    import secrets
except ImportError:
    secrets = None

# ---------------- Константы: пины, пороги, интервалы ----------------
STATION = "XX"
PIN_SDA = 23              # OLED, разъём «23 19»
PIN_SCL = 19
PIN_GAS = 34              # MQ-2, разъём «35 34»: ADC -> 34 (ADC1, работает с Wi-Fi)
PIN_LED = 25              # WS2812, разъём «25 33»: DI -> 25
LED_COUNT = 4
LED_RED = (255, 0, 0)     # цвет тревоги
LED_OFF = (0, 0, 0)

MEASURE_MS = 1000         # период таймера измерения, мс
AVG_N = 5                 # скользящее среднее по 5 последним измерениям
PREHEAT_S = 30            # прогрев датчика, с
CALIB_S = 60              # сбор фона, с (1 значение в секунду)
ADC_MAX = 4095            # 12 бит
THRESHOLD_DEFAULT = 2000  # СВЕРИТЬ С ЗАДАНИЕМ: порог, если из TB нет данных
THRESHOLD_MAX = 4000      # порог из TB должен быть > bg_max и <= 4000
HYST = 20                 # выход из тревоги только ниже порога минус 20

TB_HOST = "mqtt.thingsboard.cloud"
TB_PORT = 1883
TOPIC_TELEMETRY = b"v1/devices/me/telemetry"
TOPIC_ATTR = b"v1/devices/me/attributes"
TOPIC_ATTR_REQ = b"v1/devices/me/attributes/request/1"
TOPIC_ATTR_RESP = b"v1/devices/me/attributes/response/+"
ATTR_WAIT_MS = 2000       # сколько ждём ответ на запрос порога после калибровки

WIFI_TIMEOUT_MS = 10000
NET_RETRY_MS = 10000      # пауза между попытками переподключения Wi-Fi / TB
START_SCREEN_MS = 2000

# Состояния (они же пишутся в журнал и в телеметрию)
HEAT, CAL, OK, ALARM = "HEAT", "CAL", "OK", "ALARM"

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
adc = ADC(Pin(PIN_GAS))
adc.atten(ADC.ATTN_11DB)                 # вход 0..3,3 В
adc.width(ADC.WIDTH_12BIT)               # значения 0..4095
leds = neopixel.NeoPixel(Pin(PIN_LED), LED_COUNT)
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние ----------------
state = HEAT              # HEAT -> CAL -> OK / ALARM
phase_left = PREHEAT_S    # сколько секунд осталось прогрева / калибровки
gas = 0                   # последнее значение АЦП
avg_buf = []              # 5 последних значений для скользящего среднего
gas_avg = 0
bg_values = []            # значения фона за 60 с калибровки
bg_avg = None             # после калибровки: среднее и максимум фона
bg_max = None
tb_threshold = None       # последнее значение атрибута threshold из TB
led_on = False            # фаза мигания (1 с горят / 1 с нет)
mqtt = None
tick = False
next_net = 0


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
def on_message(topic, msg):
    """Атрибут threshold: изменение ({"threshold":1500}) или ответ на
    запрос ({"shared":{"threshold":1500}}). Проверка — в threshold_now()."""
    global tb_threshold
    try:
        data = json.loads(msg)
    except Exception:
        return
    if isinstance(data, dict) and isinstance(data.get("shared"), dict):
        data = data["shared"]
    if isinstance(data, dict) and "threshold" in data:
        tb_threshold = data["threshold"]


def request_threshold():
    """Запрос текущего значения общего атрибута threshold."""
    if mqtt is None:
        return
    try:
        mqtt.publish(TOPIC_ATTR_REQ, b'{"sharedKeys":"threshold"}')
    except Exception as e:
        print("TB req:", e)
        tb_drop()


def tb_connect():
    """Подключение к ThingsBoard: имя пользователя — Access token."""
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
        mqtt = c
        request_threshold()
        return True
    except Exception as e:
        print("TB error:", e)
        mqtt = None
        return False


def tb_drop():
    """Связь с TB потеряна: закрываем сокет; порог вернётся к DEF."""
    global mqtt
    try:
        mqtt.disconnect()
    except Exception:
        pass
    mqtt = None


def net_keepalive(now):
    """Раз в 10 с восстанавливает Wi-Fi и ThingsBoard без перезагрузки."""
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


def tb_poll():
    """Неблокирующая проверка входящих сообщений (атрибут threshold)."""
    if mqtt is None:
        return
    try:
        mqtt.check_msg()
    except Exception as e:
        print("TB recv:", e)
        tb_drop()


def send_telemetry(thr):
    """Раз в секунду: gas, avg, thr, state; после калибровки ещё bg_avg, bg_max."""
    if mqtt is None:
        return
    data = {"gas": gas, "avg": gas_avg, "thr": thr, "state": state}
    if bg_avg is not None:
        data["bg_avg"] = bg_avg
        data["bg_max"] = bg_max
    try:
        mqtt.publish(TOPIC_TELEMETRY, json.dumps(data).encode())
    except Exception as e:
        print("TB send:", e)
        tb_drop()


# ---------------- Порог ----------------
def threshold_now():
    """Действующий порог и его источник: ("TB") если из TB пришло целое
    > bg_max и <= 4000 и связь есть; иначе THRESHOLD_DEFAULT ("DEF")."""
    v = tb_threshold
    if mqtt is None or v is None or isinstance(v, bool):
        return THRESHOLD_DEFAULT, "DEF"
    try:
        if isinstance(v, float) and v != int(v):
            return THRESHOLD_DEFAULT, "DEF"
        v = int(v)                       # "abc" -> ValueError
    except Exception:
        return THRESHOLD_DEFAULT, "DEF"
    low = bg_max if bg_max is not None else 0
    if low < v <= THRESHOLD_MAX:
        return v, "TB"
    return THRESHOLD_DEFAULT, "DEF"


def wait_threshold():
    """После калибровки: запрашиваем порог и до 2 с ждём ответ."""
    request_threshold()
    t0 = time.ticks_ms()
    while mqtt is not None and time.ticks_diff(time.ticks_ms(), t0) < ATTR_WAIT_MS:
        tb_poll()
        if tb_threshold is not None:
            break
        time.sleep_ms(50)


# ---------------- Измерение и логика ----------------
def measure():
    """Каждую секунду (по флагу таймера): значение АЦП и скользящее
    среднее по 5 последним измерениям."""
    global gas, gas_avg
    gas = adc.read()
    avg_buf.append(gas)
    if len(avg_buf) > AVG_N:
        avg_buf.pop(0)
    gas_avg = sum(avg_buf) // len(avg_buf)


def step_phase():
    """Прогрев -> сбор фона -> работа. Во время HEAT и CAL тревоги нет."""
    global state, phase_left, bg_avg, bg_max
    if state == HEAT:
        phase_left -= 1
        if phase_left <= 0:
            state, phase_left = CAL, CALIB_S
    elif state == CAL:
        bg_values.append(gas)            # 1 значение в секунду
        phase_left -= 1
        if phase_left <= 0:
            bg_avg = sum(bg_values) // len(bg_values)
            bg_max = max(bg_values)
            wait_threshold()
            thr, src = threshold_now()
            print("CAL,%d,%d,%d,%s" % (bg_avg, bg_max, thr, src))
            state = OK


def update_alarm(thr):
    """Тревога с гистерезисом: среднее > порога -> ALARM;
    обратно в OK только когда среднее < порог - 20 (без «дребезга»)."""
    global state
    if state == OK and gas_avg > thr:
        state = ALARM
    elif state == ALARM and gas_avg < thr - HYST:
        state = OK


def update_leds():
    """Тревога: все 4 WS2812 мигают красным 1 с / 1 с. Норма: выключены."""
    global led_on
    if state == ALARM:
        led_on = not led_on              # таймер 1 с -> смена фазы раз в секунду
    else:
        led_on = False
    color = LED_RED if led_on else LED_OFF
    for i in range(LED_COUNT):
        leds[i] = color
    leds.write()


def log_csv():
    """Журнал: время_мс,значение,среднее,состояние."""
    print("%d,%d,%d,%s" % (time.ticks_ms(), gas, gas_avg, state))


# ---------------- Экран ----------------
def draw(thr, src):
    oled.fill(0)
    oled.text("Gas", 0, 0)
    if state == HEAT:
        oled.text("Preheating", 0, 24)
        oled.text("Left: %d s" % phase_left, 0, 40)
    elif state == CAL:
        oled.text("CALIB", 0, 24)
        oled.text("Left: %d s" % phase_left, 0, 40)
    else:
        oled.text("%d/%d" % (gas_avg, ADC_MAX), 0, 16)
        oled.text("Thr: %d %s" % (thr, src), 0, 32)
        oled.text("Danger!!" if state == ALARM else "No Panic", 0, 48)
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
    # В прерывании только флаг: АЦП, I2C, WS2812 и MQTT — в основном цикле
    global tick
    tick = True


# ---------------- Основная программа ----------------
def main():
    global tick, next_net
    start_screen()
    update_leds()                        # светодиоды выключены
    draw(*threshold_now())
    next_net = time.ticks_add(time.ticks_ms(), NET_RETRY_MS)
    timer = Timer(0)
    timer.init(period=MEASURE_MS, mode=Timer.PERIODIC, callback=on_timer)
    while True:
        try:
            if tick:                     # раз в секунду
                tick = False
                measure()
                step_phase()
                thr, src = threshold_now()
                if state in (OK, ALARM):
                    update_alarm(thr)
                update_leds()
                log_csv()
                draw(thr, src)
                send_telemetry(thr)
            tb_poll()
            net_keepalive(time.ticks_ms())
        except Exception as e:           # программа не должна останавливаться
            print("ERR:", e)
        time.sleep_ms(20)


main()
