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

# ---------------- Константы ----------------
MODEL_PATH = "/sd/20class.kmodel"   # или адрес во флеше, напр. 0x500000
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
lcd.init()
sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)   # 320x240
sensor.run(1)
task = kpu.load(MODEL_PATH)
kpu.init_yolo2(task, CONF_MIN, NMS, 5, ANCHORS)   # 5 = число якорей
clock = time.clock()

last_obj = 0
last_none = 0
last_ack = -ACK_TIMEOUT_MS
rx = b""

while True:
    clock.tick()
    img = sensor.snapshot()
    objs = kpu.run_yolo2(task, img)
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
    if best is not None:
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
