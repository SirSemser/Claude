# =====================================================================
#  WSKZ2026 IIoT — Модуль B2. RFID-контроль доступа
#  ESP32 + MFRC522 (SPI) + карты MIFARE S50 + OLED + ИИ-сервис
#  Регистрация карты: запустить main.py в Thonny, Ctrl+C, в Shell: register()
# =====================================================================
import time
import json
import gc
import network
from machine import Pin
try:
    from machine import SoftI2C          # MicroPython >= 1.14
except ImportError:                      # 1.13 (прошивка набора ZL-02B)
    from machine import I2C

    def SoftI2C(scl, sda):
        return I2C(-1, scl=scl, sda=sda)

import ssd1306
import rc522

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
PIN_RST = 16
PIN_NSS = 13
PIN_SCK = 15
PIN_MOSI = 32
PIN_MISO = 2

POLL_MS = 200             # пауза цикла опроса
RESULT_MS = 2000          # результат на экране 2 с
SAME_CARD_MS = 3000       # повтор той же карты не раньше 3 с
REQ_ALL = 0x52            # команда поиска всех карт (WUPA)
AUTH_KEY_A = 0x60         # AUTHENT1A
KEY_A = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]   # заводской ключ
BLOCK_NAME = 8            # сектор 2, блок 0 — имя (16 байт)
BLOCK_VISITS = 9          # сектор 2, блок 1 — счётчик проходов
USERS_FILE = "users.json"
NAME_MAX = 11
LOG_N = 10                # сколько записей журнала отправлять ИИ

AI_TIMEOUT_S = 10
AI_MIN_GAP_MS = 5000      # не чаще 1 запроса в 5 с
AI_RETRY_MS = 10000       # после ошибки — не раньше 10 с
WIFI_RETRY_MS = 10000
START_SCREEN_MS = 2000
RISK_WORDS = ("LOW", "MEDIUM", "HIGH")
PROMPT = ("Greenhouse door access log, format time_ms,uid,name,result,visits "
          "(result OK, UNKNOWN or MISMATCH):\n{}\nEstimate the security risk. "
          "Reply with exactly one word: LOW, MEDIUM or HIGH.")

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
wlan = network.WLAN(network.STA_IF)

# ===== Обёртки драйвера rc522.py (API по руководству ZL-02B, опыт 4.21) =====
rfid = rc522.MFRC522()                                 # как в руководстве ZL-02B, опыт 4.21
rfid.Init_spi(rst=PIN_RST, nss=PIN_NSS, sck=Pin(PIN_SCK), mosi=Pin(PIN_MOSI), miso=Pin(PIN_MISO))
MI_OK = rfid.MI_OK


def card_seek():
    """-> (True, tag_type) если карта есть. tag_type — 2 байта."""
    stat, tag_type = rfid.SeekCard(REQ_ALL)
    return stat == MI_OK, tag_type


def card_uid():
    """-> список из 5 байт (4 байта UID + контрольный BCC) или None."""
    stat, uid = rfid.Anticoll()
    return uid if stat == MI_OK else None


def card_open(uid):
    """select_tag + авторизация сектора 2 ключом A. -> True/False."""
    if rfid.select_tag(uid) != MI_OK:
        print("Failed to select tag")
        return False
    if rfid.auth(AUTH_KEY_A, BLOCK_NAME, KEY_A, uid) != MI_OK:
        print("Authentication error")
        return False
    return True


def card_read(block):
    data = rfid.read(block)            # СВЕРИТЬ: список 16 байт или (stat, data)
    if isinstance(data, tuple):
        data = data[1] if data[0] == MI_OK else None
    if data is None or len(data) < 16:
        raise OSError("read error")
    return bytes(data[:16])


def card_write(block, data16):
    if block not in (BLOCK_NAME, BLOCK_VISITS):        # защита служебных блоков!
        raise ValueError("forbidden block")
    return rfid.write(block, data16) == MI_OK
# =============================================================================


# ---------------- Состояние ----------------
users = {}
access_log = []           # последние 10 строк журнала
risk = "N/A"
last_uid = ""
last_uid_ms = 0
ai_wait_until = 0         # раньше этого момента запрос не отправляем
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


def ai_risk():
    """Оценка риска по 10 последним записям журнала."""
    global risk, ai_wait_until
    now = time.ticks_ms()
    if time.ticks_diff(now, ai_wait_until) < 0:
        return                                 # лимит частоты запросов
    log("AI_REQ")
    try:
        word = pick_word(ai_request(PROMPT.format("\n".join(access_log))),
                         RISK_WORDS)
        ai_wait_until = time.ticks_add(time.ticks_ms(), AI_MIN_GAP_MS)
        if word is None:
            log("AI_BAD")                      # оставляем прежний уровень
            return
        log("AI_ANS", word)
        risk = word
        if risk == "HIGH":
            log("ALERT")
    except Exception as e:
        log("AI_ERR", e)
        risk = "N/A"
        ai_wait_until = time.ticks_add(time.ticks_ms(), AI_RETRY_MS)


# ---------------- Справочник и данные карты ----------------
def load_users():
    global users
    try:
        with open(USERS_FILE) as f:
            users = json.load(f)
    except Exception as e:
        print("users.json error:", e)
        users = {}


def tag_hex(tag):
    """Тип карты 2 байта -> '0x0400' (для S50). Драйвер может вернуть int или список."""
    if isinstance(tag, int):
        return "0x%04X" % tag
    return "0x%02X%02X" % (tag[0], tag[1])


def uid_hex(uid):
    """Первые 4 байта -> 'UID' из 8 HEX-символов верхнего регистра."""
    return "%02X%02X%02X%02X" % (uid[0], uid[1], uid[2], uid[3])


def name_to_block(name):
    return (name + " " * 16)[:16].encode()      # дополняем пробелами до 16 байт


def block_to_name(data):
    try:
        return data.decode().strip()
    except Exception:
        return None                              # мусор вместо текста


def visits_to_block(n):
    return n.to_bytes(4, "big") + bytes(12)      # 4 байта числа + 12 нулей


def block_to_visits(data):
    return int.from_bytes(data[:4], "big")


# ---------------- Экран ----------------
def screen(lines, inverse=False):
    oled.fill(0)
    for y, txt in lines:
        oled.text(txt[:16], 0, y)
    oled.invert(1 if inverse else 0)
    oled.show()


def idle_screen():
    screen([(0, "Access Control"), (24, "Place card"), (48, "Risk: " + risk)],
           inverse=(risk == "HIGH"))


def start_screen():
    screen([(0, "IoT STATION " + STATION)])
    wifi_ok = wifi_connect()
    ai_ok = wifi_ok and ai_check()
    screen([(0, "IoT STATION " + STATION),
            (24, "WiFi: " + ("OK" if wifi_ok else "FAIL")),
            (40, "AI: " + ("READY" if ai_ok else "OFFLINE"))])
    time.sleep_ms(START_SCREEN_MS)


# ---------------- Проверка доступа ----------------
def journal(uid, name, result, visits):
    line = "%d,%s,%s,%s,%s" % (time.ticks_ms(), uid, name, result, visits)
    print(line)
    access_log.append(line)
    if len(access_log) > LOG_N:
        access_log.pop(0)


def check_access(raw_uid):
    """Возвращает True, если была попытка прохода (нужен запрос к ИИ)."""
    uid = uid_hex(raw_uid)
    if uid not in users:
        screen([(0, "DENIED"), (16, "UID:" + uid), (32, "Unknown card")])
        journal(uid, "-", "UNKNOWN", "-")
        return True
    if not card_open(raw_uid):                 # ошибка выбора/авторизации
        rfid.stop_crypto1()
        return False
    try:
        name = block_to_name(card_read(BLOCK_NAME))
        visits = block_to_visits(card_read(BLOCK_VISITS))
        if name != users[uid]:
            screen([(0, "DENIED"), (16, "UID:" + uid), (32, "Data mismatch")])
            journal(uid, "-", "MISMATCH", "-")
        else:
            visits += 1
            card_write(BLOCK_VISITS, visits_to_block(visits))
            screen([(0, "ACCESS OK"), (16, "UID:" + uid),
                    (32, "Name:" + name), (48, "Visits: %d" % visits)])
            journal(uid, name, "OK", visits)
        return True
    except Exception as e:
        print("Card error:", e)
        return False
    finally:
        rfid.stop_crypto1()


# ---------------- Регистрация (вызывается из Shell) ----------------
def register(name=None, timeout_s=30):
    """Ждёт карту, пишет имя в блок 8 и 0 в блок 9."""
    load_users()
    print("Place card...")
    t0 = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), t0) < timeout_s * 1000:
        found, tag = card_seek()
        raw = card_uid() if found else None
        if raw:
            uid = uid_hex(raw)
            who = name or users.get(uid)
            if not who or len(who) > NAME_MAX:
                screen([(0, "REGISTER"), (16, "UID:" + uid), (48, "WRITE ERROR")])
                print("Name not found in users.json:", uid)
                return False
            screen([(0, "REGISTER"), (16, "UID:" + uid), (32, "Write: " + who)])
            ok = False
            try:
                if card_open(raw):
                    ok = (card_write(BLOCK_NAME, name_to_block(who)) and
                          card_write(BLOCK_VISITS, visits_to_block(0)))
            except Exception as e:
                print("Write error:", e)
            finally:
                rfid.stop_crypto1()
            screen([(0, "REGISTER"), (16, "UID:" + uid), (32, "Write: " + who),
                    (48, "WRITE OK" if ok else "WRITE ERROR")])
            return ok
        time.sleep_ms(POLL_MS)
    print("No card")
    return False


# ---------------- Основной цикл ----------------
def main():
    global last_uid, last_uid_ms
    load_users()
    start_screen()
    idle_screen()
    while True:
        try:
            now = time.ticks_ms()
            wifi_keepalive(now)
            found, tag = card_seek()
            if found:
                print("tag type: " + tag_hex(tag))
                raw = card_uid()
                if raw:
                    uid = uid_hex(raw)
                    same = (uid == last_uid and
                            time.ticks_diff(now, last_uid_ms) < SAME_CARD_MS)
                    if not same:
                        attempt = check_access(raw)
                        last_uid, last_uid_ms = uid, time.ticks_ms()
                        time.sleep_ms(RESULT_MS)   # результат держится 2 с
                        idle_screen()
                        if attempt:
                            ai_risk()              # после показа результата
                            idle_screen()
        except Exception as e:
            print("ERR:", e)
        time.sleep_ms(POLL_MS)


main()
