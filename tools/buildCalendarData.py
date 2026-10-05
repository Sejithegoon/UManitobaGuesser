"""
buildCalendarData.py
Turns the big allCourses JSON (from dataClean.py) into a compact file the website can load fast.

Run it from the project folder:
    python tools/buildCalendarData.py "allCourses 2026  2027 .json" static/courses.json

What it does:
  * Groups rows that share a CRN into ONE section (your JSON has one row per meeting date
    for tutorials that only meet on certain days, which is why CRNs repeat).
  * Works out the term (F = Fall, W = Winter) from the dates, since the year was only in the
    spreadsheet file names.
  * Treats meetings with no real clock time (online/async, 00:00-23:59 placeholders) as "no set time".
  * Writes minified JSON with short keys.

Update FALL_YEAR when you load a new academic year.
"""
import json, sys, collections

FALL_YEAR = 2026          # Fall term year (Winter is FALL_YEAR + 1)

src = sys.argv[1] if len(sys.argv) > 1 else "allCourses_2026__2027_.json"
dst = sys.argv[2] if len(sys.argv) > 2 else "static/courses.json"

rows = json.load(open(src, encoding="utf-8"))["courses"]

groups = collections.OrderedDict()
for r in rows:
    groups.setdefault(r["crn"], []).append(r)

sections = []
for crn, rs in groups.items():
    first = rs[0]
    timed = [r["time"] for r in rs if len(r["time"]) in (4, 7)]
    # Term: any meeting that starts in May or later means Fall (Fall/Winter spanning classes start in Sep)
    term = "F" if any(t[0] >= 5 for t in timed) else "W"

    ranged = []          # weekly meetings
    singles = collections.OrderedDict()   # (days, start, end) -> [[m, d], ...]
    dateonly = []        # no clock time
    for t in timed:
        m1, d1, m2, d2 = t[:4]
        if len(t) == 7:
            days, a, b = t[4], t[5], t[6]
            if a == "00:00" or b == "23:59":     # placeholder times (clinical, flexible)
                dateonly.append([m1, d1, m2, d2])
            elif (m1, d1) == (m2, d2):
                singles.setdefault((tuple(days), a, b), []).append([m1, d1])
            else:
                mt = {"r": [m1, d1, m2, d2], "d": days, "a": a, "b": b}
                if mt not in ranged:
                    ranged.append(mt)
        else:
            if [m1, d1, m2, d2] not in dateonly:
                dateonly.append([m1, d1, m2, d2])

    meetings = list(ranged)
    for (days, a, b), dates in singles.items():
        dates.sort()
        meetings.append({"x": dates, "d": list(days), "a": a, "b": b})

    sections.append({
        "d": first["dep"],
        "c": first["course"],
        "s": first["section"],
        "n": crn,
        "t": first["title"],
        "cr": first["credit"],
        "i": first["ins"],
        "T": term,
        "m": meetings,
        "o": dateonly[:1] if not meetings else [],   # date range only (no set time)
    })

out = {"meta": {"fallYear": FALL_YEAR}, "sections": sections}
with open(dst, "w", encoding="utf-8") as f:
    json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

import os
print(f"{len(rows)} rows -> {len(sections)} sections, {os.path.getsize(dst)/1e6:.2f} MB")
print("with set meeting times:", sum(1 for s in sections if s["m"]))
print("Fall:", sum(1 for s in sections if s["T"]=="F"), " Winter:", sum(1 for s in sections if s["T"]=="W"))
