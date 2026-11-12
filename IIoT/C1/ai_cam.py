# =====================================================================
#  WSKZ2026 IIoT — Модуль C1. Программа AI-модуля A01-AI
#  Написано под MaixPy (чип Kendryte K210: KPU, sensor, lcd, fpioa).
#  СВЕРИТЬ на С-1: прошивку модуля, путь к модели, якоря (anchors),
#  список классов. На модуль сохранить как main.py (автозапуск).
# =====================================================================
import sensor
import lcd
import time
import KPU as kpu
from machine import UART
from fpioa_manager import fm
from Maix import GPIO

# ---------------- Константы ----------------
# Где искать модель (по порядку). На наборе 2026-11-12: SD нет, во флеше
# по адресам 0x300000..0xA00000 модели нет, в /flash свободно 2,6 МБ.
MODEL_PATHS = ("/sd/20class.kmodel", "/flash/20class.kmodel", 0x500000)
PIN_LCD_EN = 17                     # на A01-AI экран включается низким уровнем на IO17
# Ориентация камеры. На наборе 2026-11-12 картинка была перевёрнута:
# VFLIP=1 и HMIRROR=1 вместе дают поворот на 180°. Если станет зеркально,
# поменяй HMIRROR на 0; если вверх ногами — VFLIP на 0.
VFLIP = 1
HMIRROR = 1
CONF_MIN = 0.5                      # порог уверенности
NMS = 0.3
ANCHORS = (1.08, 1.19, 3.42, 4.41, 6.63, 11.38, 9.42, 5.11, 16.62, 10.52)
CLASSES = ("aeroplane", "bicycle", "bird", "boat", "bottle", "bus", "car",
           "cat", "chair", "cow", "diningtable", "dog", "horse", "motorbike",
           "person", "pottedplant", "sheep", "sofa", "train", "tvmonitor")
PIN_TX = 6                          # IO6 -> RX ESP32 (GPIO16)
PIN_RX = 7                          # IO7 <- TX ESP32 (GPIO17)
BAUD = 115200
OBJ_GAP_MS = 200                    # OBJ не чаще 5 раз в секунду
NONE_GAP_MS = 1000                  # NONE раз в секунду
ACK_TIMEOUT_MS = 2000               # нет ACK > 2 с -> NO LINK
LCD_W = 320
CHAR_W = 16                         # ширина символа при scale=2 (СВЕРИТЬ)
RED = (255, 0, 0)
YELLOW = (255, 255, 0)
GREEN = (0, 255, 0)

# ---------------- UART: назначаем выводы через FPIOA ----------------
fm.register(PIN_TX, fm.fpioa.UART1_TX, force=True)
fm.register(PIN_RX, fm.fpioa.UART1_RX, force=True)
uart = UART(UART.UART1, BAUD, 8, None, 1, timeout=10, read_buf_len=1024)

# ---------------- Камера, экран, модель ----------------
fm.register(PIN_LCD_EN, fm.fpioa.GPIO0, force=True)
lcd_en = GPIO(GPIO.GPIO0, GPIO.OUT)
lcd_en.value(0)                     # без этого экран модуля остаётся тёмным
lcd.init()
sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)   # 320x240
sensor.set_vflip(VFLIP)
sensor.set_hmirror(HMIRROR)
sensor.run(1)


def load_model():
    for p in MODEL_PATHS:
        try:
            t = kpu.load(p)
            kpu.init_yolo2(t, CONF_MIN, NMS, 5, ANCHORS)   # 5 = число якорей
            print("MODEL", p)
            return t
        except Exception as e:
            print("NO MODEL", p, e)
    return None


task = load_model()
# Без модели — режим проверки связи: раз в 200 мс шлём OBJ,bottle,87,
# на экране модуля надпись NO MODEL: DEMO. С моделью этот режим не включается.
DEMO = task is None
clock = time.clock()

last_obj = 0
last_none = 0
last_ack = -ACK_TIMEOUT_MS
rx = b""

while True:
    clock.tick()
    img = sensor.snapshot()
    objs = None
    if not DEMO:
        try:
            objs = kpu.run_yolo2(task, img)
        except Exception as e:
            print("KPU", e)
    best = None
    if objs:
        for o in objs:
            if o.value() < CONF_MIN:
                continue
            label = "%s %.2f" % (CLASSES[o.classid()], o.value())
            img.draw_rectangle(o.rect(), color=RED, thickness=2)
            img.draw_string(o.x(), max(0, o.y() - 20), label, color=RED, scale=2)
            if best is None or o.value() > best.value():
                best = o                     # передаём самый уверенный объект

    now = time.ticks_ms()
    if DEMO:
        if time.ticks_diff(now, last_obj) >= OBJ_GAP_MS:
            uart.write("OBJ,bottle,87\n")
            last_obj = now
        img.draw_string(2, 200, "NO MODEL: DEMO", color=RED, scale=2)
    elif best is not None:
        if time.ticks_diff(now, last_obj) >= OBJ_GAP_MS:
            pct = int(best.value() * 100 + 0.5)
            uart.write("OBJ,%s,%d\n" % (CLASSES[best.classid()], pct))
            last_obj = now
    elif time.ticks_diff(now, last_none) >= NONE_GAP_MS:
        uart.write("NONE\n")
        last_none = now

    if uart.any():                           # ищем ACK от ESP32
        data = uart.read()
        if data:
            rx = (rx + data)[-32:]
            if b"ACK\n" in rx:
                last_ack = now
                rx = b""

    link = "LINK OK" if time.ticks_diff(now, last_ack) <= ACK_TIMEOUT_MS else "NO LINK"
    img.draw_string(2, 2, "FPS: %d" % clock.fps(), color=YELLOW, scale=2)
    img.draw_string(LCD_W - len(link) * CHAR_W - 2, 2, link,
                    color=GREEN if link == "LINK OK" else RED, scale=2)
    lcd.display(img)
