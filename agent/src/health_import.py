"""A health app's export -> the workouts and daily numbers Serve's agent organizes. Standard library only; the file is
read in place (a zip is never extracted to disk). Runs on the GPU server, called by agent/src/health.js.
  Apple Health   export.zip (or export.xml): workouts with their heart rate, energy, distance and GPS routes; daily
                 steps, resting heart rate, heart rate variability and sleep
  Google Fit     a Takeout zip: the daily metrics CSV and every activity's TCX file
  any app        one GPX, TCX or CSV file (Strava, Garmin, Huawei, Samsung, a spreadsheet: date, sport, minutes, ...)
  python3 -I health_import.py <in> <out.json> [file name] [days back, default 120] [UTC offset in minutes]
Output: {source, file, workouts: [{date, start, minutes, sport, source, app, kcal, km, avgHr, maxHr, route}],
         days: [{date, steps, restingHr, hrv, sleepH}], counts}
"""
import csv
import io
import json
import math
import os
import re
import sys
import zipfile
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta, timezone

SRC, OUT = sys.argv[1], sys.argv[2]
NAME = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(SRC)
BACK = int(sys.argv[4]) if len(sys.argv) > 4 else 120
TZ = timezone(timedelta(minutes=int(sys.argv[5]) if len(sys.argv) > 5 else 480))
CUT = (datetime.now(TZ) - timedelta(days=BACK)).strftime("%Y-%m-%d")
MAX_READ = 3 * 1024 ** 3  # stop reading after 3 GB, whatever the zip says
ATTR = re.compile(r'(\w+)="([^"]*)"')
SPORT = {"badminton": "badminton", "tennis": "tennis", "pickleball": "pickleball", "tabletennis": "table tennis", "pingpong": "table tennis",
         "basketball": "basketball", "volleyball": "volleyball", "soccer": "soccer", "football": "soccer", "squash": "squash",
         "running": "running", "run": "running", "jogging": "running", "walking": "walking", "walk": "walking", "hiking": "hiking",
         "cycling": "cycling", "biking": "cycling", "ride": "cycling", "swimming": "swimming", "swim": "swimming",
         "traditionalstrengthtraining": "strength", "functionalstrengthtraining": "strength", "strength": "strength", "weighttraining": "strength",
         "highintensityintervaltraining": "hiit", "hiit": "hiit", "yoga": "yoga", "pilates": "yoga", "rowing": "rowing", "elliptical": "elliptical"}


def sport_of(*names):
    for n in names:
        k = re.sub(r"[^a-z]", "", str(n or "").lower().replace("hkworkoutactivitytype", ""))
        if k in SPORT:
            return SPORT[k]
        for w, s in SPORT.items():
            if len(w) > 3 and w in k:
                return s
    return "other"


def local(dt):
    return dt.astimezone(TZ) if dt.tzinfo else dt.replace(tzinfo=TZ)


def iso(s):
    s = s.strip().replace("Z", "+00:00")
    for f in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return local(datetime.strptime(s, f))
        except ValueError:
            pass
    return None


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def thin(pts, n=160):
    if len(pts) <= n:
        return [[round(a, 5), round(b, 5)] for a, b in pts]
    step = (len(pts) - 1) / (n - 1)
    return [[round(pts[round(i * step)][0], 5), round(pts[round(i * step)][1], 5)] for i in range(n)]


def track(text):
    """GPX or TCX text -> (points [(lat, lon)], times, heart rates)"""
    pts, ts, hr = [], [], []
    if "<Trackpoint" in text:  # TCX
        for tp in re.findall(r"<Trackpoint>(.*?)</Trackpoint>", text, re.S):
            la, lo = re.search(r"<LatitudeDegrees>([-\d.]+)", tp), re.search(r"<LongitudeDegrees>([-\d.]+)", tp)
            t, h = re.search(r"<Time>([^<]+)", tp), re.search(r"<HeartRateBpm>\s*<Value>(\d+)", tp)
            if la and lo:
                pts.append((float(la.group(1)), float(lo.group(1))))
            if t:
                ts.append(iso(t.group(1)))
            if h:
                hr.append(int(h.group(1)))
    else:  # GPX
        for m in re.finditer(r"<trkpt\b([^>]*)>(.*?)</trkpt>", text, re.S):
            a = dict(ATTR.findall(m.group(1)))
            if "lat" in a and "lon" in a:
                pts.append((float(a["lat"]), float(a["lon"])))
            t, h = re.search(r"<time>([^<]+)", m.group(2)), re.search(r"<(?:\w+:)?hr>(\d+)<", m.group(2))
            if t:
                ts.append(iso(t.group(1)))
            if h:
                hr.append(int(h.group(1)))
    return pts, [t for t in ts if t], hr


def workout_from_track(text, fname, source):
    pts, ts, hr = track(text)
    if not ts:
        return None
    start, end = ts[0], ts[-1]
    tot = re.findall(r"<TotalTimeSeconds>([\d.]+)", text)
    minutes = round(sum(map(float, tot)) / 60) if tot else round((end - start).total_seconds() / 60)
    dist = re.findall(r"<Lap\b.*?<DistanceMeters>([\d.]+)", text, re.S)
    kmv = round(sum(map(float, dist)) / 1000, 2) if dist else round(sum(km(a, b) for a, b in zip(pts, pts[1:])), 2) if len(pts) > 1 else None
    cal = re.findall(r"<Calories>(\d+)", text)
    sport = sport_of(*(re.findall(r'<Activity Sport="([^"]+)"', text) + re.findall(r"<type>([^<]+)</type>", text) + [os.path.splitext(fname)[0].split("_")[-1], fname] + re.findall(r"<name>([^<]+)</name>", text)))
    return {"date": start.strftime("%Y-%m-%d"), "start": start.strftime("%H:%M"), "minutes": minutes, "sport": sport, "source": source, "app": None,
            "kcal": sum(map(int, cal)) or None, "km": kmv or None, "avgHr": round(sum(hr) / len(hr)) if hr else None, "maxHr": max(hr) if hr else None,
            "route": thin(pts) if len(pts) > 1 else None}


def lines(f):
    read = 0
    for raw in io.TextIOWrapper(f, encoding="utf-8", errors="replace"):
        read += len(raw)
        if read > MAX_READ:
            break
        yield raw


def apple(f, routes):
    steps, rest, hrv, sleep, hr, workouts, w = {}, {}, {}, {}, [], [], None
    for ln in lines(f):
        s = ln.lstrip()
        if s.startswith("<Record "):
            if not any(k in s for k in ("StepCount", "RestingHeartRate", "HeartRateVariability", '"HKQuantityTypeIdentifierHeartRate"', "SleepAnalysis")):
                continue
            a = dict(ATTR.findall(s))
            t, d = a.get("type", ""), a.get("startDate", "")[:10]
            if d < CUT:
                continue
            try:
                v = float(a.get("value", "nan"))
            except ValueError:
                v = float("nan")
            if t.endswith("StepCount"):
                k = (d, a.get("sourceName", ""))
                steps[k] = steps.get(k, 0) + v
            elif t.endswith("RestingHeartRate"):
                rest.setdefault(d, []).append(v)
            elif t.endswith("HeartRateVariabilitySDNN"):
                hrv.setdefault(d, []).append(v)
            elif t == "HKQuantityTypeIdentifierHeartRate":
                st = iso(a["startDate"])
                if st:
                    hr.append((st.timestamp(), v))
            elif t.endswith("SleepAnalysis") and "Asleep" in a.get("value", ""):
                st, en = iso(a["startDate"]), iso(a["endDate"])
                if st and en:
                    k = (en.strftime("%Y-%m-%d"), a.get("sourceName", ""))
                    sleep[k] = sleep.get(k, 0) + (en - st).total_seconds() / 3600
        elif s.startswith("<Workout "):
            a = dict(ATTR.findall(s))
            st, en = iso(a.get("startDate", "")), iso(a.get("endDate", ""))
            dur = float(a.get("duration", 0) or 0) * (60 if a.get("durationUnit") == "hr" else 1 / 60 if a.get("durationUnit") == "s" else 1)
            w = {"date": st.strftime("%Y-%m-%d") if st else "", "start": st.strftime("%H:%M") if st else None, "minutes": round(dur) or (round((en - st).total_seconds() / 60) if st and en else 0),
                 "sport": sport_of(a.get("workoutActivityType")), "source": "Apple Health", "app": a.get("sourceName"), "kcal": round(float(a["totalEnergyBurned"])) if a.get("totalEnergyBurned") else None,
                 "km": round(float(a["totalDistance"]), 2) if a.get("totalDistance") else None, "avgHr": None, "maxHr": None, "route": None, "_t": (st.timestamp() if st else 0, en.timestamp() if en else 0), "_route": None}
            if s.rstrip().endswith("/>"):
                workouts.append(w)
                w = None
        elif w is not None:
            if s.startswith("<WorkoutStatistics "):
                a = dict(ATTR.findall(s))
                t = a.get("type", "")
                if t.endswith("HeartRate") and a.get("average"):
                    w["avgHr"], w["maxHr"] = round(float(a["average"])), round(float(a.get("maximum") or a["average"]))
                elif t.endswith("ActiveEnergyBurned") and a.get("sum") and not w["kcal"]:
                    w["kcal"] = round(float(a["sum"]))
                elif "Distance" in t and a.get("sum") and not w["km"]:
                    w["km"] = round(float(a["sum"]) * (1.609 if a.get("unit") == "mi" else 0.001 if a.get("unit") == "m" else 1), 2)
            elif s.startswith("<FileReference "):
                w["_route"] = dict(ATTR.findall(s)).get("path")
            elif s.startswith("</Workout>"):
                workouts.append(w)
                w = None
    workouts = [x for x in workouts if x["date"] >= CUT]
    hr.sort()
    ts = [t for t, _ in hr]
    for x in workouts:
        if x["avgHr"] is None and hr:
            i, j = bisect_left(ts, x["_t"][0]), bisect_right(ts, x["_t"][1])
            if j - i >= 3:
                vals = [v for _, v in hr[i:j]]
                x["avgHr"], x["maxHr"] = round(sum(vals) / len(vals)), round(max(vals))
        if x["_route"] and routes:
            text = routes(x["_route"])
            if text:
                pts, _, _ = track(text)
                x["route"] = thin(pts) if len(pts) > 1 else None
                if not x["km"] and len(pts) > 1:
                    x["km"] = round(sum(km(a, b) for a, b in zip(pts, pts[1:])), 2)
        x.pop("_t")
        x.pop("_route")
    # steps and sleep come from the phone and the watch at once: per day, the source that counted the most
    best = lambda m: {d: max(v for (dd, _), v in m.items() if dd == d) for d in {d for d, _ in m}}
    st, sl = best(steps), best(sleep)
    dates = sorted(set(st) | set(rest) | set(hrv) | set(sl))
    days = [{"date": d, "steps": round(st[d]) if d in st else None, "restingHr": round(sum(rest[d]) / len(rest[d])) if d in rest else None,
             "hrv": round(sum(hrv[d]) / len(hrv[d])) if d in hrv else None, "sleepH": round(sl[d], 1) if d in sl else None} for d in dates]
    return workouts, days


def fit_daily(text):
    days = []
    for r in csv.DictReader(io.StringIO(text)):
        d = (r.get("Date") or r.get("date") or "")[:10]
        if not d or d < CUT:
            continue
        num = lambda *ks: next((float(r[k]) for k in ks if r.get(k) not in (None, "")), None)
        st = num("Step count", "Steps", "steps")
        days.append({"date": d, "steps": round(st) if st is not None else None, "restingHr": None, "hrv": None, "sleepH": None,
                     "avgHr": round(num("Average heart rate (bpm)") or 0) or None, "moveMin": round(num("Move Minutes count") or 0) or None})
    return days


def generic_csv(text):
    rows, out = list(csv.DictReader(io.StringIO(text))), []
    if rows and "Step count" in rows[0]:
        return [], fit_daily(text)
    pick = lambda r, *ks: next((r[k] for k in r if k and k.strip().lower() in ks and r[k] not in (None, "")), None)
    for r in rows:
        dt = iso(pick(r, "date", "start", "start time", "starttime", "datetime", "activity date") or "")
        if not dt or dt.strftime("%Y-%m-%d") < CUT:
            continue
        dur = pick(r, "minutes", "duration", "duration (min)", "elapsed time", "moving time", "time")
        mins = None
        if dur:
            if ":" in dur:
                p = [float(x) for x in dur.split(":")]
                mins = round(p[0] * 60 + p[1] + (p[2] / 60 if len(p) > 2 else 0)) if len(p) > 2 else round(p[0] * 60 + p[1])
            else:
                v = float(re.sub(r"[^\d.]", "", dur) or 0)
                mins = round(v / 60) if v > 600 else round(v)
        hr = pick(r, "avg_hr", "average heart rate", "avg heart rate", "heart rate", "avghr")
        out.append({"date": dt.strftime("%Y-%m-%d"), "start": dt.strftime("%H:%M") if dt.hour or dt.minute else None, "minutes": mins or 0,
                    "sport": sport_of(pick(r, "sport", "activity", "activity type", "type", "name")), "source": "CSV", "app": None,
                    "kcal": round(float(pick(r, "calories", "kcal") or 0)) or None, "km": None, "avgHr": round(float(hr)) if hr else None, "maxHr": None, "route": None})
    return out, []


def main():
    source, workouts, days = None, [], []
    with open(SRC, "rb") as f:
        head = f.read(4096)
    if head[:2] == b"PK":
        z = zipfile.ZipFile(SRC)
        names = z.namelist()
        xml = [n for n in names if n.endswith("export.xml") and "cda" not in n.lower()]
        if xml:
            source = "Apple Health"
            root = xml[0][: -len("export.xml")]
            byname = {n.lower(): n for n in names}

            def routes(p):
                n = byname.get((root + p.lstrip("/")).lower())
                if not n or z.getinfo(n).file_size > 50e6:
                    return None
                return z.read(n).decode("utf-8", "replace")
            with z.open(xml[0]) as f:
                workouts, days = apple(f, routes)
        else:
            source = "Google Fit" if any("/Fit/" in n or n.startswith("Fit/") for n in names) else "a zip of workouts"
            for n in names:
                low = n.lower()
                if z.getinfo(n).file_size > 50e6:
                    continue
                if low.endswith((".tcx", ".gpx")):
                    w = workout_from_track(z.read(n).decode("utf-8", "replace"), os.path.basename(n), source)
                    if w and w["date"] >= CUT:
                        workouts.append(w)
                elif low.endswith(".csv") and ("daily" in low or "metrics" in low):
                    days += fit_daily(z.read(n).decode("utf-8-sig", "replace"))
                elif low.endswith(".csv"):
                    w2, d2 = generic_csv(z.read(n).decode("utf-8-sig", "replace"))
                    workouts += w2
                    days += d2
    else:
        text = open(SRC, encoding="utf-8-sig", errors="replace").read() if os.path.getsize(SRC) < 200e6 else ""
        if "<HealthData" in text[:20000]:
            source = "Apple Health"
            with open(SRC, "rb") as f:
                workouts, days = apple(f, None)
        elif "<gpx" in text[:2000] or "<TrainingCenterDatabase" in text[:2000]:
            source = "GPX" if "<gpx" in text[:2000] else "TCX"
            w = workout_from_track(text, NAME, source)
            workouts = [w] if w else []
        else:
            source = "CSV"
            workouts, days = generic_csv(text)
    workouts.sort(key=lambda x: (x["date"], x["start"] or ""))
    json.dump({"source": source, "file": NAME, "workouts": workouts, "days": sorted(days, key=lambda d: d["date"]),
               "counts": {"workouts": len(workouts), "routes": sum(1 for x in workouts if x.get("route")), "days": len(days)}}, open(OUT, "w"))


main()
