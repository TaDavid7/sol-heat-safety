"""Builds docs/Sol-Demo-Cheat-Sheet.pdf. Transcript lines are verbatim from a live session (Oct 24, 2026).

    pip install reportlab
    python docs/make-cheatsheet.py            # writes docs/Sol-Demo-Cheat-Sheet.pdf
"""
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table,
                                TableStyle, KeepTogether, PageBreak)

OUT = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).with_name("Sol-Demo-Cheat-Sheet.pdf"))

INK = colors.HexColor("#1f2328")
MUTED = colors.HexColor("#5b6470")
HEAT = colors.HexColor("#c2410c")
SOFT = colors.HexColor("#fff4ec")
TERM_BG = colors.HexColor("#14181f")
RULE = colors.HexColor("#e3e6ea")
TEAL, AMBER, RED, GREEN, GREY = "#5fd7e8", "#f5c451", "#ff7b72", "#7ee2a8", "#9aa4b1"

base = dict(fontName="Helvetica", textColor=INK, leading=13, fontSize=9.5)
H1 = ParagraphStyle("h1", **{**base, "fontName": "Helvetica-Bold", "fontSize": 24, "leading": 28})
SUB = ParagraphStyle("sub", **{**base, "fontSize": 11.5, "leading": 15, "textColor": MUTED})
H2 = ParagraphStyle("h2", **{**base, "fontName": "Helvetica-Bold", "fontSize": 15, "leading": 19, "textColor": HEAT, "spaceBefore": 10, "spaceAfter": 5})
H3 = ParagraphStyle("h3", **{**base, "fontName": "Helvetica-Bold", "fontSize": 11, "leading": 14, "spaceBefore": 8, "spaceAfter": 3})
BODY = ParagraphStyle("body", **{**base, "spaceAfter": 5})
SMALL = ParagraphStyle("small", **{**base, "fontSize": 8.5, "leading": 11, "textColor": MUTED})
CELL = ParagraphStyle("cell", **{**base, "fontSize": 8.4, "leading": 10.6})
CELLB = ParagraphStyle("cellb", parent=CELL, fontName="Helvetica-Bold")
CODE = ParagraphStyle("code", **{**base, "fontName": "Courier-Bold", "fontSize": 9, "leading": 11.5, "textColor": HEAT})
TERM = ParagraphStyle("term", fontName="Courier", fontSize=8, leading=10.2, textColor=colors.HexColor("#e6e9ee"))
TRANS = ParagraphStyle("trans", fontName="Helvetica-Oblique", fontSize=7.8, leading=10, textColor=colors.HexColor(GREY), leftIndent=34)

P = lambda t, s=BODY: Paragraph(t, s)
code = lambda t: f'<font name="Courier-Bold" color="#c2410c">{escape(t)}</font>'


def table(rows, widths, header=True, zebra=True):
    data = [[c if not isinstance(c, str) else Paragraph(c, CELLB if (header and i == 0) else CELL) for c in r] for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
             ("TOPPADDING", (0, 0), (-1, -1), 2.6), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.6), ("LEFTPADDING", (0, 0), (-1, -1), 5)]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), SOFT), ("LINEBELOW", (0, 0), (-1, 0), 0.8, HEAT)]
    t.setStyle(TableStyle(style))
    return t


def terminal(lines):
    """lines: (kind, text[, translation]). kind sets the color like the real terminal."""
    color = {"you": "#ffffff", "sol": TEAL, "worker": "#e6e9ee", "dim": GREY, "warn": AMBER, "err": RED, "ok": GREEN, "sys": "#c9a7ff"}
    rows = []
    for item in lines:
        kind, text = item[0], item[1]
        # keep runs of spaces so the worker table's columns line up
        txt = re.sub(r" {2,}", lambda m: "&nbsp;" * len(m.group()), escape(text))
        if kind == "you":
            txt = f'<font color="#ffb37a">sol&gt; </font><b>{txt}</b>'
        rows.append([Paragraph(f'<font color="{color[kind]}">{txt}</font>' if kind != "you" else txt, TERM)])
        if len(item) > 2:
            rows.append([Paragraph(escape(item[2]), TRANS)])
    t = Table(rows, colWidths=[7.1 * inch])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), TERM_BG), ("LEFTPADDING", (0, 0), (-1, -1), 9),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 1.2),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 1.2), ("TOPPADDING", (0, 0), (-1, 0), 7),
                           ("BOTTOMPADDING", (0, -1), (-1, -1), 7)]))
    return t


def callout(text, bg=SOFT, edge=HEAT):
    t = Table([[Paragraph(text, CELL)]], colWidths=[7.1 * inch])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("LINEBEFORE", (0, 0), (0, -1), 3, edge),
                           ("LEFTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.7 * inch, 0.45 * inch, "Sol heat-safety line · demo cheat sheet")
    canvas.drawRightString(letter[0] - 0.7 * inch, 0.45 * inch, f"Page {doc.page}")
    canvas.setFillColor(HEAT)
    canvas.rect(0, letter[1] - 0.18 * inch, letter[0], 0.18 * inch, stroke=0, fill=1)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=letter, leftMargin=0.7 * inch, rightMargin=0.7 * inch, topMargin=0.65 * inch,
                      bottomMargin=0.7 * inch, title="Sol demo cheat sheet", author="Sol team")
doc.addPageTemplates([PageTemplate(frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")], onPage=footer)])
W = doc.width
s = []

# ---------------- Page 1: what this is + start ----------------
s += [P("Sol: demo cheat sheet", H1), Spacer(1, 4),
      P("Every command, what it means, and what you should see. The example responses are copied word for word from a real test run.", SUB),
      Spacer(1, 10)]

s += [P("The idea in 20 seconds", H2),
      P("Sol is a phone line, not an app. When it's hot, Sol <b>calls</b> farmworkers to check on them, and it <b>texts or calls</b> the supervisor when someone is in trouble. "
        "Nobody looks at a screen."),
      P("Until real phones are connected, the <b>terminal plays the phones</b>. You play three roles by typing:")]
s.append(table([
    ["Role", "What it stands for", "How you play it"],
    ["<b>Director</b>", "Controls the fake farm: heat, time, which worker gets into trouble.", "Commands that start with " + code("/") + ", e.g. " + code("/temp 104")],
    ["<b>Worker</b> (Phone A)", "The farmworker Sol is calling.", "When it rings: press <b>Enter</b> to answer, then just type what they say."],
    ["<b>Supervisor</b> (Phone B)", "The crew boss who gets alerts.", code("/ack") + " = pressing 1 on the phone; " + code("/sms ...") + " = sending a text."],
], [1.35 * inch, 2.75 * inch, W - 4.1 * inch]))

s += [P("Start it", H2)]
s.append(table([
    ["Step", "Do this", "You'll see"],
    ["1", "Open a terminal (VS Code: <i>Terminal &gt; New Terminal</i>).", "A prompt."],
    ["2", code('cd "C:\\Users\\dtani\\Documents\\2026 Projects\\heat"'), "Nothing; you're in the project folder."],
    ["3", code("npm start"), "The banner, a help box, and a table of 6 workers (below)."],
    ["4", code("/temp 104"), code("temperature 104°F") + ". Sol only calls at 80°F or above."],
], [0.45 * inch, 3.3 * inch, W - 3.75 * inch]))
s += [Spacer(1, 6), terminal([
    ("dim", "Twilio not configured: worker calls ring in this terminal. (listening on :3000)"),
    ("worker", "Sol heat-safety line · Sunrise Farms  (simulated field, 30x)"),
    ("worker", "03:57 PM · 98°F · speed 30x · routine off · Claude $0.000"),
    ("worker", "  María López     unknown   40 min since shade  0 min still  normal        row 3, ..."),
    ("worker", "  José Hernández  unknown   25 min since shade  0 min still  normal        row 5, ..."),
    ("worker", "  Ana Ruiz        unknown  105 min since shade  0 min still  skips_breaks  row 8, ..."),
    ("dim", "  ... (Luis, Tom, Rosa)"),
    ("you", "/temp 104"),
    ("dim", "temperature 104°F"),
]), Spacer(1, 6),
    callout("<b>If you see</b> " + code("WARNING: ANTHROPIC_API_KEY is not set") + ", the key in " + code(".env") +
            " is missing. Sol will still ring, but it only says \"I'm having trouble with the line\" and raises a warning.")]

# ---------------- Page 2: command reference ----------------
s += [PageBreak(), P("All commands", H2),
      P("Type a command and press Enter. Names can be first names in any case, with or without accents (" + code("jose") + " = José Hernández).", BODY)]

s.append(P("Director: control the fake farm", H3))
s.append(table([
    ["Type", "What it does (plain English)", "You'll see"],
    [code("/status"), "Shows every worker: how long since shade, how long standing still, where they are, and whether they're OK.", "The worker table."],
    [code("/temp 104"), "Pretend it's 104°F. Below 80°F Sol makes no calls.", code("temperature 104°F")],
    [code("/temp auto"), "Go back to the real heat index for the farm.", "e.g. " + code("temperature 86°F")],
    [code("/speed 60"), "Make farm time run faster (60 = one real second is one farm minute). Default 30.", code("speed 60x")],
    [code("/pause"), "Freeze or unfreeze farm time. Farm time also freezes on its own during calls.", code("paused") + " / " + code("resumed")],
    [code("/skip ana"), "That worker stops taking shade breaks, so Sol calls after 2 hours without shade.", code("Ana Ruiz -> skips_breaks")],
    [code("/stop jose"), "That worker stops moving, so Sol calls after 10 still minutes (about 20 s real time).", code("José Hernández -> stops_moving")],
    [code("/normal jose"), "Back to normal: walks the rows and takes breaks.", code("José Hernández -> normal")],
    [code("/call maria"), "Make Sol call someone right now (good for demos). You can add a reason: " + code("routine") + ", " + code("break_overdue") + " or " + code("not_moving") + ".",
     code("Sol is calling María López ...")],
    [code("/routine on"), "Also do regular check-in calls every 1–2 hours (off by default so the demo stays focused).", code("routine calls on")],
    [code("/help") + "<br/>" + code("/quit"), "Show the command list. Stop the app (or press Ctrl+C).", ""],
], [1.2 * inch, 3.6 * inch, W - 4.8 * inch]))

s.append(P("Worker (Phone A): when the phone is ringing", H3))
s.append(table([
    ["Type", "What it means", "You'll see"],
    ["<b>Enter</b> (empty line)", "Answer the phone.", code("Ana Ruiz picked up") + ", then Sol's greeting."],
    ["any words", "Say this to Sol (Spanish or English; Sol switches language if you do).", "Sol's reply, a few seconds later."],
    [code("/silent"), "Say nothing this turn. Twice in one call = emergency.", code("(silence)") + ", then Sol asks if you can hear it."],
    [code("/hangup"), "Hang up mid-call. If Sol hadn't finished its check, that counts as an emergency.", code("report_status: EMERGENCY")],
    [code("/decline"), "Don't answer. Sol retries in 30 s; a second miss = emergency.", code("did not answer") + " / " + code("will retry")],
], [1.2 * inch, 3.6 * inch, W - 4.8 * inch]))

s.append(P("Supervisor (Phone B)", H3))
s.append(table([
    ["Type", "Real-phone equivalent", "You'll see"],
    [code("/ack"), "Pressing <b>1</b> on the emergency call (\"I'm going\"). Stops the repeat calls.", code("Supervisor pressed 1: on the way to José Hernández")],
    [code("/sms OK JOSE"), "Texting <b>OK JOSE</b> to Sol's number: the worker is safe and the alert is closed.", code("José Hernández marked safe")],
    [code("/sms OK"), "Same, when only one alert is open.", "Asks which name if several are open."],
    [code("/sms STATUS"), "Texting <b>STATUS</b>: get a crew summary back.", code("Sol: 6 workers. 1 emergency: ...")],
], [1.2 * inch, 3.6 * inch, W - 4.8 * inch]))

# ---------------- Page 3: walkthrough 1 ----------------
s += [PageBreak(), P("Walkthrough 1: headache -> WARNING (real run)", H2),
      P("Ana keeps skipping breaks. Sol calls her about the overdue break, hears a headache, tells her to rest, and texts the supervisor.")]
s.append(terminal([
    ("you", "/call ana break_overdue"),
    ("worker", "Sol is calling Ana Ruiz · break_overdue · via terminal"),
    ("warn", " PHONE A RINGING  You are Ana Ruiz (Spanish). Press Enter to answer, /decline to ignore."),
    ("you", "(press Enter)"),
    ("dim", "   Ana Ruiz picked up"),
    ("sol", "   Sol › Hola, Ana Ruiz. Soy Sol, la línea de seguridad contra el calor de Sunrise Farms. Esta llamada se graba por seguridad. ¿Cómo se siente? ¿Tiene dolor de cabeza, mareo o náuseas?",
     "Hi Ana Ruiz. I'm Sol, the heat-safety line for Sunrise Farms. This call is recorded for safety. How do you feel? Any headache, dizziness or nausea?"),
    ("you", "Estoy bien, pero me duele un poco la cabeza."),
    ("sol", "   Sol › Gracias por decírmelo, Ana. El dolor de cabeza con este calor es una señal importante. Por favor, deje de trabajar ahora. Vaya a la sombra, siéntese y tome agua despacio. Ya le toca su descanso para refrescarse. Su supervisor va a venir a verla. ¿Puede ir a la sombra ahora mismo?",
     "Thanks for telling me. A headache in this heat is an important sign. Please stop working now, go to the shade, sit, and sip water. You're due for your cool-down break. Your supervisor will come see you. Can you go to the shade right now?"),
    ("you", "Sí, voy a la sombra ahora."),
    ("warn", "   report_status: WARNING · mild headache, shade break overdue (105 minutes) · took_break=yes"),
    ("warn", "ALERT #1 WARNING · Ana Ruiz · mild headache, shade break overdue (105 minutes)"),
    ("warn", "   SMS -> Supervisor: SOL WARNING – Ana Ruiz: mild headache, shade break overdue (105 minutes). Row 8, about 99 m from Shade tent B. https://maps.google.com/?q=33.681737,-116.170661 Sol told them to rest in shade. Reply OK ANA after you check on them."),
    ("sol", "   Sol › Muy bien, Ana. Descanse en la sombra, tome agua y no esté sola. Su supervisor ya viene, y yo la llamo pronto otra vez.",
     "Very good. Rest in the shade, drink water and don't be alone. Your supervisor is coming, and I'll call you again soon."),
    ("dim", "   call ended · Ana Ruiz · warning"),
]))
s += [Spacer(1, 6), callout("<b>What happens next on its own:</b> in the simulation Ana walks to the shade tent. Because her status is <i>warning</i>, Sol calls her again about 20 farm-minutes later to re-check. "
                            "Text " + code("/sms OK ANA") + " after the supervisor has checked on her to clear it.")]

# ---------------- Page 4: walkthrough 2 ----------------
s += [PageBreak(), P("Walkthrough 2: confused -> EMERGENCY (real run)", H2),
      P("José has stopped moving. When Sol calls, his answer is confused. Sol hears <i>how</i> he talks, calls it an emergency, and rings the supervisor. "
        "(In this run one confused answer was enough. If you stay silent twice instead, the result is the same.)")]
s.append(terminal([
    ("you", "/stop jose        (or, to skip the wait:  /call jose not_moving)"),
    ("sys", "José Hernández: not_moving (no shade 37 min, still 11 min, 104°F)"),
    ("warn", " PHONE A RINGING  You are José Hernández (Spanish). Press Enter to answer, /decline to ignore."),
    ("you", "(press Enter)"),
    ("sol", "   Sol › ¡Hola, José Hernández! Soy Sol, la línea de seguridad contra el calor de Sunrise Farms. Esta llamada se graba por su seguridad. ¿Cómo se siente? ¿Tiene dolor de cabeza, mareo o náuseas? Notamos que no se ha movido en un rato. ¿Está bien?",
     "Hi José! ... How do you feel? Any headache, dizziness or nausea? We noticed you haven't moved in a while. Are you okay?"),
    ("you", "qué... dónde... no sé... el sol"),
    ("err", "   report_status: EMERGENCY · confused speech, fragmented answers, disoriented, not moving · took_break=no"),
    ("err", "ALERT #2 EMERGENCY · José Hernández · confused speech, fragmented answers, disoriented, not moving"),
    ("warn", "   SMS -> Supervisor: SOL EMERGENCY – José Hernández: confused speech, ... Row 5, about 185 m from Shade tent B. https://maps.google.com/?q=... Call 911 if life-threatening. Reply OK JOSE when safe."),
    ("err", "   Calling Supervisor (attempt 1/3): \"Sol heat-safety emergency. José Hernández, row 5, about 185 m from Shade tent B. Signs: confused speech, ... If this is life-threatening, call 911 now. Press 1 if you are going to them.\""),
    ("sol", "   Sol › José, ya viene ayuda. No se quede solo. Busque la sombra si puede y llame a un compañero.",
     "José, help is coming. Don't stay alone. Get to the shade if you can and call a coworker."),
    ("dim", "   call ended · José Hernández · emergency"),
]))
s += [P("Now act as the supervisor", H3)]
s.append(terminal([
    ("you", "/ack"),
    ("ok", "Supervisor pressed 1: on the way to José Hernández"),
    ("you", "/sms STATUS"),
    ("warn", "   reply: Sol: 6 workers. 1 emergency: José Hernández, confused speech, ..., row 5, about 147 m from Shade tent B. 1 warning: Ana Ruiz, mild headache, shade break overdue (105 minutes)."),
    ("you", "/sms OK JOSE"),
    ("ok", "José Hernández marked safe; normal check-ins resume"),
    ("warn", "   reply: Sol: José Hernández marked safe. Normal check-ins resume."),
]))
s += [Spacer(1, 6), P("<b>Cost of both calls together:</b> $0.067 of Claude usage (shown in the " + code("/status") + " header).", SMALL)]

# ---------------- Page 5: other cases, legend, troubleshooting ----------------
s += [PageBreak(), P("Other situations to try", H2),
      P("These follow fixed rules in the code, so the outcome is predictable. Sol's exact words will vary.", SMALL)]
s.append(table([
    ["Try this", "What should happen"],
    ["Answer, then " + code("/silent") + " twice", "<b>EMERGENCY</b>, even if Sol guessed OK: two silences always count as an emergency. The supervisor is called."],
    [code("/decline") + " when it rings", code("did not answer") + ", then Sol retries 30 s later. Decline again: <b>EMERGENCY</b> (\"did not answer two calls in a row\")."],
    ["Answer, then " + code("/hangup") + " before Sol finishes", "<b>EMERGENCY</b> (\"call dropped before Sol could confirm they are okay\")."],
    ["Skip the break, e.g. answer " + code("No puedo parar") + " on a break_overdue call", "At least <b>WARNING</b>: refusing an overdue break is never OK."],
    ["Get an emergency, then type nothing for 6 minutes", "Sol re-calls the supervisor every 2 min. After 3 tries: a red <b>STUCK</b> line plus a final SMS. " + code("/ack") + " still works afterwards."],
    ["Speak English on a Spanish call", "Sol switches to English for the rest of the call."],
    [code("/temp 75"), "No calls at all (below 80°F)."],
    ["No API key / no internet", "Sol says \"I'm having trouble with the line, rest in the shade...\" (marked <b>[fail-safe]</b>) and raises a <b>WARNING</b>."],
], [2.6 * inch, W - 2.6 * inch]))

s += [P("How to read the screen", H2)]
s.append(table([
    ["Line starts with", "Meaning"],
    [code("Sol is calling ...") + " / " + code("PHONE A RINGING"), "Sol is calling a worker. Answer with Enter."],
    [code("Sol ›"), "What Sol says out loud on the call."],
    [code("Ana ›"), "What the worker said (what you typed)."],
    [code("report_status: OK / WARNING / EMERGENCY"), "Sol's verdict at the end of the call. \"raised from ok\" means a safety rule made it stricter."],
    [code("ALERT #n"), "An alert was opened for the supervisor."],
    [code("SMS -> Supervisor"), "The text that would go to the supervisor's phone."],
    [code("Calling Supervisor (attempt 1/3)"), "The emergency phone call to the supervisor, with exactly what it would say."],
    [code("not_moving") + " / " + code("break_overdue"), "Why Sol decided to call (a rule fired)."],
    [code("-- 04:00 PM · 104°F --"), "Farm clock: a summary line every farm hour."],
    [code("STUCK") + " / " + code("SYSTEM"), "Something needs a human now: nobody answered the emergency, or a cost limit was hit."],
], [2.6 * inch, W - 2.6 * inch]))

s += [P("If something looks off", H2)]
s.append(table([
    ["Symptom", "Fix"],
    ["Nobody gets called", "Check the temperature (" + code("/temp 104") + "). Only one call happens at a time, so finish the current one. Or force one with " + code("/call ana") + "."],
    [code("(Sol is thinking...)"), "Normal. Wait 2–5 s for Sol's reply before typing again."],
    [code("No call right now"), "You typed words while no phone was ringing. Commands need a " + code("/") + "."],
    [code("Unknown command /silent"), "The call already ended, so there's nothing to be silent on."],
    [code("EADDRINUSE :3000"), "Sol is already running in another terminal. Close it, or set " + code("PORT=3001") + " in " + code(".env") + "."],
    ["A phone rings in the middle of typing", "That's a check-in Sol decided to make (for example a warning follow-up). Answer it or " + code("/decline") + "."],
], [2.2 * inch, W - 2.2 * inch]))

# ---------------- Page 6: real phones preview ----------------
s += [PageBreak(), P("Next: the same demo on real phones", H2),
      P("Nothing about the app changes. Once Twilio is set up in " + code(".env") + ", the terminal stops pretending to be the phones and the real phones ring. "
        "The terminal becomes the projected backstage log for the judges. Director commands (" + code("/temp") + ", " + code("/stop") + ", " + code("/call") + ", ...) still work.")]
s.append(table([
    ["In the terminal today", "With real phones"],
    ["PHONE A RINGING + Enter", "Phone A rings. (Trial account: a short Twilio message plays, press any key.) Then Sol speaks."],
    ["Typing what the worker says", "Talk. After each answer Sol says \"Ajá…\" or \"Okay…\" while it thinks."],
    [code("/silent"), "Just stay quiet for about 7 seconds."],
    [code("/hangup") + " / " + code("/decline"), "Hang up, or don't answer."],
    ["SMS -> Supervisor line", "A real text arrives on Phone B."],
    ["Calling Supervisor line", "Phone B rings and reads the emergency out loud."],
    [code("/ack"), "Press <b>1</b> on Phone B during that call."],
    [code("/sms OK JOSE") + " / " + code("/sms STATUS"), "Text <b>OK JOSE</b> or <b>STATUS</b> from Phone B to Sol's number."],
    ["(not available)", "Phone B calls Sol's number and hears the crew summary out loud."],
], [2.6 * inch, W - 2.6 * inch]))
s += [Spacer(1, 8), P("Setup checklist (next step)", H3)]
s.append(table([
    ["[ ]", "Twilio account (trial is fine), a Twilio phone number, Account SID and Auth Token"],
    ["[ ]", "Phone A and Phone B added under <i>Verified Caller IDs</i> (required on trial accounts)"],
    ["[ ]", "Tunnel: " + code("winget install Cloudflare.cloudflared") + ", then " + code("cloudflared tunnel --url http://localhost:3000")],
    ["[ ]", code(".env") + ": TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, PUBLIC_URL (tunnel URL), DEMO_PHONE (Phone A), SUPERVISOR_PHONE (Phone B)"],
    ["[ ]", "In the Twilio console, the number's webhooks point to /twilio/inbound, /twilio/status and /twilio/sms (README has exact values)"],
], [0.4 * inch, W - 0.4 * inch], header=False))

doc.build(s)
print("wrote", OUT)
