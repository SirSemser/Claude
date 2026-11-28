# =====================================================================
#  WSKZ2026 IIoT (marking scheme v3) — Модуль E. Программа A01-AI
#  MaixPy (Kendryte K210): камера -> модель экспертов (KPU, YOLO2) ->
#  LCD (видео QVGA, FPS, красные рамки) -> UART -> ESP32.
#  Рабочее место: XX. На модуль сохранить как main.py (автозапуск).
#  Протокол: "OBJ,<класс>,<уверенность_%>\n" не чаще 5 раз/с,
#            "NONE\n" раз в секунду, если объектов нет.
#  СВЕРИТЬ на площадке: путь к модели, якоря (anchors), порядок классов.
# =====================================================================
import sensor
import lcd
import time
import KPU as kpu
from machine import UART
from fpioa_manager import fm
from Maix import GPIO

# ---------------- Константы ----------------
MODEL_PATH = "/sd/model.kmodel"     # СВЕРИТЬ: модель экспертов (/sd/... или адрес во flash)
CLASSES = ("person", "car", "bottle", "chair", "dog")   # СВЕРИТЬ порядок с моделью
ANCHORS = (1.08, 1.19, 3.42, 4.41, 6.63, 11.38, 9.42, 5.11, 16.62, 10.52)  # СВЕРИТЬ
CONF_MIN = 0.5                      # порог уверенности: ниже — объект не учитываем
NMS = 0.3                           # подавление пересекающихся рамок

PIN_TX = 6                          # IO6 -> GPIO16 (RX) ESP32
PIN_RX = 7                          # IO7 <- GPIO17 (TX) ESP32
BAUD = 115200                       # 8 бит, без чётности, 1 стоп-бит
OBJ_GAP_MS = 200                    # OBJ не чаще 5 раз в секунду
NONE_GAP_MS = 1000                  # NONE раз в секунду

PIN_LCD_EN = 17                     # на A01-AI экран включается низким уровнем на IO17
VFLIP = 1                           # ориентация камеры (на наборе картинка была
HMIRROR = 1                         # перевёрнута; при необходимости поменять на 0)
RED = (255, 0, 0)
YELLOW = (255, 255, 0)

# ---------------- UART: назначаем выводы через FPIOA ----------------
fm.register(PIN_TX, fm.fpioa.UART1_TX, force=True)
fm.register(PIN_RX, fm.fpioa.UART1_RX, force=True)
uart = UART(UART.UART1, BAUD, 8, None, 1, timeout=10, read_buf_len=1024)

# ---------------- Камера и LCD ----------------
fm.register(PIN_LCD_EN, fm.fpioa.GPIO0, force=True)
lcd_en = GPIO(GPIO.GPIO0, GPIO.OUT)
lcd_en.value(0)                     # без этого экран модуля остаётся тёмным
lcd.init()
sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)   # 320 x 240
sensor.set_vflip(VFLIP)
sensor.set_hmirror(HMIRROR)
sensor.run(1)

# ---------------- Модель ----------------
task = kpu.load(MODEL_PATH)
kpu.init_yolo2(task, CONF_MIN, NMS, len(ANCHORS) // 2, ANCHORS)


def best_object(img, objs):
    """Рисует рамку и подпись у каждого объекта с уверенностью >= 0.5
    и возвращает самый уверенный (или None)."""
    best = None
    for o in objs or ():
        if o.value() < CONF_MIN or o.classid() >= len(CLASSES):
            continue                         # ниже порога — не учитываем
        label = "%s %.2f" % (CLASSES[o.classid()], o.value())   # "bottle 0.87"
        img.draw_rectangle(o.rect(), color=RED, thickness=2)
        img.draw_string(o.x(), max(0, o.y() - 20), label, color=RED, scale=2)
        if best is None or o.value() > best.value():
            best = o
    return best


# ---------------- Основной цикл ----------------
clock = time.clock()                         # для счётчика FPS
last_obj = 0
last_none = 0
while True:
    clock.tick()
    img = sensor.snapshot()
    try:
        objs = kpu.run_yolo2(task, img)
    except Exception as e:
        print("KPU", e)
        objs = None
    best = best_object(img, objs)

    # Отправка по UART: самый уверенный объект или NONE
    now = time.ticks_ms()
    if best is not None:
        if time.ticks_diff(now, last_obj) >= OBJ_GAP_MS:
            pct = int(best.value() * 100 + 0.5)
            uart.write("OBJ,%s,%d\n" % (CLASSES[best.classid()], pct))
            last_obj = now
    elif time.ticks_diff(now, last_none) >= NONE_GAP_MS:
        uart.write("NONE\n")
        last_none = now
    if uart.any():
        uart.read()                          # ACK от ESP32 просто вычитываем

    img.draw_string(2, 2, "FPS: %d" % clock.fps(), color=YELLOW, scale=2)
    lcd.display(img)
