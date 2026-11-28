# =====================================================================
#  WSKZ2026 IIoT (marking scheme v3) — Модуль E. ИИ-камера (ESP32)
#  ESP32 (ZL-02B) + OLED + A01-AI по UART2 (115200, 8N1) + ИИ-сервис.
#  Рабочее место: XX.
#  Назначение: при запуске один проверочный запрос к ИИ-сервису
#  (AI: READY / OFFLINE); затем приём строк от A01-AI
#  "OBJ,<класс>,<уверенность_%>" и "NONE", проверка формата, вывод на OLED,
#  ответ "ACK" на каждый OBJ, журнал в консоль, "LINK LOST" без данных 3 с.
#  Wi-Fi и API-ключ — только в secrets.py на плате (см. secrets_example.py).
# =====================================================================
import time
import json
import gc
import network
from machine import Pin, UART
try:
    from machine import SoftI2C          # MicroPython >= 1.14
except ImportError:                      # старая прошивка 1.13
    from machine import I2C

    def SoftI2C(scl, sda):
        return I2C(-1, scl=scl, sda=sda)

import ssd1306

try:                                     # в новых прошивках — requests
    import requests
except ImportError:                      # в старых — urequests
    import urequests as requests

try:                                     # secrets.py лежит только на плате
    import secrets
except ImportError:
    secrets = None

# ---------------- Константы: пины, пороги, интервалы ----------------
STATION = "XX"
PIN_SDA = 23              # OLED, разъём «23 19»
PIN_SCL = 19
UART_ID = 2
PIN_RX = 16               # <- IO6 (TX) A01-AI, разъём «16 17»
PIN_TX = 17               # -> IO7 (RX) A01-AI
BAUD = 115200             # 8 бит, без чётности, 1 стоп-бит
RX_BUF = 1024             # буфер приёма UART, байт
LINE_MAX = 64             # строка длиннее — мусор, сбрасываем

CLASSES = ("person", "car", "bottle", "chair", "dog")   # классы модели экспертов
LINK_TIMEOUT_MS = 3000    # нет строк от A01-AI 3 с -> LINK LOST
OLED_CHARS = 16           # в строке OLED помещается 16 символов

AI_TIMEOUT_S = 10         # тайм-аут проверочного запроса (не более 10 с)
WIFI_TIMEOUT_MS = 10000   # ожидание Wi-Fi при старте
WIFI_RETRY_MS = 10000     # пауза между попытками переподключения
START_SCREEN_MS = 2000    # экран запуска 2 с

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
uart = UART(UART_ID, baudrate=BAUD, bits=8, parity=None, stop=1,
            tx=PIN_TX, rx=PIN_RX, rxbuf=RX_BUF)
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние ----------------
rx = b""                  # накопитель байтов до символа \n
last_rx_ms = 0            # когда пришла последняя корректная строка
link_lost = False
next_wifi = 0


def log(*parts):
    """Журнал: время_мс,поле,поле..."""
    print(",".join([str(time.ticks_ms())] + [str(p) for p in parts]))


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


def wifi_keepalive(now):
    """Раз в 10 с запускает переподключение без ожидания —
    приём от камеры и экран при этом не останавливаются."""
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


# ---------------- ИИ-сервис: один проверочный запрос ----------------
def ai_check():
    """Один запрос при запуске (тайм-аут 10 с). Код 200 -> True.
    В журнал: время_мс,AI_OK или время_мс,AI_ERR,<код или причина>."""
    if secrets is None or not wlan.isconnected():
        log("AI_ERR", "NO_WIFI")
        return False
    r = None
    try:
        gc.collect()                         # TLS требует много памяти
        body = {"model": secrets.MODEL,
                "messages": [{"role": "user", "content": "Reply with one word: OK"}],
                "max_tokens": 5, "temperature": 0}
        headers = {"Content-Type": "application/json",
                   "Authorization": "Bearer " + secrets.API_KEY}
        r = requests.post(secrets.API_URL, data=json.dumps(body).encode(),
                          headers=headers, timeout=AI_TIMEOUT_S)
        if r.status_code == 200:
            log("AI_OK")
            return True
        log("AI_ERR", r.status_code)         # 401 / 429 / 5xx
        return False
    except Exception as e:
        log("AI_ERR", e)                     # тайм-аут, DNS, TLS
        return False
    finally:
        if r is not None:
            r.close()                        # всегда освобождаем сокет


# ---------------- Протокол UART ----------------
def parse(line):
    """Проверка формата. -> ("OBJ", класс, %) / ("NONE",) / None (мусор).
    Чужой класс, уверенность вне 0..100 или лишние поля — None."""
    if line == "NONE":
        return ("NONE",)
    parts = line.split(",")
    if len(parts) != 3 or parts[0] != "OBJ" or parts[1] not in CLASSES:
        return None
    if not parts[2].isdigit():               # "87" — да; "-5", "8.7", "abc" — нет
        return None
    conf = int(parts[2])
    if conf > 100:
        return None
    return ("OBJ", parts[1], conf)


def read_lines():
    """Забирает байты из UART и возвращает список готовых строк."""
    global rx
    lines = []
    n = uart.any()
    if not n:
        return lines
    data = uart.read(n)
    if not data:
        return lines
    rx += data
    while b"\n" in rx:
        raw, rx = rx.split(b"\n", 1)
        try:
            lines.append(raw.decode().strip())
        except Exception:
            pass                             # битые байты — пропускаем строку
    if len(rx) > LINE_MAX:                   # мусор без \n — сбрасываем
        rx = b""
    return lines


# ---------------- Экран ----------------
def show(lines):
    """Выводит [(текст, y), ...]; каждая строка обрезается до 16 символов."""
    oled.fill(0)
    for text, y in lines:
        oled.text(text[:OLED_CHARS], 0, y)
    oled.show()


def show_object(cls, conf):
    show([("AI CAMERA", 0), ("Obj: " + cls, 16), ("Conf: %d%%" % conf, 32)])


def show_none():
    show([("AI CAMERA", 0), ("No object", 24)])


def show_link_lost():
    show([("AI CAMERA", 0), ("LINK LOST", 24)])


def start_screen():
    """Экран запуска 2 с: станция, Wi-Fi, ИИ-сервис."""
    show([("IoT STATION " + STATION, 0)])
    wifi_ok = wifi_connect()
    ai_ok = ai_check()
    show([("IoT STATION " + STATION, 0),
          ("WiFi: " + ("OK" if wifi_ok else "FAIL"), 24),
          ("AI: " + ("READY" if ai_ok else "OFFLINE"), 40)])
    time.sleep_ms(START_SCREEN_MS)


# ---------------- Обработка сообщений ----------------
def handle(msg):
    """OBJ -> экран объекта, журнал, ACK. NONE -> "No object"."""
    if msg[0] == "OBJ":
        cls, conf = msg[1], msg[2]
        show_object(cls, conf)
        log(cls, conf)                       # время_мс,класс,уверенность
        uart.write(b"ACK\n")                 # подтверждение после обработки
    else:
        show_none()


# ---------------- Основная программа ----------------
def main():
    global last_rx_ms, link_lost
    start_screen()
    show([("AI CAMERA", 0), ("Waiting...", 24)])
    last_rx_ms = time.ticks_ms()
    while True:
        try:
            now = time.ticks_ms()
            for line in read_lines():
                msg = parse(line)
                if msg is None:
                    continue                 # некорректная строка — игнорируем
                last_rx_ms = time.ticks_ms()
                link_lost = False            # связь восстановилась сама
                handle(msg)
            if not link_lost and time.ticks_diff(now, last_rx_ms) >= LINK_TIMEOUT_MS:
                link_lost = True
                show_link_lost()
            wifi_keepalive(now)
        except Exception as e:               # программа не должна останавливаться
            print("ERR:", e)
        time.sleep_ms(10)


main()
