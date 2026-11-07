# =====================================================================
#  WSKZ2026 IIoT — Модуль C1. ИИ-камера распознавания объектов (ESP32)
#  A01-AI --UART2 115200 8N1--> ESP32 --I2C--> OLED,  ESP32 --HTTPS--> ИИ
#  Протокол: "OBJ,<класс>,<уверенность_%>\n" | "NONE\n";  ответ ESP32: "ACK\n"
# =====================================================================
import time
import json
import gc
import network
from machine import Pin, SoftI2C, UART
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
PIN_RX = 16               # <- TX A01-AI (IO6)
PIN_TX = 17               # -> RX A01-AI (IO7)
UART_ID = 2
BAUD = 115200
RX_BUF = 4096             # буфер приёма: строки не теряются во время запроса к ИИ

CONFIRM_N = 3             # новый объект — после 3 одинаковых сообщений подряд
LINK_TIMEOUT_MS = 3000    # нет сообщений > 3 с -> LINK LOST
STAT_MS = 30000           # статистика раз в 30 с
CLASSES = ("aeroplane", "bicycle", "bird", "boat", "bottle", "bus", "car",
           "cat", "chair", "cow", "diningtable", "dog", "horse", "motorbike",
           "person", "pottedplant", "sheep", "sofa", "train", "tvmonitor")
                          # СВЕРИТЬ со списком 20 классов от экспертов

AI_TIMEOUT_S = 10
AI_MIN_GAP_MS = 5000
AI_RETRY_MS = 10000
WIFI_RETRY_MS = 10000
START_SCREEN_MS = 2000
TYPES = ("HUMAN", "ANIMAL", "TRANSPORT", "HOME")
PROMPT = ("A camera detected an object of class '{}'. Classify it as one of: "
          "HUMAN, ANIMAL, TRANSPORT, HOME. Reply with exactly one word.")

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
uart = UART(UART_ID, baudrate=BAUD, bits=8, parity=None, stop=1,
            tx=PIN_TX, rx=PIN_RX, rxbuf=RX_BUF)
wlan = network.WLAN(network.STA_IF)

# ---------------- Состояние ----------------
rx = b""                  # накопитель байтов до символа \n
cand = None               # класс-кандидат и длина серии
cand_n = 0
shown = None              # подтверждённый класс на экране
shown_conf = 0
shown_type = "?"
no_object = True
link_lost = False
last_rx_ms = 0
type_cache = {}           # класс -> тип (кэш ответов ИИ)
pending = None            # (класс, уверенность) — ждёт ответа ИИ
counts = {}               # класс -> число подтверждений
ai_wait_until = 0
dirty = True              # экран нужно перерисовать
next_stat = 0
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


def pick_word(text, allowed):
    t = text.upper()
    found = [w for w in allowed if w in t]
    return found[0] if len(found) == 1 else None


def ai_step(now):
    """Запрос типа для подтверждённого класса, которого нет в кэше."""
    global pending, shown_type, ai_wait_until
    if pending is None or time.ticks_diff(now, ai_wait_until) < 0:
        return
    cls, conf = pending
    log("AI_REQ")
    try:
        word = pick_word(ai_request(PROMPT.format(cls)), TYPES)
        ai_wait_until = time.ticks_add(time.ticks_ms(), AI_MIN_GAP_MS)
        if word is None:
            log("AI_BAD")
            typ = "?"
        else:
            log("AI_ANS", word)
            type_cache[cls] = word             # в кэш — только допустимый тип
            typ = word
    except Exception as e:
        log("AI_ERR", e)
        ai_wait_until = time.ticks_add(time.ticks_ms(), AI_RETRY_MS)
        typ = "?"
    pending = None
    log(cls, conf, typ)                        # журнал подтверждённого объекта
    if shown == cls:
        shown_type = typ
        mark()


# ---------------- Экран ----------------
def mark():
    """Перерисовать экран один раз в конце итерации, а не на каждую строку."""
    global dirty
    dirty = True


def draw():
    oled.fill(0)
    oled.text("AI CAMERA", 0, 0)
    if link_lost:
        oled.text("LINK LOST", 0, 24)
    elif no_object or shown is None:
        oled.text("No object", 0, 24)
    else:
        oled.text(("Obj: " + shown)[:16], 0, 16)
        oled.text("Conf: %d%%" % shown_conf, 0, 32)
        oled.text("Type: " + shown_type, 0, 48)
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


# ---------------- Разбор протокола ----------------
def parse(line):
    """-> ("NONE",) | ("OBJ", класс, conf) | None для некорректной строки."""
    try:
        s = line.decode().strip()
    except Exception:
        return None
    if s == "NONE":
        return ("NONE",)
    p = s.split(",")
    if len(p) != 3 or p[0] != "OBJ" or p[1] not in CLASSES:
        return None
    try:
        conf = int(p[2])
    except ValueError:
        return None
    if not 0 <= conf <= 100:
        return None
    return ("OBJ", p[1], conf)


def confirm(cls, conf):
    """Объект подтверждён (3 сообщения подряд)."""
    global shown, shown_conf, shown_type, pending
    shown, shown_conf = cls, conf
    counts[cls] = counts.get(cls, 0) + 1
    if cls in type_cache:
        shown_type = type_cache[cls]
        log(cls, conf, shown_type)
    else:
        if pending is not None:                # предыдущий так и не дождался ИИ
            log(pending[0], pending[1], "?")
        pending = (cls, conf)
        shown_type = "..."


def handle(msg):
    global cand, cand_n, shown_conf, no_object
    if msg[0] == "NONE":
        cand, cand_n = None, 0
        no_object = True
        mark()
        return
    _, cls, conf = msg
    uart.write(b"ACK\n")                       # подтверждаем каждое сообщение OBJ
    if cls == cand:
        cand_n += 1
    else:
        cand, cand_n = cls, 1
    if cand_n == CONFIRM_N:
        no_object = False
        confirm(cls, conf)
        mark()
    elif cand_n > CONFIRM_N and cls == shown:
        shown_conf = conf                      # тот же объект — обновляем %
        mark()


def read_uart(now):
    global rx, last_rx_ms, link_lost
    n = uart.any()
    if not n:
        return
    rx += uart.read(n)
    while b"\n" in rx:
        line, rx = rx.split(b"\n", 1)
        last_rx_ms = now
        if link_lost:                          # связь восстановилась
            link_lost = False
            mark()
        msg = parse(line)
        if msg:
            handle(msg)                        # некорректные строки игнорируем
    if len(rx) > 256:                          # мусор без \n — сбрасываем
        rx = b""


def print_stat():
    items = ["%s:%d" % (k, v) for k, v in counts.items() if v > 0]
    print(",".join(["STAT"] + items))


def main():
    global last_rx_ms, link_lost, next_stat, dirty
    start_screen()
    draw()
    last_rx_ms = time.ticks_ms()
    next_stat = time.ticks_add(last_rx_ms, STAT_MS)
    while True:
        try:
            now = time.ticks_ms()
            read_uart(now)
            if (not link_lost and
                    time.ticks_diff(now, last_rx_ms) > LINK_TIMEOUT_MS):
                link_lost = True
                mark()
            if time.ticks_diff(now, next_stat) >= 0:
                next_stat = time.ticks_add(now, STAT_MS)
                print_stat()
            if dirty:                          # сначала показать "Type: ..."
                draw()
                dirty = False
            wifi_keepalive(now)
            ai_step(now)                       # пока ждём ИИ, UART копит строки
        except Exception as e:
            print("ERR:", e)
        time.sleep_ms(10)


main()
