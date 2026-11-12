"""
Симулятор ESP32 для проверки решений на ПК (CPython 3).

Подменяет модули MicroPython (machine, network, ssd1306, neopixel, HCSR04,
rc522, requests, secrets, time) заглушками с виртуальным временем, чтобы
прогнать main.py без платы. Это проверка логики, а не замена реального
стенда: тайминги, драйверы и железо всё равно проверяются на плате.

Запуск:  python3 tests/run_all.py
"""
import io
import json as _json
import os
import sys
import types
import contextlib


class StopSim(BaseException):
    """Останавливает бесконечный цикл main() (BaseException — не ловится except Exception)."""


class Sim:
    def __init__(self, limit_ms):
        self.now = 0
        self.limit = limit_ms
        self.timers = []                 # [period, next_fire, callback, obj]
        self.screens = []                # история показанных экранов
        self.inverted = 0
        self.leds = None
        self.pins = {}                   # номер -> FakePin
        self.adc_value = lambda t: 0
        self.distance = lambda t: 50.0   # см или исключение
        self.ai = lambda prompt: (200, "OK")
        self.prompts = []
        self.uart_in = []                # [(время_мс, bytes)]
        self.uart_out = []
        self.rfid = None
        self.wifi_ok = True

    # ---- виртуальное время ----
    def advance(self, ms):
        end = self.now + ms
        while True:
            due = [t for t in self.timers if t[1] <= end]
            if not due:
                break
            t = min(due, key=lambda x: x[1])
            self.now = t[1]
            t[1] += t[0]
            t[2](t[3])
        self.now = end
        if self.now > self.limit:
            raise StopSim()


SIM = None


def _time_module():
    m = types.ModuleType("time")
    m.ticks_ms = lambda: SIM.now
    m.ticks_diff = lambda a, b: a - b
    m.ticks_add = lambda a, b: a + b
    m.sleep_ms = lambda ms: SIM.advance(ms)
    m.sleep = lambda s: SIM.advance(int(s * 1000))
    m.time = lambda: SIM.now / 1000
    return m


class FakePin:
    IN, OUT = 0, 1
    IRQ_RISING, IRQ_FALLING = 1, 2

    def __init__(self, num, mode=None, value=None, pull=None):
        self.num = num
        self._v = value or 0
        self.history = []
        SIM.pins[num] = self

    def value(self, v=None):
        if v is None:
            f = getattr(self, "reader", None)
            return f(SIM.now) if f else self._v
        if v != self._v:
            self.history.append((SIM.now, v))
        self._v = v

    def on(self):
        self.value(1)

    def off(self):
        self.value(0)


class FakeADC:
    ATTN_11DB, WIDTH_12BIT = 3, 3

    def __init__(self, pin):
        self.pin = pin

    def atten(self, a):
        pass

    def width(self, w):
        pass

    def read(self):
        return int(SIM.adc_value(SIM.now))


class FakeTimer:
    PERIODIC, ONE_SHOT = 1, 0

    def __init__(self, tid):
        pass

    def init(self, period, mode, callback):
        SIM.timers.append([period, SIM.now + period, callback, self])

    def deinit(self):
        SIM.timers[:] = [t for t in SIM.timers if t[3] is not self]


class FakeUART:
    def __init__(self, *a, **k):
        self.buf = b""

    def _pull(self):
        while SIM.uart_in and SIM.uart_in[0][0] <= SIM.now:
            self.buf += SIM.uart_in.pop(0)[1]

    def any(self):
        self._pull()
        return len(self.buf)

    def read(self, n=None):
        self._pull()
        if not self.buf:
            return None
        n = len(self.buf) if n is None else n
        d, self.buf = self.buf[:n], self.buf[n:]
        return d

    def write(self, b):
        SIM.uart_out.append((SIM.now, bytes(b)))


class FakeOLED:
    def __init__(self, w, h, i2c, addr=0x3C):
        self.lines = []
        self.shapes = []

    def fill(self, c):
        self.lines, self.shapes = [], []

    def text(self, s, x, y, c=1):
        assert len(s) <= 16, "строка длиннее 16 символов: %r" % s
        self.lines.append((y, x, s))

    def rect(self, *a):
        self.shapes.append(("rect",) + a)

    def fill_rect(self, *a):
        self.shapes.append(("fill_rect",) + a)

    def ellipse(self, *a):
        self.shapes.append(("ellipse",) + a)

    def pixel(self, *a):
        pass

    def invert(self, v):
        SIM.inverted = v

    def show(self):
        SIM.screens.append((SIM.now, sorted(self.lines), list(self.shapes), SIM.inverted))


class FakeNP:
    def __init__(self, pin, n):
        self.px = [(0, 0, 0)] * n

    def __setitem__(self, i, v):
        self.px[i] = v

    def __getitem__(self, i):
        return self.px[i]

    def write(self):
        SIM.leds = list(self.px)
        SIM.led_history.append((SIM.now, list(self.px)))


class FakeWLAN:
    def __init__(self, mode):
        pass

    def active(self, v=None):
        return True

    def connect(self, ssid, pwd):
        pass

    def disconnect(self):
        pass

    def isconnected(self):
        return SIM.wifi_ok


class FakeResp:
    def __init__(self, status, content):
        self.status_code = status
        self._c = content

    def json(self):
        return {"choices": [{"message": {"content": self._c}}]}

    def close(self):
        pass


def fake_post(url, data=None, json=None, headers=None, timeout=None):
    body = _json.loads(data)
    prompt = body["messages"][0]["content"]
    SIM.prompts.append(prompt)
    assert headers["Authorization"].startswith("Bearer ")
    assert 0 < body["max_tokens"] <= 400 and body["temperature"] == 0
    SIM.advance(300)                       # задержка сети
    status, content = SIM.ai(prompt)
    return FakeResp(status, content)


class FakeHCSR04:
    def __init__(self, tri, ech):
        pass

    def distance(self):
        return SIM.distance(SIM.now)


class FakeCard:
    """MIFARE S50: 64 блока по 16 байт."""

    def __init__(self, uid4):
        bcc = uid4[0] ^ uid4[1] ^ uid4[2] ^ uid4[3]
        self.uid = list(uid4) + [bcc]
        self.blocks = [bytes(16) for _ in range(64)]


class FakeRC522:
    MI_OK, MI_ERR = 0, 2

    def __init__(self):
        self.authed = False

    def Init_spi(self, rst, nss, sck, mosi, miso):
        assert isinstance(sck, FakePin) and isinstance(miso, FakePin)

    def _card(self):
        return SIM.rfid(SIM.now) if SIM.rfid else None

    def SeekCard(self, mode):
        c = self._card()
        return (0, [0x04, 0x00]) if c else (2, None)

    def Anticoll(self):
        c = self._card()
        return (0, list(c.uid)) if c else (2, [])

    def select_tag(self, uid):
        return 0 if self._card() else 2

    def auth(self, mode, block, key, uid):
        self.authed = key == [0xFF] * 6 and mode == 0x60
        return 0 if self.authed else 2

    def read(self, block):
        c = self._card()
        if not (c and self.authed):
            return None
        return list(c.blocks[block])

    def write(self, block, data):
        c = self._card()
        assert block not in (0, 3, 7, 11, 15), "запись в служебный блок!"
        if not (c and self.authed) or len(data) != 16:
            return 2
        c.blocks[block] = bytes(data)
        return 0

    def stop_crypto1(self):
        self.authed = False


def install(limit_ms):
    """Создаёт новую симуляцию и подменяет модули MicroPython."""
    global SIM
    SIM = Sim(limit_ms)
    SIM.led_history = []
    mods = {}
    machine = types.ModuleType("machine")
    machine.Pin = FakePin
    machine.SoftI2C = lambda **k: None
    machine.I2C = lambda *a, **k: None
    machine.ADC = FakeADC
    machine.Timer = FakeTimer
    machine.UART = FakeUART
    mods["machine"] = machine
    network = types.ModuleType("network")
    network.STA_IF = 0
    network.WLAN = FakeWLAN
    mods["network"] = network
    ssd = types.ModuleType("ssd1306")
    ssd.SSD1306_I2C = FakeOLED
    mods["ssd1306"] = ssd
    neo = types.ModuleType("neopixel")
    neo.NeoPixel = FakeNP
    mods["neopixel"] = neo
    hc = types.ModuleType("HCSR04")
    hc.HCSR04 = FakeHCSR04
    mods["HCSR04"] = hc
    rc = types.ModuleType("rc522")
    rc.MFRC522 = FakeRC522
    rc.MI_OK = 0
    mods["rc522"] = rc
    req = types.ModuleType("requests")
    req.post = fake_post
    mods["requests"] = req
    sec = types.ModuleType("secrets")
    sec.WIFI_SSID, sec.WIFI_PASS = "ssid", "pass"
    sec.API_URL, sec.API_KEY, sec.MODEL = "https://x/v1/chat/completions", "k", "m"
    mods["secrets"] = sec
    mods["time"] = _time_module()
    mods["gc"] = types.SimpleNamespace(collect=lambda: None)
    for k, v in mods.items():
        sys.modules[k] = v
    return SIM


def run(path, limit_ms, setup=None, cwd=None):
    """Выполняет main.py до limit_ms виртуального времени. -> (sim, globals, лог)."""
    sim = install(limit_ms)
    if setup:
        setup(sim)
    src = open(path, encoding="utf-8").read()
    ns = {"__name__": "__main__"}
    out = io.StringIO()
    old = os.getcwd()
    if cwd:
        os.chdir(cwd)
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(src, path, "exec"), ns)
    except StopSim:
        pass
    finally:
        os.chdir(old)
    return sim, ns, out.getvalue().splitlines()


def screen_at(sim, t):
    """Последний экран, показанный не позже момента t."""
    last = None
    for s in sim.screens:
        if s[0] <= t:
            last = s
    return last


def texts(screen):
    return [s for (y, x, s) in screen[1]] if screen else []
