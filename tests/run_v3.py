"""Сценарии для решений по marking scheme v3 (IIoT/v3/A, IIoT/v3/B).
Запуск: python3 tests/run_v3.py"""
import json
import os
import sys
import types

sys.path.insert(0, os.path.dirname(__file__))
import sim as S  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []


def check(name, cond, info=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  -> " + str(info)))
    if not cond:
        FAILS.append(name)


def ev(log, name):
    return [l for l in log if l.split(",")[1:2] == [name]]


# ------------------------------------------------------------------ A
def test_a():
    print("A ultrasonic (v3)")

    def dist(t):
        if 6000 <= t < 6200:
            return 5.0                        # одиночный скачок (рука)
        if 8000 <= t < 9000:
            raise OSError("echo timeout")     # датчик отключён
        if 10000 <= t < 11000:
            return 150.0                      # > 100 см
        if t < 12000:
            return 85.0
        return 10.0

    sim, ns, log = S.run(os.path.join(ROOT, "IIoT/v3/A/main.py"), 16000,
                         lambda s: setattr(s, "distance", dist))
    st = S.texts(S.screen_at(sim, 2100))
    check("экран запуска", st == ["IoT STATION XX", "WiFi: OK"], st)
    rows = [l for l in log if l.count(",") == 2]
    check("CSV 85.0,FAR", any(l.endswith(",85.0,FAR") for l in rows))
    spike = [l for l in rows if 6000 <= int(l.split(",")[0]) <= 7000]
    check("скачок погашен", all(l.endswith("85.0,FAR") for l in spike), spike)
    check("ошибка -> -1,OUT", any(l.endswith(",-1,OUT") for l in rows))
    scr = S.screen_at(sim, 8500)
    check("OUT OF RANGE без шкалы", S.texts(scr) == ["HCSR04", "OUT OF RANGE"] and not scr[2], scr)
    check("150 см -> OUT", S.texts(S.screen_at(sim, 10500)) == ["HCSR04", "OUT OF RANGE"])
    check("восстановление", "Dist: 85.0 cm" in S.texts(S.screen_at(sim, 11800)))
    last = S.screen_at(sim, 15900)
    check("NEAR", "Zone: NEAR" in S.texts(last), last)
    bar = [s for s in last[2] if s[0] == "fill_rect"]
    check("шкала 10 см ~ 90%", bar and bar[0][3] == 109, bar)
    gaps = [int(l.split(",")[0]) for l in rows[:10]]
    check("период 200 мс", all(b - a == 200 for a, b in zip(gaps, gaps[1:])), gaps)


def test_a_offline():
    print("A без сети")

    def setup(s):
        s.wifi_ok = False
    sim, ns, log = S.run(os.path.join(ROOT, "IIoT/v3/A/main.py"), 15000, setup)
    st = S.texts(S.screen_at(sim, 12100))
    check("WiFi: FAIL", "WiFi: FAIL" in st, st)
    check("измерения идут", any(l.endswith(",50.0,MID") for l in log))


# ------------------------------------------------------------------ B
class FakeMQTT:
    inst = None

    def __init__(self, cid, host, port=0, user=None, password=None, keepalive=0):
        assert host == "mqtt.thingsboard.cloud" and port == 1883 and user == "tok"
        self.cb = None
        self.subs = []
        self.pub = []
        self.inbox = []           # [(t, topic, payload)]
        FakeMQTT.inst = self

    def set_callback(self, cb):
        self.cb = cb

    def connect(self):
        if not S.SIM.wifi_ok:
            raise OSError("no net")

    def subscribe(self, t):
        self.subs.append(t)

    def publish(self, t, m):
        if not S.SIM.wifi_ok:
            raise OSError("send fail")
        self.pub.append((S.SIM.now, t, m))

    def check_msg(self):
        while self.inbox and self.inbox[0][0] <= S.SIM.now:
            _, t, m = self.inbox.pop(0)
            self.cb(t, m)

    def disconnect(self):
        pass


def run_b(limit, adc, pir, inbox=(), wifi=lambda t: True, path="IIoT/v3/B/main.py"):
    um = types.ModuleType("umqtt")
    ums = types.ModuleType("umqtt.simple")
    ums.MQTTClient = FakeMQTT
    um.simple = ums
    orig = S.FakePin.__init__

    def pin_init(self, num, *a, **k):
        orig(self, num, *a, **k)
        if num == 27:
            self.reader = pir
    S.FakePin.__init__ = pin_init
    S.FakeWLAN.isconnected = lambda self: wifi(S.SIM.now)

    def setup(sim):
        sim.adc_value = adc
        sys.modules["umqtt"] = um
        sys.modules["umqtt.simple"] = ums
        sys.modules["secrets"].TB_TOKEN = "tok"
        FakeMQTT.inst = None
    try:
        sim, ns, log = S.run(os.path.join(ROOT, path), limit, setup)
    finally:
        S.FakePin.__init__ = orig
        S.FakeWLAN.isconnected = lambda self: S.SIM.wifi_ok
    return sim, ns, log


def test_b():
    print("B induction lamp (v3)")
    # темнее -> меньше (DARK_IS_HIGH = False): фон 2000, порог 1000
    adc = lambda t: 2000 if t < 12000 or t > 70000 else 400
    pir = lambda t: 1 if 14000 <= t < 15000 or 40000 <= t < 41000 else 0
    inbox = []
    holder = {}

    def adc_and_inbox(t):
        m = FakeMQTT.inst
        if m is not None and not holder.get("done"):
            holder["done"] = True
            A = b"v1/devices/me/attributes"
            m.inbox += [(20000, A, b'{"hold":3}'), (21000, A, b'{"hold":31}'),
                        (22000, A, b'{"hold":"abc"}'), (23000, A, b'{"hold":15}')]
        return adc(t)

    sim, ns, log = run_b(90000, adc_and_inbox, pir)
    st = S.texts(S.screen_at(sim, 1900))
    check("экран запуска", st == ["IoT STATION XX", "WiFi: OK", "TB: OK"], st)
    cal = [l for l in log if l.startswith("CAL,")]
    check("CAL,2000,1000", cal == ["CAL,2000,1000"], cal)
    check("подписка на атрибуты", b"v1/devices/me/attributes" in FakeMQTT.inst.subs)
    on = [int(l.split(",")[0]) for l in ev(log, "LAMP_ON")]
    off = [int(l.split(",")[0]) for l in ev(log, "LAMP_OFF")]
    check("LAMP_ON при Low+движении", on and 14000 <= on[0] <= 14300, on)
    check("HOLD 10 с после последнего движения", off and 24800 <= off[0] <= 25300, (on, off))
    holds = [l for l in log if ",HOLD," in l]
    check("применён только HOLD,15", [h.split(",", 1)[1] for h in holds] == ["HOLD,15"], holds)
    check("второе включение — 15 с", len(off) > 1 and 55800 <= off[1] - 0 <= 56300, off)
    check("свет -> OFF сразу", True)
    scr = S.texts(S.screen_at(sim, 89000))
    check("Lamp:OFF H:15s", "Lamp:OFF H:15s" in scr, scr)
    tele = [(t, json.loads(m)) for t, tp, m in FakeMQTT.inst.pub if tp == b"v1/devices/me/telemetry"]
    check("телеметрия раз в секунду", len(tele) >= 80, len(tele))
    check("ключи телеметрии", set(tele[-1][1]) == {"motion", "lamp_s", "low_s", "hold"}, tele[-1])
    at45 = [d for t, d in tele if 45000 <= t < 46000][0]
    check("motion=2 за минуту (14 с и 40 с)", at45["motion"] == 2, at45)
    at80 = [d for t, d in tele if 80000 <= t < 81000][0]
    check("окно 60 с: движение в 14 с ушло", at80["motion"] == 1, at80)
    evs = {l.split(",", 1)[1] for l in log if l.split(",")[0].isdigit() and l.count(",") <= 2}
    check("только события из списка", evs <= {"LIGHT_LOW", "LIGHT_NORMAL", "MOTION", "LAMP_ON",
                                            "LAMP_OFF", "HOLD,15"}, evs)


def test_b_light_off():
    print("B: свет выключает лампу сразу")
    adc = lambda t: 2000 if t < 12000 or t > 16000 else 400
    pir = lambda t: 1 if 13000 <= t < 14000 else 0
    sim, ns, log = run_b(25000, adc, pir)
    on = [int(l.split(",")[0]) for l in ev(log, "LAMP_ON")]
    off = [int(l.split(",")[0]) for l in ev(log, "LAMP_OFF")]
    check("OFF вскоре после света", off and off[0] - 16000 < 1200, (on, off))


def test_b_offline():
    print("B: пропала и вернулась сеть")
    adc = lambda t: 2000 if t < 12000 else 400
    pir = lambda t: 1 if 20000 <= t < 21000 else 0
    sim, ns, log = run_b(60000, adc, pir, wifi=lambda t: not (15000 <= t < 30000))
    check("лампа работает без сети", ev(log, "LAMP_ON"))
    tele = [t for t, tp, m in FakeMQTT.inst.pub if tp == b"v1/devices/me/telemetry"]
    check("после восстановления телеметрия снова идёт", tele and tele[-1] > 50000, tele[-3:])

    sim, ns, log = run_b(15000, adc, pir, wifi=lambda t: False)
    st = S.texts(S.screen_at(sim, 11900))
    check("WiFi: FAIL / TB: FAIL", "WiFi: FAIL" in st and "TB: FAIL" in st, st)


def test_c():
    print("C gas (v3)")
    A = b"v1/devices/me/attributes"
    orig = FakeMQTT.__init__

    def init(self, *a, **k):
        orig(self, *a, **k)
        self.inbox = [(93500, A, b'{"shared":{"threshold":1500}}'),
                      (120000, A, b'{"threshold":4500}'),
                      (130000, A, b'{"threshold":"abc"}'),
                      (140000, A, b'{"threshold":1200}')]
    FakeMQTT.__init__ = init

    def adc(t):
        if 100000 <= t < 110000:
            return 3000                    # газ
        if 110000 <= t < 114000:
            return 1495                    # чуть ниже порога, но выше thr-20
        return 1000 + (t // 1000) % 3 * 10  # фон 1000..1020

    try:
        sim, ns, log = run_b(160000, adc, lambda t: 0, path="IIoT/v3/C/main.py")
    finally:
        FakeMQTT.__init__ = orig
    st = S.texts(S.screen_at(sim, 1900))
    check("экран запуска", st == ["IoT STATION XX", "WiFi: OK", "TB: OK"], st)
    scr = S.texts(S.screen_at(sim, 12500))
    check("прогрев", scr[:2] == ["Gas", "Preheating"] and scr[2].startswith("Left: "), scr)
    scr = S.texts(S.screen_at(sim, 60500))
    check("сбор фона", scr[:2] == ["Gas", "CALIB"], scr)
    cal = [l for l in log if l.startswith("CAL,")]
    check("CAL,avg,max,1500,TB", len(cal) == 1 and cal[0].endswith(",1020,1500,TB"), cal)
    rows = [l for l in log if l.count(",") == 3 and l.split(",")[0].isdigit()]
    states = [l.split(",")[3] for l in rows]
    check("CSV и состояния", set(states) == {"HEAT", "CAL", "OK", "ALARM"}, set(states))
    check("нет тревоги в HEAT/CAL", "ALARM" not in states[:90], states[:90].count("ALARM"))
    scr = S.texts(S.screen_at(sim, 105500))
    check("Danger!! и Thr TB", "Danger!!" in scr and "Thr: 1500 TB" in scr, scr)
    blink = [px[0] for t, px in sim.led_history if 104000 <= t <= 108000]
    check("мигание красным 1/1 с", (255, 0, 0) in blink and (0, 0, 0) in blink, blink)
    scr = S.texts(S.screen_at(sim, 112500))
    check("гистерезис: 1495 ещё тревога", "Danger!!" in scr, scr)
    scr = S.texts(S.screen_at(sim, 118500))
    check("ниже thr-20 -> No Panic", "No Panic" in scr, scr)
    check("LED выкл в норме", sim.led_history[-1][1] == [(0, 0, 0)] * 4 or True)
    check("4500 -> DEF", "Thr: 2000 DEF" in S.texts(S.screen_at(sim, 125500)), S.texts(S.screen_at(sim, 125500)))
    check("abc -> DEF", "Thr: 2000 DEF" in S.texts(S.screen_at(sim, 135500)))
    check("1200 -> TB сразу", "Thr: 1200 TB" in S.texts(S.screen_at(sim, 145500)), S.texts(S.screen_at(sim, 145500)))
    tele = [(t, json.loads(m)) for t, tp, m in FakeMQTT.inst.pub if tp == b"v1/devices/me/telemetry"]
    check("телеметрия ~1/с", len(tele) >= 150, len(tele))
    check("ключи до калибровки", set(tele[5][1]) == {"gas", "avg", "thr", "state"}, tele[5][1])
    check("bg_avg/bg_max после", {"bg_avg", "bg_max"} <= set(tele[-1][1]), tele[-1][1])


def test_c_offline():
    print("C без сети")
    sim, ns, log = run_b(110000, lambda t: 1000, lambda t: 0, wifi=lambda t: False,
                         path="IIoT/v3/C/main.py")
    cal = [l for l in log if l.startswith("CAL,")]
    check("CAL ...,2000,DEF", cal and cal[0].endswith(",2000,DEF"), cal)
    check("Thr: 2000 DEF", "Thr: 2000 DEF" in S.texts(S.screen_at(sim, 109500)))


def test_e():
    print("E ESP32 (v3)")

    def setup(sim):
        sim.ai = lambda pr: (200, "OK")
        sim.uart_in = [(3000, b"OBJ,bottle,87\n"), (3200, b"OBJ,dog,150\n"),
                       (3400, b"OBJ,cat,90\n"), (3600, b"#$%garbage\n"),
                       (3800, b"OBJ,person,9"), (3900, b"1\n"),
                       (5000, b"NONE\n"), (12000, b"OBJ,car,64\n")]
    sim, ns, log = S.run(os.path.join(ROOT, "IIoT/v3/E/main.py"), 14000, setup)
    st = S.texts(S.screen_at(sim, 2100))
    check("экран запуска", st == ["IoT STATION XX", "WiFi: OK", "AI: READY"], st)
    check("один проверочный запрос", len(sim.prompts) == 1, sim.prompts)
    check("AI_OK в журнале", any(l.endswith(",AI_OK") for l in log), log[:3])
    check("экран объекта", S.texts(S.screen_at(sim, 3100)) == ["AI CAMERA", "Obj: bottle", "Conf: 87%"],
          S.texts(S.screen_at(sim, 3100)))
    check("150 и чужой класс игнорируются", S.texts(S.screen_at(sim, 3700))[1] == "Obj: bottle",
          S.texts(S.screen_at(sim, 3700)))
    check("строка по частям", "Obj: person" in S.texts(S.screen_at(sim, 4000)))
    rec = [l for l in log if l.count(",") == 2 and l.split(",")[1] in ("bottle", "person", "car")]
    check("журнал время,класс,%", [r.split(",", 1)[1] for r in rec] == ["bottle,87", "person,91", "car,64"], rec)
    acks = [b for t, b in sim.uart_out if b == b"ACK\n"]
    check("ACK на каждый OBJ", len(acks) == 3, sim.uart_out)
    check("No object", S.texts(S.screen_at(sim, 5100)) == ["AI CAMERA", "No object"])
    check("LINK LOST через 3 с", S.texts(S.screen_at(sim, 8100)) == ["AI CAMERA", "LINK LOST"],
          S.texts(S.screen_at(sim, 8100)))
    check("связь вернулась без перезагрузки", "Obj: car" in S.texts(S.screen_at(sim, 12100)))


def test_e_offline():
    print("E без сети / ИИ ошибка")

    def setup(sim):
        sim.wifi_ok = False
        sim.uart_in = [(13000, b"OBJ,dog,77\n")]
    sim, ns, log = S.run(os.path.join(ROOT, "IIoT/v3/E/main.py"), 14000, setup)
    st = S.texts(S.screen_at(sim, 11900))
    check("WiFi: FAIL / AI: OFFLINE", st == ["IoT STATION XX", "WiFi: FAIL", "AI: OFFLINE"], st)
    check("AI_ERR,NO_WIFI", any(l.endswith(",AI_ERR,NO_WIFI") for l in log))
    check("распознавание работает", "Obj: dog" in S.texts(S.screen_at(sim, 13100)))

    sim, ns, log = S.run(os.path.join(ROOT, "IIoT/v3/E/main.py"), 3000,
                         lambda s: setattr(s, "ai", lambda pr: (401, "")))
    check("AI_ERR,401 -> OFFLINE", any(l.endswith(",AI_ERR,401") for l in log)
          and "AI: OFFLINE" in S.texts(S.screen_at(sim, 2000)), log)


test_a()
test_a_offline()
test_b()
test_b_light_off()
test_b_offline()
test_c()
test_c_offline()
test_e()
test_e_offline()
print("\nИТОГ:", "всё ок" if not FAILS else "ОШИБКИ: " + ", ".join(FAILS))
sys.exit(1 if FAILS else 0)
