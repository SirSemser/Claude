"""Сценарии проверки всех решений в симуляторе. Запуск: python3 tests/run_all.py"""
import os
import sys
import shutil
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import sim as S  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILS = []


def check(name, cond, info=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  -> " + str(info)))
    if not cond:
        FAILS.append(name)


def p(*parts):
    return os.path.join(ROOT, *parts)


def csv(log, field):
    """Строки журнала, у которых второе поле == field."""
    return [l for l in log if l.split(",")[1:2] == [field]]


# ------------------------------------------------------------------ A1
def test_a1():
    print("A1 ultrasonic")

    def dist(t):
        if 20000 <= t < 20200:
            return 5.0                       # одиночный «скачок»
        if 26000 <= t < 27000:
            raise OSError("echo timeout")     # ошибка драйвера
        if t < 30000:
            return 85.0
        return max(10.0, 85.0 - (t - 30000) / 100)   # приближается

    def ai(prompt):
        return (200, "The object is APPROACHing. Answer: APPROACH")

    def setup(sim):
        sim.distance = dist
        sim.ai = ai

    sim, ns, log = S.run(p("IIoT/A1/main.py"), 45000, setup)
    start = S.texts(S.screen_at(sim, 2100))
    check("экран запуска", start == ["IoT STATION XX", "WiFi: OK", "AI: READY"], start)
    rows = [l for l in log if l.count(",") == 2 and l.split(",")[2] in ("NEAR", "MID", "FAR", "OUT")]
    check("CSV журнал есть", len(rows) > 100, len(rows))
    check("формат 85.0,FAR", any(l.endswith(",85.0,FAR") for l in rows))
    spike = [l for l in rows if 20000 <= int(l.split(",")[0]) <= 21000]
    check("медиана гасит одиночный скачок", all(l.endswith("85.0,FAR") for l in spike), spike)
    check("OUT при ошибке драйвера", any(l.endswith(",-1,OUT") for l in rows))
    scr = S.texts(S.screen_at(sim, 26500))
    check("экран OUT OF RANGE", scr == ["HCSR04", "OUT OF RANGE"], scr)
    check("AI_REQ/AI_ANS в журнале", csv(log, "AI_REQ") and csv(log, "AI_ANS"))
    check("в запросе 10 значений", all(pr.count(",") >= 9 for pr in sim.prompts[1:]), sim.prompts[-1:])
    last = S.screen_at(sim, 44900)
    check("NEAR + APPROACH -> инверсия", last[3] == 1 and "Zone: NEAR" in S.texts(last), last)
    bar = [s for s in last[2] if s[0] == "fill_rect"]
    check("шкала почти полная при 10 см", bar and bar[0][3] >= 105, bar)
    gaps = [int(l.split(",")[0]) for l in csv(log, "AI_REQ")]
    check("запросы не чаще 1 раза в 5 с", all(b - a >= 5000 for a, b in zip(gaps, gaps[1:])), gaps)


def test_a1_offline():
    print("A1 offline")

    def setup(sim):
        sim.wifi_ok = False
        sim.distance = lambda t: 40.0

    sim, ns, log = S.run(p("IIoT/A1/main.py"), 30000, setup)
    start = S.texts(S.screen_at(sim, 11000))       # 10 с ждём Wi-Fi при старте
    check("WiFi: FAIL / AI: OFFLINE", "WiFi: FAIL" in start and "AI: OFFLINE" in start, start)
    check("работает без сети (MID)", any(l.endswith(",40.0,MID") for l in log))
    check("AI: --- без сети", "AI: ---" in S.texts(S.screen_at(sim, 29000)))
    check("AI_ERR,NO_WIFI", any("AI_ERR,NO_WIFI" in l for l in log))


# ------------------------------------------------------------------ A2
def test_a2():
    print("A2 induction lamp")

    def adc(t):
        return 1000 if t < 15000 or t > 60000 else 2500   # темнее -> больше

    def pir(t):
        return 1 if 20000 <= t < 22000 else 0

    def setup(sim):
        sim.adc_value = adc
        sim.ai = lambda pr: (200, "I recommend 15 seconds.")

    orig = S.FakePin.__init__

    def pin_init(self, num, *a, **k):
        orig(self, num, *a, **k)
        if num == 27:
            self.reader = pir
    S.FakePin.__init__ = pin_init
    try:
        sim, ns, log = S.run(p("IIoT/A2/main.py"), 100000, setup)
    finally:
        S.FakePin.__init__ = orig
    cal = [l for l in log if l.startswith("CAL,")]
    check("CAL,1000,1500", cal == ["CAL,1000,1500"], cal)
    check("LIGHT_LOW / MOTION / LAMP_ON", csv(log, "LIGHT_LOW") and csv(log, "MOTION") and csv(log, "LAMP_ON"))
    on = int(csv(log, "LAMP_ON")[0].split(",")[0])
    off = int(csv(log, "LAMP_OFF")[0].split(",")[0])
    check("удержание 10 с после последнего движения", 31500 <= off - 0 <= 32500, (on, off))
    scr = S.texts(S.screen_at(sim, 25000))
    check("экран Lamp:ON Ns", any(s.startswith("Lamp:ON ") for s in scr), scr)
    check("HOLD,15 от ИИ", any(l.endswith(",HOLD,15") for l in log))
    scr = S.texts(S.screen_at(sim, 99000))
    check("Lamp:OFF H:15s", "Lamp:OFF H:15s" in scr, scr)
    check("в консоли только изменения", len([l for l in log if l.endswith("LIGHT_LOW")]) == 1)


# ------------------------------------------------------------------ B1
def test_b1():
    print("B1 gas")

    def adc(t):
        if t < 100000:
            return 400 + (t // 1000) % 7          # фон 400..406
        if t < 110000:
            return 900                            # газ
        return 500

    def setup(sim):
        sim.adc_value = adc
        sim.ai = lambda pr: (200, "Threshold: 600")

    sim, ns, log = S.run(p("IIoT/B1/main.py"), 125000, setup)
    states = [l.split(",")[3] for l in log if l.count(",") == 3 and l.split(",")[3] in ("HEAT", "CAL", "OK", "ALARM")]
    check("порядок HEAT->CAL->OK->ALARM->OK",
          states[0] == "HEAT" and "CAL" in states and "ALARM" in states and states[-1] == "OK", states[-3:])
    check("30 измерений HEAT", states.count("HEAT") == 30, states.count("HEAT"))
    check("60 измерений CAL", states.count("CAL") == 60, states.count("CAL"))
    cal = [l for l in log if l.startswith("CAL,")]
    check("CAL,...,600,AI", cal and cal[0].endswith(",406,600,AI"), cal)
    check("экран Danger!!", "Danger!!" in S.texts(S.screen_at(sim, 108000)))
    red = [h for h in sim.led_history if 100000 <= h[0] <= 110000]
    check("мигание красным 1/1 с", len(red) >= 8 and red[0][1][0] == (255, 0, 0), red[:3])
    check("в норме LED выключены", sim.leds == [(0, 0, 0)] * 4, sim.leds)


def test_b1_bad_ai():
    print("B1 bad AI answer")

    def setup(sim):
        sim.adc_value = lambda t: 450
        sim.ai = lambda pr: (200, "300")             # ниже фона -> недопустимо

    sim, ns, log = S.run(p("IIoT/B1/main.py"), 95000, setup)
    cal = [l for l in log if l.startswith("CAL,")]
    check("порог DEF при недопустимом ответе", cal and cal[0].endswith(",500,DEF"), cal)
    check("AI_BAD в журнале", csv(log, "AI_BAD"))


# ------------------------------------------------------------------ B2
def test_b2():
    print("B2 RFID")
    tmp = tempfile.mkdtemp()
    shutil.copy(p("IIoT/B2/users.json"), tmp)
    good = S.FakeCard([0x9A, 0x3F, 0x12, 0xC4])
    alien = S.FakeCard([0x5B, 0x71, 0xE0, 0xA2])
    # «регистрируем» карту так, как это сделает register()
    sim, ns, log = S.run(p("IIoT/B2/main.py"), 3000, lambda s: None, cwd=tmp)
    S.SIM.limit = 10 ** 9
    S.SIM.rfid = lambda t: good
    old = os.getcwd()
    os.chdir(tmp)
    try:
        ok = ns["register"]()
    finally:
        os.chdir(old)
    check("register() -> WRITE OK", ok and "WRITE OK" in S.texts(S.SIM.screens[-1]), S.texts(S.SIM.screens[-1]))
    check("блок 8 = имя + пробелы", good.blocks[8] == b"ASKAR" + b" " * 11, good.blocks[8])

    def card(t):
        if 5000 <= t < 5600 or 12000 <= t < 12600:
            return good
        if 20000 <= t < 20600:
            return alien
        return None

    def setup(sim):
        sim.rfid = card
        sim.ai = lambda pr: (200, "HIGH")

    sim, ns, log = S.run(p("IIoT/B2/main.py"), 30000, setup, cwd=tmp)
    rows = [l for l in log if l.count(",") == 4]
    check("журнал OK, visits 1 и 2", any(l.endswith(",9A3F12C4,ASKAR,OK,1") for l in rows)
          and any(l.endswith(",9A3F12C4,ASKAR,OK,2") for l in rows), rows)
    check("чужая карта UNKNOWN", any(l.endswith(",5B71E0A2,-,UNKNOWN,-") for l in rows), rows)
    check("tag type: 0x0400", "tag type: 0x0400" in log)
    scr = S.texts(S.screen_at(sim, 5900))
    check("экран ACCESS OK", scr == ["ACCESS OK", "UID:9A3F12C4", "Name:ASKAR", "Visits: 1"], scr)
    scr = S.texts(S.screen_at(sim, 20900))
    check("экран DENIED", scr == ["DENIED", "UID:5B71E0A2", "Unknown card"], scr)
    idle = S.screen_at(sim, 29000)
    check("Risk: HIGH + инверсия + ALERT", "Risk: HIGH" in S.texts(idle) and idle[3] == 1 and csv(log, "ALERT"))
    check("счётчик записан в блок 9", int.from_bytes(good.blocks[9][:4], "big") == 2, good.blocks[9])
    good.blocks[8] = b"HACKER          "

    def setup2(sim):
        sim.rfid = lambda t: good if 4000 <= t < 4500 else None

    sim, ns, log = S.run(p("IIoT/B2/main.py"), 9000, setup2, cwd=tmp)
    check("подмена имени -> MISMATCH", any(l.endswith(",9A3F12C4,-,MISMATCH,-") for l in log), log[-5:])


# ------------------------------------------------------------------ C1
def test_c1():
    print("C1 AI camera (ESP32)")
    feed = []
    t = 3000
    for i in range(6):                       # bottle x6
        feed.append((t, b"OBJ,bottle,87\n")); t += 200
    feed.append((t, b"garbage line\n")); t += 200
    feed.append((t, b"OBJ,unicorn,99\n")); t += 200
    for i in range(3):                       # person x3
        feed.append((t, b"OBJ,person,9")); feed.append((t + 50, b"1\n")); t += 200
    feed.append((t, b"NONE\n")); t += 1000
    feed.append((t, b"NONE\n"))              # потом тишина -> LINK LOST
    t_end_feed = t
    for i in range(4):                       # снова bottle (тип уже в кэше)
        feed.append((t + 6000 + i * 200, b"OBJ,bottle,80\n"))

    def ai(prompt):
        return (200, "HOME" if "bottle" in prompt else "HUMAN")

    def setup(sim):
        sim.uart_in = list(feed)
        sim.ai = ai

    sim, ns, log = S.run(p("IIoT/C1/main.py"), 40000, setup)
    acks = [o for o in sim.uart_out if o[1] == b"ACK\n"]
    check("ACK на каждое корректное OBJ", len(acks) == 6 + 3 + 4, len(acks))
    check("тип bottle -> HOME", any(l.endswith(",bottle,87,HOME") for l in log), log)
    check("тип person -> HUMAN", any(l.endswith(",person,91,HUMAN") for l in log), log)
    check("кэш: bottle не запрашивается повторно",
          sum("bottle" in pr for pr in sim.prompts) == 1, sim.prompts)
    check("LINK LOST после 3 с тишины", "LINK LOST" in S.texts(S.screen_at(sim, t_end_feed + 3500)))
    scr = S.texts(S.screen_at(sim, t_end_feed + 6900))
    check("экран объекта", scr == ["AI CAMERA", "Obj: bottle", "Conf: 80%", "Type: HOME"], scr)
    stat = [l for l in log if l.startswith("STAT")]
    check("STAT,bottle:2,person:1", stat and stat[-1] == "STAT,bottle:2,person:1", stat)


# ------------------------------------------------------------------ AI-IoT MA
def test_ma():
    print("AI-IoT MA parktronic")

    def dist(t):
        if t < 5000:
            return 80.0
        if t < 10000:
            return 30.0
        if t < 15000:
            return 10.0
        return 999.0                          # вне диапазона

    def setup(sim):
        sim.distance = dist

    sim, ns, log = S.run(p("AI-IoT/MA/main.py"), 20000, setup)
    check("LED-тест R,G,B при запуске", [h[1][0] for h in sim.led_history[:4]] ==
          [(60, 0, 0), (0, 60, 0), (0, 0, 60), (0, 0, 0)], sim.led_history[:4])
    check("зоны SAFE/WARN/STOP", all(any(l.endswith("," + z) for l in log) for z in ("SAFE", "WARN", "STOP")))
    beep = sim.pins[26].history
    warn = [h for h in beep if 6000 <= h[0] < 10000]
    ons = [h[0] for h in warn if h[1] == 1]
    offs = [h[0] for h in warn if h[1] == 0]
    check("WARN: 200 мс звук / 600 мс пауза",
          ons and offs and all(abs((b - a) - 800) <= 20 for a, b in zip(ons, ons[1:]))
          and abs(offs[0] - ons[0] - 200) <= 20, warn[:4])
    check("OUT: зуммер и LED выключены", sim.pins[26].value() == 0 and sim.leds == [(0, 0, 0)] * 4)
    scr = S.texts(S.screen_at(sim, 19000))
    check("экран OUT OF RANGE", scr == ["HCSR04", "OUT OF RANGE"], scr)


# ------------------------------------------------------------------ AI-IoT MB
def test_mb():
    print("AI-IoT MB RFID")
    card = S.FakeCard([154, 63, 18, 196])

    def setup(sim):
        sim.rfid = lambda t: card if 1000 <= t < 1300 else None

    sim, ns, log = S.run(p("AI-IoT/MB/main.py"), 2000, setup)
    check("NO_CARD", "NO_CARD" in log)
    check("tag type: 0x0400", "tag type: 0x0400" in log)
    check("card_id= [154, 63, 18, 196, 115]", "card_id= [154, 63, 18, 196, 115]" in log, log[:8])
    check("Address 8 data", "Address 8 data: [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 85]" in log)
    check("READ OK на OLED", "READ OK" in S.texts(S.screen_at(sim, 1250)))


for test in (test_a1, test_a1_offline, test_a2, test_b1, test_b1_bad_ai,
             test_b2, test_c1, test_ma, test_mb):
    try:
        test()
    except Exception as e:                    # сам тест упал
        import traceback
        traceback.print_exc()
        FAILS.append(test.__name__)

print("\nИТОГО: %s" % ("всё прошло" if not FAILS else "ошибки: " + ", ".join(FAILS)))
sys.exit(1 if FAILS else 0)
