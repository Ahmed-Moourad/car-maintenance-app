#!/usr/bin/env python3
"""Read the private Google Sheet, work out which items are overdue / due soon,
and send a digest by email (Gmail SMTP) and/or phone push (ntfy).

Runs from GitHub Actions (see .github/workflows/reminders.yml).

Environment:
  GOOGLE_SA_JSON      Full JSON key of a Google service account that has Viewer access to the Sheet
  SHEET_ID            The Google Sheet id (from its URL)
  GMAIL_USER          Gmail address used to send (required unless --dry-run)
  GMAIL_APP_PASSWORD  Google "App password" for that account (required unless --dry-run)
  REMINDER_TO         Recipient (optional; falls back to Settings.owner_email, then GMAIL_USER)
  NTFY_TOPIC          Optional. Free phone push via ntfy.sh: a long, unguessable topic name
                      (subscribe to it in the ntfy Android app). Works with or without email.
  GITHUB_REPOSITORY   Set automatically by Actions ("owner/repo"), used for the app link

Usage:
  python scripts/send_reminders.py [--dry-run] [--force]
"""
import argparse
import calendar
import datetime as dt
import hashlib
import json
import os
import re
import urllib.request
import smtplib
import ssl
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "data" / "state.json"
TZ = ZoneInfo("Africa/Cairo")

LABELS = {"overdue": "متأخر", "soon": "قرّب"}


# ---------- helpers (mirrored in docs/logic.js; keep them in sync) ----------

def num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f == int(f) else f


def norm_date(v):
    """Accept ISO text, datetime/date, or an Excel serial number -> 'YYYY-MM-DD' or ''."""
    if v is None or v == "":
        return ""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (int, float)):
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    s = str(v).strip()[:10]
    try:
        return dt.date.fromisoformat(s).isoformat()
    except ValueError:
        return ""


def add_months(d, n):
    total = d.year * 12 + (d.month - 1) + n
    y, m = divmod(total, 12)
    m += 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def compute_status(item, settings, today):
    odo = num(settings.get("current_odometer"))
    warn_km = num(settings.get("warn_km"))
    warn_km = 1000 if warn_km is None else warn_km
    warn_days = num(settings.get("warn_days"))
    warn_days = 30 if warn_days is None else warn_days

    every_km, every_mo = num(item.get("every_km")), num(item.get("every_months"))
    last_km = num(item.get("last_km"))
    last_date_s = norm_date(item.get("last_date"))
    last_date = dt.date.fromisoformat(last_date_s) if last_date_s else None

    due_km = due_date = km_left = days_left = None
    if every_km and last_km is not None:
        due_km = last_km + every_km
        if odo is not None:
            km_left = due_km - odo
    if every_mo and last_date:
        due_date = add_months(last_date, int(every_mo))
        days_left = (due_date - today).days

    status = "unset"
    if due_km is not None or due_date is not None:
        over = (km_left is not None and km_left < 0) or (days_left is not None and days_left < 0)
        soon = (km_left is not None and km_left <= warn_km) or (days_left is not None and days_left <= warn_days)
        status = "overdue" if over else "soon" if soon else "ok"
    return {
        "status": status,
        "due_km": due_km,
        "due_date": due_date.isoformat() if due_date else None,
        "km_left": km_left,
        "days_left": days_left,
    }


def values_to_rows(values):
    """Sheets API 'values' (list of rows, first row = headers) -> list of dicts."""
    if not values:
        return []
    headers = [str(h).strip() for h in values[0]]
    out = []
    for r in values[1:]:
        if all(c is None or c == "" for c in r):
            continue
        out.append({h: (r[i] if i < len(r) else "") for i, h in enumerate(headers) if h})
    return out


def fetch_value_ranges(sheet_id, sa_info):
    """Read the Settings / Items / Log tabs with a read-only service account."""
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    creds = service_account.Credentials.from_service_account_info(
        sa_info, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    resp = AuthorizedSession(creds).get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values:batchGet",
        params=[("valueRenderOption", "UNFORMATTED_VALUE"), ("majorDimension", "ROWS"),
                ("ranges", "Settings"), ("ranges", "Items")],
        timeout=30)
    if resp.status_code != 200:
        hint = {403: " (share the Sheet with the service account's email as Viewer, and enable the Google Sheets API)",
                404: (" (Google can't find a Sheet with that id for this service account. Check: (1) SHEET_ID is only the part between"
                      " /d/ and /edit in the Sheet URL; (2) the file is a native Google Sheet, not an uploaded .xlsx;"
                      " (3) the Sheet is shared with the service account's client_email as Viewer)"),
                400: " (the Sheet needs tabs named Settings and Items, and must be a native Google Sheet, not .xlsx)"}.get(resp.status_code, "")
        sys.exit(f"Google Sheets API error {resp.status_code}{hint}: {resp.text[:300]}")
    return resp.json().get("valueRanges", [])


def normalize_sheet_id(raw):
    """Accept a bare id, or a pasted URL / quoted value, and return just the id."""
    raw = (raw or "").strip().strip("\"'").strip()
    m = re.search(r"/d/([A-Za-z0-9_-]+)", raw)
    return m.group(1) if m else raw


def load_data(value_ranges=None):
    if value_ranges is None:
        sheet_id = normalize_sheet_id(os.environ.get("SHEET_ID"))
        sa_raw = os.environ.get("GOOGLE_SA_JSON") or ""
        if not sheet_id or not sa_raw:
            sys.exit("Set the SHEET_ID and GOOGLE_SA_JSON GitHub secrets.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{25,}", sheet_id):
            sys.exit(f"SHEET_ID doesn't look like a Google Sheet id (got {len(sheet_id)} characters). "
                     "It should be the long part between /d/ and /edit in the Sheet URL.")
        value_ranges = fetch_value_ranges(sheet_id, json.loads(sa_raw))
    settings = {str(r["key"]).strip(): r.get("value") for r in values_to_rows(value_ranges[0].get("values")) if r.get("key")}
    items = values_to_rows(value_ranges[1].get("values"))
    return settings, items


# ---------- email ----------

def fmt(n):
    return "—" if n is None else f"{int(n):,}"


def describe(item, st):
    parts = []
    if st["due_km"] is not None:
        if st["km_left"] is None:
            parts.append(f"عند {fmt(st['due_km'])} كم")
        elif st["km_left"] < 0:
            parts.append(f"متأخر {fmt(-st['km_left'])} كم (كان عند {fmt(st['due_km'])})")
        else:
            parts.append(f"باقي {fmt(st['km_left'])} كم (عند {fmt(st['due_km'])})")
    if st["due_date"] is not None:
        d = st["days_left"]
        if d < 0:
            parts.append(f"متأخر {-d} يوم (كان {st['due_date']})")
        else:
            parts.append(f"باقي {d} يوم ({st['due_date']})")
    return " — ".join(parts)


def build_email(settings, results, app_url):
    odo = num(settings.get("current_odometer"))
    groups = {
        "overdue": [(i, s) for i, s in results if s["status"] == "overdue"],
        "soon": [(i, s) for i, s in results if s["status"] == "soon"],
    }
    unset = sum(1 for _, s in results if s["status"] == "unset")
    n_over, n_soon = len(groups["overdue"]), len(groups["soon"])
    subject = f"🔧 صيانة العربية: {n_over} متأخر، {n_soon} قرّب (عداد {fmt(odo)} كم)"

    text = [f"العداد المسجّل: {fmt(odo)} كم", ""]
    html = [
        '<div dir="rtl" style="font-family:Arial,Tahoma,sans-serif;font-size:15px;line-height:1.7;color:#222">',
        f"<p>العداد المسجّل: <b>{fmt(odo)} كم</b></p>",
    ]
    colors = {"overdue": "#C00000", "soon": "#9C6500"}
    for key in ("overdue", "soon"):
        if not groups[key]:
            continue
        text.append(f"== {LABELS[key]} ==")
        html.append(f'<h3 style="color:{colors[key]};margin:16px 0 4px">{LABELS[key]}</h3><ul style="margin:0;padding-right:20px">')
        for item, st in groups[key]:
            line = describe(item, st)
            text.append(f"- {item.get('item')}: {line}")
            html.append(f"<li><b>{escape(str(item.get('item')))}</b><br><span style=\"color:#555\">{escape(line)}</span></li>")
        html.append("</ul>")
        text.append("")
    if unset:
        note = f"في {unset} بند لسه ماتسجلش ليه آخر مرة (مش داخل في التنبيهات)."
        text.append(note)
        html.append(f'<p style="color:#777">{escape(note)}</p>')
    if app_url:
        text += ["", f"افتح التطبيق: {app_url}"]
        html.append(f'<p><a href="{escape(app_url)}">افتح التطبيق لتسجيل الصيانة وتحديث العداد</a></p>')
    html.append("</div>")
    return subject, "\n".join(text), "".join(html)


def send(subject, text, html, to_addr):
    user = os.environ.get("GMAIL_USER")
    pwd = os.environ.get("GMAIL_APP_PASSWORD")
    msg = MIMEMultipart("alternative")
    msg["Subject"], msg["From"], msg["To"] = subject, user, to_addr
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()) as s:
        s.login(user, pwd.replace(" ", ""))
        s.sendmail(user, [to_addr], msg.as_string())


def push_ntfy(subject, text, app_url, topic):
    """Free phone push through ntfy.sh (JSON publish, so Arabic text is fine)."""
    body = {"topic": topic, "title": subject, "message": text[:3500], "priority": 4, "tags": ["wrench"]}
    if app_url:
        body["click"] = app_url
    req = urllib.request.Request("https://ntfy.sh", data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                 headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print the email instead of sending")
    ap.add_argument("--force", action="store_true", help="send even if nothing changed since the last reminder")
    args = ap.parse_args()

    today = dt.datetime.now(TZ).date()
    settings, items = load_data()
    results = [(i, compute_status(i, settings, today)) for i in items]
    problems = [(i, s) for i, s in results if s["status"] in ("overdue", "soon")]
    if not problems:
        print("Nothing overdue or due soon. No email.")
        return

    signature = hashlib.sha256("|".join(sorted(f"{i.get('id')}:{s['status']}" for i, s in problems)).encode()).hexdigest()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    remind_every = num(settings.get("remind_every_days")) or 7
    last_sent = dt.date.fromisoformat(state["last_sent"]) if state.get("last_sent") else None
    changed = state.get("signature") != signature
    stale = last_sent is None or (today - last_sent).days >= remind_every
    if not (args.force or args.dry_run or changed or stale):
        print(f"Same items as last reminder ({last_sent}); next reminder in {remind_every - (today - last_sent).days} day(s).")
        return

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    app_url = f"https://{repo.split('/')[0]}.github.io/{repo.split('/')[1]}/" if "/" in repo else ""
    subject, text, html = build_email(settings, results, app_url)

    if args.dry_run:
        print("Subject:", subject, "\n")
        print(text)
        return

    has_mail = bool(os.environ.get("GMAIL_USER") and os.environ.get("GMAIL_APP_PASSWORD"))
    topic = (os.environ.get("NTFY_TOPIC") or "").strip()
    if not has_mail and not topic:
        sys.exit("Set GMAIL_USER + GMAIL_APP_PASSWORD (email) and/or NTFY_TOPIC (phone push) as GitHub secrets.")

    delivered = []
    errors = []
    if has_mail:
        to_addr = os.environ.get("REMINDER_TO") or settings.get("owner_email") or os.environ.get("GMAIL_USER")
        try:
            send(subject, text, html, to_addr)
            delivered.append(f"email to {to_addr}")
        except Exception as e:  # keep going: a push may still work
            errors.append(f"email failed: {e}")
    if topic:
        try:
            push_ntfy(subject, text, app_url, topic)
            delivered.append("ntfy push")
        except Exception as e:
            errors.append(f"ntfy failed: {e}")

    for e in errors:
        print(e, file=sys.stderr)
    if not delivered:
        sys.exit("Nothing was delivered; will retry on the next run.")
    STATE.write_text(json.dumps({"last_sent": today.isoformat(), "signature": signature}, ensure_ascii=False, indent=2) + "\n")
    print(f"Reminder delivered via {', '.join(delivered)}: {len(problems)} item(s).")


if __name__ == "__main__":
    main()