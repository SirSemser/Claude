(function () {
  "use strict";

  /* ---------- безопасное хранилище ---------- */
  function load(key, def) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* приватный режим */ }
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- подсветка Python ---------- */
  var RE = /(#[^\n]*)|(b?"(?:[^"\\\n]|\\.)*"|b?'(?:[^'\\\n]|\\.)*')|\b(def|class|return|if|elif|else|for|while|in|not|and|or|try|except|finally|import|from|as|global|True|False|None|with|break|continue|pass|raise|lambda|is)\b|\b(0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)\b/g;
  function highlight(src) {
    var out = "", last = 0, m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      out += esc(src.slice(last, m.index));
      var cls = m[1] ? "hl-c" : m[2] ? "hl-s" : m[3] ? "hl-k" : "hl-n";
      out += '<span class="' + cls + '">' + esc(m[0]) + "</span>";
      last = RE.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function decorate(root) {
    root.querySelectorAll("pre.py, pre.snip").forEach(function (pre) {
      if (pre.dataset.done) return;
      pre.dataset.done = "1";
      pre.innerHTML = highlight(pre.textContent);
    });
  }

  /* ---------- копирование кода ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest(".copy");
    if (!b) return;
    var pre = b.parentNode.querySelector("pre");
    var text = pre.textContent;
    function done(msg) { b.textContent = msg; setTimeout(function () { b.textContent = "Копировать"; }, 1600); }
    function fallback() {
      var r = document.createRange(); r.selectNodeContents(pre);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      done("Выделено — Ctrl+C");
    }
    try {
      navigator.clipboard.writeText(text).then(function () { done("Скопировано"); }, fallback);
    } catch (err) { fallback(); }
  });

  /* ---------- маршрутизация по #hash ---------- */
  var MODS = ["a1", "a2", "b1", "b2", "c1", "ma", "mb"];
  var VIEWS = ["overview", "hardware", "modules", "micropython", "defense", "plan", "cards"];
  function route() {
    var h = (location.hash || "#overview").slice(1);
    var view = MODS.indexOf(h) >= 0 ? "modules" : (VIEWS.indexOf(h) >= 0 ? h : "overview");
    if (view === "modules" && MODS.indexOf(h) < 0) h = "a1";
    VIEWS.forEach(function (v) {
      document.getElementById("v-" + v).hidden = v !== view;
    });
    document.querySelectorAll("nav.tabs a").forEach(function (a) {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (view === "modules") {
      MODS.forEach(function (m) { document.getElementById("m-" + m).hidden = m !== h; });
      document.querySelectorAll(".modnav a").forEach(function (a) {
        a.setAttribute("aria-current", a.dataset.mod === h ? "true" : "false");
      });
      var tab = document.querySelector('nav.tabs a[data-view="modules"]');
      if (tab) tab.setAttribute("href", "#" + h);
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  /* ---------- упражнения ---------- */
  var DRILLS = [
    ["1. Формат для экрана", "Получи строки <code>Dist: 12.4 cm</code> из 12.44, <code>Conf: 87%</code> из 87 и <code>UID:0A1B2C3D</code> из списка [10, 27, 44, 61].",
      '"Dist: %.1f cm" % 12.44\n"Conf: %d%%" % 87\nuid = [10, 27, 44, 61]\n"UID:%02X%02X%02X%02X" % tuple(uid)'],
    ["2. Привет, OLED", "Подключи OLED (SDA 23, SCL 19), найди его адрес и выведи 4 строки на y = 0, 16, 32, 48.",
      'from machine import Pin, SoftI2C\nimport ssd1306\ni2c = SoftI2C(scl=Pin(19), sda=Pin(23))\nprint(i2c.scan())          # [60] = 0x3C\noled = ssd1306.SSD1306_I2C(128, 64, i2c)\noled.fill(0)\nfor i, y in enumerate((0, 16, 32, 48)):\n    oled.text("Line %d" % i, 0, y)\noled.show()'],
    ["3. Мигание без sleep", "Переключай переменную on/off каждые 500 мс, не блокируя цикл, и печатай её.",
      'import time\non = False\nnext_t = time.ticks_ms()\nwhile True:\n    now = time.ticks_ms()\n    if time.ticks_diff(now, next_t) >= 0:\n        next_t = time.ticks_add(now, 500)\n        on = not on\n        print(on)\n    time.sleep_ms(10)'],
    ["4. Таймер и флаг", "Таймер 200 мс ставит флаг, цикл считает срабатывания и раз в секунду печатает число (должно быть 5).",
      'from machine import Timer\nimport time\ntick = False\ndef on_timer(t):\n    global tick\n    tick = True\nTimer(0).init(period=200, mode=Timer.PERIODIC, callback=on_timer)\nn, t0 = 0, time.ticks_ms()\nwhile True:\n    if tick:\n        tick = False\n        n += 1\n    if time.ticks_diff(time.ticks_ms(), t0) >= 1000:\n        print(n); n = 0; t0 = time.ticks_ms()'],
    ["5. Медиана и буфер", "Буфер на 5 значений + медиана. Проверь на [50, 50, 5, 50, 50] — должно быть 50.",
      'buf = []\ndef add(v):\n    buf.append(v)\n    if len(buf) > 5:\n        buf.pop(0)\ndef median(v):\n    s = sorted(v); n = len(s)\n    return s[n//2] if n % 2 else (s[n//2-1] + s[n//2]) / 2\nfor v in [50, 50, 5, 50, 50]:\n    add(v)\nprint(median(buf))   # 50'],
    ["6. Зоны с границами", "Функция zone(d): NEAR < 20, MID 20…50, FAR > 50. Проверь 19.9, 20, 50, 50.1.",
      'def zone(d):\n    if d < 20:\n        return "NEAR"\n    if d <= 50:\n        return "MID"\n    return "FAR"\nprint([zone(x) for x in (19.9, 20, 50, 50.1)])'],
    ["7. Шкала", "Нарисуй шкалу x=0, y=54, 122×10: 100 см и дальше — пусто, 0 — полная.",
      'def bar(d):\n    fill = int(122 * (100 - min(d, 100)) / 100)\n    oled.rect(0, 54, 122, 10, 1)\n    oled.fill_rect(0, 54, fill, 10, 1)'],
    ["8. АЦП и среднее", "Читай GPIO34 каждые 200 мс, печатай среднее последних 4. Закрой датчик ладонью — значение растёт или падает?",
      'from machine import ADC, Pin\nimport time\nadc = ADC(Pin(34))\nadc.atten(ADC.ATTN_11DB)\nadc.width(ADC.WIDTH_12BIT)\nw = []\nwhile True:\n    w.append(adc.read())\n    if len(w) > 4:\n        w.pop(0)\n    print(sum(w) // len(w))\n    time.sleep_ms(200)'],
    ["9. Фронт PIR", "Считай срабатывания PIR: только переход 0 → 1, печатай MOTION один раз на срабатывание.",
      'pir = Pin(27, Pin.IN)\nprev, count = 0, 0\nwhile True:\n    v = pir.value()\n    if v == 1 and prev == 0:\n        count += 1\n        print("MOTION", count)\n    prev = v\n    time.sleep_ms(50)'],
    ["10. WS2812 мигает", "4 светодиода мигают красным 1 с / 1 с без sleep, пишем в ленту только при смене.",
      'from neopixel import NeoPixel\nnp = NeoPixel(Pin(25), 4)\nstate, t0 = None, time.ticks_ms()\nwhile True:\n    on = (time.ticks_diff(time.ticks_ms(), t0) // 1000) % 2 == 0\n    if on != state:\n        state = on\n        for i in range(4):\n            np[i] = (60, 0, 0) if on else (0, 0, 0)\n        np.write()\n    time.sleep_ms(20)'],
    ["11. Машина состояний", "HEAT 30 с → CAL 60 с → OK; на экране «Left: N s».",
      'state, secs = "HEAT", 0\nwhile True:\n    time.sleep(1)\n    secs += 1\n    if state == "HEAT" and secs >= 30:\n        state, secs = "CAL", 0\n    elif state == "CAL" and secs >= 60:\n        state, secs = "OK", 0\n    left = (30 if state == "HEAT" else 60) - secs\n    print(state, "Left: %d s" % left)'],
    ["12. Wi-Fi с тайм-аутом", "Функция подключения, которая ждёт не дольше 10 с и возвращает True/False.",
      'import network, time\nwlan = network.WLAN(network.STA_IF)\ndef wifi(ssid, pwd, ms=10000):\n    wlan.active(True)\n    if not wlan.isconnected():\n        wlan.connect(ssid, pwd)\n        t0 = time.ticks_ms()\n        while not wlan.isconnected() and time.ticks_diff(time.ticks_ms(), t0) < ms:\n            time.sleep_ms(200)\n    return wlan.isconnected()'],
    ["13. Запрос к ИИ", "POST в Chat Completions, вернуть текст ответа, на коде ≠ 200 — ошибка. Ответ закрыть всегда.",
      'import requests, json, gc\nimport secrets\ndef ask(prompt):\n    gc.collect()\n    body = {"model": secrets.MODEL,\n            "messages": [{"role": "user", "content": prompt}],\n            "max_tokens": 50, "temperature": 0}\n    h = {"Content-Type": "application/json",\n         "Authorization": "Bearer " + secrets.API_KEY}\n    r = requests.post(secrets.API_URL, data=json.dumps(body).encode(), headers=h, timeout=10)\n    try:\n        if r.status_code != 200:\n            raise OSError("HTTP%d" % r.status_code)\n        return r.json()["choices"][0]["message"]["content"]\n    finally:\n        r.close()'],
    ["14. Число из текста", "Из «I recommend 15 seconds.» достать 15 и проверить диапазон 5…30. Если чисел не одно — отбросить.",
      'def ints(text):\n    nums, cur = [], ""\n    for ch in text + " ":\n        if "0" <= ch <= "9":\n            cur += ch\n        elif cur:\n            nums.append(int(cur)); cur = ""\n    return nums\nn = ints("I recommend 15 seconds.")\nok = len(n) == 1 and 5 <= n[0] <= 30'],
    ["15. Разбор строки UART", "Разобрать <code>OBJ,bottle,87</code>: класс из списка, процент 0…100; всё остальное — None.",
      'def parse(line):\n    p = line.strip().split(",")\n    if len(p) != 3 or p[0] != "OBJ" or p[1] not in CLASSES:\n        return None\n    try:\n        c = int(p[2])\n    except ValueError:\n        return None\n    return (p[1], c) if 0 <= c <= 100 else None'],
    ["16. UID и BCC", "Из card_id = [154, 63, 18, 196, 115] получи «9A3F12C4» и проверь, что 5-й байт — XOR первых четырёх.",
      'cid = [154, 63, 18, 196, 115]\nuid = "%02X%02X%02X%02X" % tuple(cid[:4])\nbcc = cid[0] ^ cid[1] ^ cid[2] ^ cid[3]\nprint(uid, bcc == cid[4])   # 9A3F12C4 True'],
    ["17. 16 байт для блока", "Имя «ASKAR» → 16 байт с пробелами и обратно; счётчик 7 → 16 байт и обратно.",
      'blk = ("ASKAR" + " " * 16)[:16].encode()\nname = blk.decode().strip()\ncnt = (7).to_bytes(4, "big") + bytes(12)\nn = int.from_bytes(cnt[:4], "big")'],
    ["18. Git на модуле", "Последовательность команд: первый коммит, промежуточный, финальный.",
      '# один раз\ngit clone <url> && cd WSKZ2026_IIoT_XX\necho secrets.py >> .gitignore\n# каждые <= 30 минут\ngit add A1/main.py A1/secrets_example.py .gitignore\ngit commit -m "A1: wifi connect"\ngit push\n# в конце\ngit commit -am "A1 final" && git push']
  ];
  var dr = document.getElementById("drills");
  dr.innerHTML = DRILLS.map(function (d, i) {
    return '<div class="panel"><h3>' + d[0] + "</h3><p>" + d[1] + '</p><details><summary>Ответ</summary><pre class="snip">' +
      esc(d[2]) + "</pre></details></div>";
  }).join("");

  /* ---------- вопросы на защите ---------- */
  var VIVA = [
    ["Зачем медиана, а не среднее?", "Медиана выбрасывает одиночный выброс: из [50, 50, 5, 50, 50] получится 50. Среднее дало бы 41 — скачок, который задание запрещает."],
    ["Почему в обработчике таймера только флаг?", "Обработчик должен быть коротким. I2C, print и тем более HTTP в нём тормозят или ломают программу; работа выполняется в основном цикле по флагу."],
    ["Что будет без oled.fill(0)?", "Новый текст ляжет поверх старого: «12.4» поверх «120.5» даст мусор. Задание требует очистки перед каждым обновлением."],
    ["Зачем ticks_diff вместо вычитания?", "Счётчик ticks_ms переполняется и начинается заново; ticks_diff правильно считает разницу через переполнение."],
    ["Что делает программа без сети?", "Показывает WiFi: FAIL / AI: OFFLINE, датчики и экран работают, ИИ-строка в резервном значении, раз в 10 с пробует переподключиться."],
    ["Почему датчик на GPIO34?", "Это ADC1. ADC2 не работает, когда включён Wi-Fi. Плюс GPIO34 только вход — для датчика это нормально."],
    ["Что такое гистерезис, где он у тебя?", "Разные пороги на вход и выход из состояния. В B1: тревога при среднем > порога, выход — при < порога − 20. Без него на границе мигает."],
    ["Модель ответила «Not APPROACH, it is AWAY». Что сделает программа?", "Найдёт два допустимых слова, ответ неоднозначный → AI_BAD, значение не применяется."],
    ["Зачем gc.collect() и r.close()?", "HTTPS на ESP32 берёт десятки килобайт памяти. Без сборки мусора и закрытия сокета через несколько запросов будет MemoryError."],
    ["Почему secrets.py не в репозитории?", "Там пароль Wi-Fi и API-ключ. В репозиторий кладут secrets_example.py с теми же именами и \"****\", а secrets.py — в .gitignore."],
    ["Что лежит в блоке 11 карты?", "Трейлер сектора 2: ключ A, биты доступа, ключ B. Запись туда может навсегда заблокировать сектор."],
    ["Что за пятое число в card_id?", "BCC — контрольный байт, XOR четырёх байт UID. UID — только первые 4."],
    ["Зачем stop_crypto1()?", "Выключает шифрование Crypto1 в считывателе после авторизации, иначе следующая карта/операция не пойдёт."],
    ["Почему TX к RX?", "Передатчик одного устройства должен идти на приёмник другого; плюс общий GND и одна скорость 115200."],
    ["Зачем rxbuf у UART?", "Пока ESP32 ждёт ИИ до 10 с, камера шлёт строки. Буфер их копит, после ответа они обрабатываются, ничего не теряется."],
    ["Как ты проверил направление сигнала датчика света?", "Закрыл датчик ладонью и смотрел значение в консоли; результат записан в константу DARK_IS_HIGH."]
  ];
  document.getElementById("viva").innerHTML = VIVA.map(function (v) {
    return '<div class="amb"><p class="q">' + esc(v[0]) + '</p><p class="a">' + esc(v[1]) + "</p></div>";
  }).join("");

  /* ---------- план ---------- */
  var PLAN = [
    ["День 1", "Основа и инструменты", [
      ["e", "Прочитать «Обзор» и «Железо», уметь объяснить каждую строку таблицы пинов"],
      ["e", "Найти и сохранить Practical Training Guide ZL-02B и папку drivers (ssd1306.py, HCSR04.py, rc522.py)"],
      ["s", "Thonny: прошивка MicroPython на ESP32, выбор порта, REPL, загрузка файлов"],
      ["s", "Упражнения 1–3, OLED показывает 4 строки, i2c.scan() → [60]"],
      ["e", "Карточки: категории «Железо» и «MicroPython»"]]],
    ["День 2", "Дальномер: MA и A1", [
      ["e", "Разобрать модули A1 и MA: чек-листы, макеты, ловушки"],
      ["s", "Упражнения 4–7 (таймер, медиана, зоны, шкала)"],
      ["s", "MA с нуля без подсказок: A1 → A2 → A3, по часу на часть, с таймером"],
      ["s", "IIoT A1 без ИИ: экран, медиана, зоны, шкала, журнал"],
      ["e", "Проверить работу студента по чек-листу A1, задать 5 вопросов из «Защиты»"]]],
    ["День 3", "Аналоговые датчики: A2 и B1", [
      ["e", "АЦП, PIR, MQ-2, WS2812; неоднозначности A2 и B1"],
      ["s", "Упражнения 8–11"],
      ["s", "Определить направление сигнала датчика света на стенде"],
      ["s", "A2 и B1 без ИИ: калибровка, гистерезис, отсчёт HOLD, этапы, мигание"]]],
    ["День 4", "ИИ-сервис и GitHub", [
      ["e", "Раздел ИИ-сервиса: формат запроса, коды 401/429/5xx, правила частоты и журнал AI_*"],
      ["s", "Упражнения 12–14: Wi-Fi, запрос, разбор ответа"],
      ["s", "Добавить ИИ в A1, A2, B1; проверить выключением точки доступа"],
      ["s", "GitHub: клон, .gitignore, secrets_example.py, коммит каждые 30 минут, «A1 final»"],
      ["e", "Карточки: «ИИ и сеть», «Git»"]]],
    ["День 5", "RFID: MB и B2", [
      ["e", "Память MIFARE, порядок команд, почему нельзя писать в трейлеры"],
      ["s", "Упражнения 16–17"],
      ["s", "MB по частям: B1 → B2 → B3, сверка вывода консоли с примером"],
      ["s", "B2: users.json, register() из консоли, счётчик проходов, риск от ИИ"]]],
    ["День 6", "UART и ИИ-камера C1", [
      ["e", "Протокол OBJ/NONE/ACK, K210 и MaixPy, архитектура C1"],
      ["s", "Упражнение 15; сторона ESP32 с имитацией камеры (второй ESP32 или USB-UART)"],
      ["s", "Сторона A01-AI: камера, FPS, модель, рамки, отправка, LINK OK/NO LINK"],
      ["s", "Связать обе стороны, проверить LINK LOST, кэш типов и STAT"]]],
    ["День 7", "Генеральная репетиция", [
      ["e", "Изменить один модуль на 30 %: пороги, тексты, пины или формат журнала"],
      ["s", "3 часа на изменённый модуль с коммитами каждые 30 минут"],
      ["e", "Проверка по чек-листу и устные вопросы, как на чемпионате"],
      ["e", "Пройти «Неоднозначности» и решить, что поднять на С-1"],
      ["s", "Список своих ошибок за неделю, перечитать перед сном"]]]
  ];
  var done = load("iot-plan", {});
  var pd = document.getElementById("plan-days");
  pd.innerHTML = PLAN.map(function (d, i) {
    return '<div class="panel day"><h3>' + d[0] + " <small>" + d[1] + '</small></h3><ul class="todo">' +
      d[2].map(function (t, j) {
        var id = "p" + i + "-" + j;
        return '<li><label for="' + id + '"><input type="checkbox" id="' + id + '"' + (done[id] ? " checked" : "") +
          '><span><span class="who ' + t[0] + '">' + (t[0] === "e" ? "Э" : "С") + "</span>" + t[1] + "</span></label></li>";
      }).join("") + "</ul></div>";
  }).join("");
  function planStat() {
    var all = pd.querySelectorAll("input"), n = 0;
    all.forEach(function (c) { if (c.checked) n++; });
    document.getElementById("plan-bar").style.width = (100 * n / all.length) + "%";
    document.getElementById("plan-stat").textContent = "Сделано " + n + " из " + all.length;
  }
  pd.addEventListener("change", function (e) {
    if (e.target.type !== "checkbox") return;
    done[e.target.id] = e.target.checked;
    save("iot-plan", done);
    planStat();
  });
  planStat();

  /* ---------- карточки ---------- */
  var CARDS = [
    ["Железо", "Почему аналоговые датчики на GPIO34, а не на любом пине?", "GPIO34 — канал ADC1. ADC2 не работает при включённом Wi-Fi, а Wi-Fi нужен в каждом модуле IIoT."],
    ["Железо", "Какие GPIO у ESP32 только входы?", "34, 35, 36, 39 (34–39). Подтяжек у них нет."],
    ["Железо", "Почему с GPIO12 надо быть осторожнее?", "Это strapping-пин: если при загрузке на нём HIGH, ESP32 выбирает питание флеш 1,8 В и может не загрузиться."],
    ["Железо", "Формула расстояния HC-SR04?", "Расстояние (см) = время эха (мкс) × 0,0343 / 2 ≈ время / 58."],
    ["Железо", "Диапазон HC-SR04 по заданию?", "2–400 см. Меньше 2, больше 400 или ошибка драйвера → OUT OF RANGE."],
    ["Железо", "Сколько символов и строк на SSD1306 128×64?", "Шрифт 8×8: 16 символов в строке, 8 строк по высоте."],
    ["Железо", "Адрес OLED и как его проверить?", "0x3C. i2c.scan() вернёт [60]."],
    ["Железо", "Что делает oled.show()?", "Отправляет буфер кадра на экран. До show() ничего не видно."],
    ["Железо", "Как ведёт себя MQ-2 при появлении газа?", "Сопротивление падает, напряжение и значение АЦП растут. Нужен прогрев нагревателя."],
    ["Железо", "Почему WS2812 управляются одним проводом?", "В каждом диоде контроллер: он берёт свои 24 бита из потока и передаёт остальное дальше по цепочке."],
    ["Железо", "Активный и пассивный зуммер — разница?", "Активный пищит от постоянного уровня, пассивному нужен ШИМ с частотой. Модуль может включаться нулём."],
    ["Железо", "Сколько памяти у MIFARE S50 и как она устроена?", "1 КБ: 16 секторов × 4 блока × 16 байт. Последний блок сектора — трейлер с ключами."],
    ["Железо", "Какие блоки нельзя писать?", "Блок 0 (заводской) и трейлеры 3, 7, 11, …, 63."],
    ["Железо", "Ключ по умолчанию у новой карты?", "Шесть байт 0xFF."],
    ["Железо", "Что за чип, скорее всего, в A01-AI?", "Kendryte K210 (RISC-V + нейроускоритель KPU), прошивка MaixPy. Проверить на С-1."],
    ["Протоколы", "I2C — сколько проводов и как различаются устройства?", "SDA и SCL (+ питание). Устройства различаются адресом."],
    ["Протоколы", "SPI — какие линии у MFRC522?", "SCK, MOSI, MISO, NSS (CS) + отдельный RST."],
    ["Протоколы", "Что значит UART 115200 8N1?", "115200 бит/с, 8 бит данных, без чётности, 1 стоп-бит."],
    ["Протоколы", "Как соединить два устройства по UART?", "TX → RX и RX ← TX крест-накрест, общий GND, одинаковая скорость."],
    ["Протоколы", "Порядок работы с картой?", "SeekCard → Anticoll → select_tag → auth → read/write → stop_crypto1."],
    ["Протоколы", "Чем 0x52 отличается от 0x26 при поиске карты?", "0x52 (WUPA) будит все карты, включая «уснувшие»; 0x26 (REQA) — только незаснувшие."],
    ["Протоколы", "Что такое 0x60 в auth()?", "Авторизация ключом A (AUTHENT1A). 0x61 — ключом B."],
    ["Протоколы", "Протокол C1 одной строкой?", "Камера: OBJ,класс,%\\n не чаще 5/с или NONE\\n раз в секунду; ESP32 отвечает ACK\\n на каждый OBJ."],
    ["MicroPython", "В каком порядке плата запускает файлы?", "boot.py, потом main.py."],
    ["MicroPython", "Ctrl+C и Ctrl+D в REPL?", "Ctrl+C — прервать программу. Ctrl+D — мягкая перезагрузка."],
    ["MicroPython", "Как узнать методы драйвера, если нет документации?", "dir(объект) или открыть .py-файл драйвера в Thonny."],
    ["MicroPython", "Почему нельзя писать голый except: в главном цикле?", "Он ловит и KeyboardInterrupt — программу не остановить Ctrl+C (а в B2 не вызвать register())."],
    ["MicroPython", "Зачем global внутри функции?", "Без него присваивание создаёт локальную переменную, глобальная не меняется."],
    ["MicroPython", "Как сделать «раз в секунду» без sleep?", "Хранить момент следующего события: next_t = ticks_add(now, 1000); сравнивать ticks_diff(now, next_t) >= 0."],
    ["MicroPython", "Что можно делать в обработчике таймера?", "Минимум: поставить флаг. Работа — в основном цикле."],
    ["MicroPython", "Как отформатировать 12.44 в «12.4»?", "\"%.1f\" % 12.44"],
    ["MicroPython", "Как получить HEX «0A» из 10?", "\"%02X\" % 10"],
    ["MicroPython", "Как превратить строку в байты и обратно?", "\"abc\".encode() и b\"abc\".decode()."],
    ["MicroPython", "Чего нет в MicroPython re по сравнению с Python?", "Нет re.findall и многих флагов; проще разбирать вручную."],
    ["ИИ и сеть", "Где текст ответа модели в JSON?", "choices[0].message.content"],
    ["ИИ и сеть", "Что значат коды 401, 429, 5xx?", "401 — неверный ключ, 429 — превышен лимит запросов, 5xx — ошибка сервиса."],
    ["ИИ и сеть", "Правила частоты запросов к ИИ?", "Не чаще 1 раза в 5 с; после ошибки не раньше чем через 10 с; ожидание ≤10 с."],
    ["ИИ и сеть", "Четыре вида строк ИИ в журнале?", "мс,AI_REQ · мс,AI_ANS,значение · мс,AI_ERR,причина · мс,AI_BAD"],
    ["ИИ и сеть", "Что делать с недопустимым ответом модели?", "Не применять: оставить значение по умолчанию или последнее допустимое, записать AI_BAD."],
    ["ИИ и сеть", "Зачем temperature 0 и max_tokens 50?", "Предсказуемые короткие ответы, меньше расход и время."],
    ["ИИ и сеть", "Какие поля в secrets.py?", "WIFI_SSID, WIFI_PASS, API_URL, API_KEY, MODEL."],
    ["Задания", "Координаты строк в A1?", "y = 0, 14, 28, 42; шкала y = 54. В остальных модулях 0, 16, 32, 48."],
    ["Задания", "Что показывает экран запуска IIoT?", "IoT STATION XX (y0), WiFi: OK/FAIL (y24), AI: READY/OFFLINE (y40), 2 с."],
    ["Задания", "Когда горит лампа в A2?", "Light:Low и Motion:YES одновременно; держится HOLD после последнего движения; стало светло — гаснет сразу."],
    ["Задания", "Когда порог от ИИ в B1 допустим?", "Целое, больше максимума фона и не больше 4000. Иначе THRESHOLD_DEFAULT и «DEF»."],
    ["Задания", "Формат журнала проходов B2?", "мс,UID,имя,результат,проходы; результаты OK / UNKNOWN / MISMATCH; у отказов «-»."],
    ["Задания", "Когда в C1 объект выводится на OLED?", "После 3 подряд сообщений с одним и тем же классом."],
    ["Задания", "Зона WARN в MA: свет и звук?", "Жёлтый; зуммер 200 мс звук / 600 мс пауза."],
    ["Git", "Как часто коммитить и как назвать финальный коммит?", "Не реже раза в 30 минут; финальный — «A1 final» (по имени модуля) с push до конца времени."],
    ["Git", "Что нельзя делать в репозитории?", "Force-push, удалять историю, менять папки сданных модулей, класть secrets.py и драйверы."]
  ];
  var cats = ["Все"].concat(CARDS.map(function (c) { return c[0]; }).filter(function (c, i, a) { return a.indexOf(c) === i; }));
  var known = load("iot-cards", {});
  var cat = "Все", deck = [], idx = 0;
  var catBox = document.getElementById("card-cats");
  catBox.innerHTML = cats.map(function (c) {
    return '<button type="button" class="chip" data-cat="' + c + '" aria-pressed="' + (c === cat) + '">' + c + "</button>";
  }).join("");
  function build() {
    deck = [];
    CARDS.forEach(function (c, i) { if ((cat === "Все" || c[0] === cat) && !known[i]) deck.push(i); });
    idx = 0;
    show();
  }
  function show() {
    var a = document.getElementById("f-a");
    a.hidden = true;
    document.getElementById("f-hint").hidden = false;
    var total = CARDS.filter(function (c) { return cat === "Все" || c[0] === cat; }).length;
    document.getElementById("f-stat").textContent = "Осталось " + deck.length + " из " + total;
    if (!deck.length) {
      document.getElementById("f-cat").textContent = cat;
      document.getElementById("f-q").textContent = "Все карточки этой категории выучены. Нажми «Начать заново», чтобы пройти ещё раз.";
      a.textContent = "";
      document.getElementById("f-hint").hidden = true;
      return;
    }
    var c = CARDS[deck[idx % deck.length]];
    document.getElementById("f-cat").textContent = c[0];
    document.getElementById("f-q").textContent = c[1];
    a.textContent = c[2];
  }
  function flip() {
    if (!deck.length) return;
    document.getElementById("f-a").hidden = false;
    document.getElementById("f-hint").hidden = true;
  }
  var flash = document.getElementById("flash");
  flash.addEventListener("click", flip);
  flash.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  document.getElementById("f-know").addEventListener("click", function () {
    if (!deck.length) return;
    known[deck[idx % deck.length]] = true;
    save("iot-cards", known);
    deck.splice(idx % deck.length, 1);
    show();
  });
  document.getElementById("f-again").addEventListener("click", function () {
    if (!deck.length) return;
    deck.push(deck.splice(idx % deck.length, 1)[0]);
    show();
  });
  document.getElementById("f-reset").addEventListener("click", function () {
    CARDS.forEach(function (c, i) { if (cat === "Все" || c[0] === cat) delete known[i]; });
    save("iot-cards", known);
    build();
  });
  catBox.addEventListener("click", function (e) {
    var b = e.target.closest(".chip");
    if (!b) return;
    cat = b.dataset.cat;
    catBox.querySelectorAll(".chip").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    build();
  });
  build();

  decorate(document);
  route();
})();
