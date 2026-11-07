# =====================================================================
#  WSKZ2026 AI-IoT — Модуль B (части B1+B2+B3). RFID-пропуска
#  ESP32 + MFRC522 (SPI) + OLED + карта MIFARE S50
#  B1: SeekCard / NO_CARD   B2: Anticoll + select_tag   B3: auth, write, read
# =====================================================================
import time
from machine import Pin, SoftI2C
import ssd1306
import rc522

# ---------------- Константы ----------------
PIN_RST = 16
PIN_NSS = 13
PIN_SCK = 15
PIN_MOSI = 32
PIN_MISO = 2
PIN_SDA = 23
PIN_SCL = 19
POLL_MS = 200
REQ_ALL = 0x52                       # PICC_REQALL
AUTH_KEY_A = 0x60                    # AUTHENT1A
KEY = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]
BLOCK = 8                            # блок 0 сектора 2 — единственный для записи!
DATA = b"\x01\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x55"

# ---------------- Оборудование ----------------
i2c = SoftI2C(scl=Pin(PIN_SCL), sda=Pin(PIN_SDA))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)
rfid = rc522.RC522()                                   # СВЕРИТЬ с драйвером
rfid.Init_spi(PIN_RST, PIN_NSS, PIN_SCK, PIN_MOSI, PIN_MISO)
MI_OK = rc522.MI_OK if hasattr(rc522, "MI_OK") else rfid.MI_OK


def show(text):
    oled.fill(0)
    oled.text(text, 0, 0)
    oled.show()


def tag_hex(tag):
    if isinstance(tag, int):
        return "0x%04X" % tag
    return "0x%02X%02X" % (tag[0], tag[1])


def work_with_card():
    """B2 + B3: номер, выбор, авторизация, запись и чтение блока 8."""
    stat, card_id = rfid.Anticoll()
    if stat != MI_OK:
        return
    print("card_id=", card_id)
    if rfid.select_tag(card_id) != MI_OK:
        print("Failed to select tag")
        return
    try:
        if rfid.auth(AUTH_KEY_A, BLOCK, KEY, card_id) != MI_OK:
            print("Authentication error")
            return
        rfid.write(BLOCK, DATA)
        data = rfid.read(BLOCK)
        print("Address 8 data:", data)
        show("READ OK")
    finally:
        rfid.stop_crypto1()


def main():
    while True:
        try:
            stat, tag = rfid.SeekCard(REQ_ALL)
            if stat == MI_OK:
                print("tag type:", tag_hex(tag))
                work_with_card()
            else:
                print("NO_CARD")
                show("NO_CARD")
        except Exception as e:
            print("ERR:", e)
        time.sleep_ms(POLL_MS)


main()
