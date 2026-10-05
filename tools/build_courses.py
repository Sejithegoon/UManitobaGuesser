"""
build_courses.py  -  turns UM's public class schedule spreadsheets into static/courses.json

HOW TO USE
  1. Put the spreadsheets UM publishes (e.g. 202690-class-schedule-public.xlsx and
     202710-class-schedule-public.xlsx) in this tools folder, or in tools/data/.
  2. Run:   python tools/build_courses.py        (or:  cd tools  then  python build_courses.py)
  3. Commit the new static/courses.json and push.

It replaces the old two-step process (dataClean.py -> big JSON -> buildCalendarData.py):
the Excel files go straight to the small file the website loads.

UM term codes:  YYYY90 = Fall of YYYY,  (YYYY+1)10 = Winter.  e.g. 202690 = Fall 2026, 202710 = Winter 2027.
Summer files (other suffixes) are skipped for now because the website only knows Fall and Winter.
"""
import json
import re
import sys
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "static" / "courses.json"

MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
DAY_CODE = {"M": "MO", "T": "TU", "W": "WE", "R": "TH", "F": "FR", "S": "SA", "U": "SU"}
WEEKDAY_CODE = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]      # date.weekday(): Monday = 0
TERM_SUFFIX = {"90": "F", "10": "W"}

# "Sep 09 - Dec 11, 09:30-10:20 (MWF)"  -> every piece after the dates is optional
TIME_RE = re.compile(
    r"^\s*([A-Za-z]{3})\s+(\d{1,2})\s*-\s*([A-Za-z]{3})\s+(\d{1,2})"
    r"\s*(?:,\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2}))?"
    r"\s*(?:\(([MTWRFSU]+)\))?\s*$")
SECTION_RE = re.compile(r"^(\S+)\s*\((\w+)\)\s*$")              # "A01 (10557)"
TITLE_RE = re.compile(r"^(.*?)\s*\(([\d.]+)\)\s*$", re.DOTALL)  # "Ancient Peoples and Places (3)"


def clean_title(t):
    """Tidy odd titles: strip spaces and drop repeated lines (a few spreadsheet cells repeat the title 3 times)."""
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in str(t).split("\n")]
    out = []
    for ln in lines:
        if ln and (not out or out[-1] != ln):
            out.append(ln)
    return " ".join(out)


def hhmm(t):
    h, m = t.split(":")
    return f"{int(h):02d}:{m}"


def year_for(term, month, fall_year):
    """Fall-term dates in Jan-Jun belong to the next calendar year; Winter is always the next year."""
    if term == "F":
        return fall_year + 1 if month <= 6 else fall_year
    return fall_year + 1


def parse_cell(cell, term, fall_year):
    """Returns None (blank), 'bad' (unrecognised text) or a dict describing the meeting."""
    if pd.isna(cell):
        return None
    m = TIME_RE.match(str(cell))
    if not m:
        return "bad"
    mo1, d1, mo2, d2, a, b, days = m.groups()
    if mo1 not in MONTHS or mo2 not in MONTHS:
        return "bad"
    m1, m2, d1, d2 = MONTHS[mo1], MONTHS[mo2], int(d1), int(d2)
    rng = [m1, d1, m2, d2]

    if not a:                                   # dates only, no clock time (online / async)
        return {"dateonly": rng}
    a, b = hhmm(a), hhmm(b)
    if a == "00:00" or b == "23:59":            # placeholder times (clinical / flexible)
        return {"dateonly": rng}

    if days:
        codes = [DAY_CODE[c] for c in days]
        if (m1, d1) == (m2, d2):
            return {"dates": [[m1, d1]], "d": codes, "a": a, "b": b}
        return {"r": rng, "d": codes, "a": a, "b": b}

    # A time but no weekday letters, e.g. "Jan 04 - Jan 04, 08:00-08:55": work the weekday out from the date
    try:
        start = date(year_for(term, m1, fall_year), m1, d1)
        end = date(year_for(term, m2, fall_year), m2, d2)
    except ValueError:
        return {"dateonly": rng}
    n = (end - start).days
    if n < 0 or n > 6:                          # a long range with no weekdays is too vague to place
        return {"dateonly": rng}
    ds = [start + timedelta(days=i) for i in range(n + 1)]
    wd = sorted({WEEKDAY_CODE[x.weekday()] for x in ds}, key=WEEKDAY_CODE.index)
    return {"dates": [[x.month, x.day] for x in ds], "d": wd, "a": a, "b": b, "_recovered": True}


def find_files():
    found = {}
    for folder in (HERE, HERE / "data"):
        for p in folder.glob("*-class-schedule-public.xlsx"):
            found[p.name] = p
    return [found[k] for k in sorted(found)]


def main():
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    files = find_files()
    if not files:
        sys.exit("No *-class-schedule-public.xlsx files found in tools/ or tools/data/.")

    sections = OrderedDict()
    fall_year = None
    stats = {"rows": 0, "unparsed": [], "recovered": 0, "no_time": 0}

    for path in files:
        code = path.stem[:6]
        term = TERM_SUFFIX.get(code[4:6])
        if not term:
            print(f"Skipping {path.name}: term code {code} is not Fall (..90) or Winter (..10).")
            continue
        this_fall = int(code[:4]) if term == "F" else int(code[:4]) - 1
        if fall_year is None:
            fall_year = this_fall
        elif fall_year != this_fall:
            sys.exit(f"{path.name} belongs to a different academic year than the other file(s).")

        print(f"Reading {path.name}  ({'Fall' if term == 'F' else 'Winter'})")
        df = pd.read_excel(path)

        for _, row in df.iterrows():
            stats["rows"] += 1
            course = str(row["COURSE"]).strip()
            sm = SECTION_RE.match(str(row["SECTION (CRN)"]).strip())
            if not sm:
                stats["unparsed"].append(("section", row["SECTION (CRN)"]))
                continue
            section, crn = sm.groups()
            tm = TITLE_RE.match(str(row["TITLE (CREDIT HOURS)"]).strip())
            title, credit = (tm.groups() if tm else (str(row["TITLE (CREDIT HOURS)"]).strip(), ""))
            title = clean_title(title)
            ins = row["INSTRUCTOR"]
            ins = "" if pd.isna(ins) or str(ins).strip().upper() == "TBA" else str(ins).strip()

            sec = sections.get((term, crn))
            if sec is None:
                sec = sections[(term, crn)] = {
                    "d": course.split()[0], "c": course, "s": section, "n": crn,
                    "t": title, "cr": credit, "i": ins, "T": term,
                    "m": [], "o": [], "_singles": OrderedDict()}

            res = parse_cell(row["COURSE TIME"], term, fall_year)
            if res is None:
                continue
            if res == "bad":
                stats["unparsed"].append((course, row["COURSE TIME"]))
                continue
            if "dateonly" in res:
                if not sec["o"]:
                    sec["o"].append(res["dateonly"])
            elif "dates" in res:
                key = (tuple(res["d"]), res["a"], res["b"])
                sec["_singles"].setdefault(key, set()).update(tuple(x) for x in res["dates"])
                if res.get("_recovered"):
                    stats["recovered"] += 1
            else:
                mt = {"r": res["r"], "d": res["d"], "a": res["a"], "b": res["b"]}
                if mt not in sec["m"]:
                    sec["m"].append(mt)

    # finish each section
    final = []
    seen = set()
    for (term, crn), sec in sections.items():
        for (days, a, b), dates in sec.pop("_singles").items():
            ordered = sorted(dates, key=lambda md: (year_for(term, md[0], fall_year), md[0], md[1]))
            sec["m"].append({"x": [list(x) for x in ordered], "d": list(days), "a": a, "b": b})
        if sec["m"]:
            sec["o"] = []
        else:
            stats["no_time"] += 1
        if crn in seen:
            print(f"WARNING: CRN {crn} appears in more than one term; the website expects unique CRNs.")
        seen.add(crn)
        final.append(sec)

    out = {"meta": {"fallYear": fall_year}, "sections": final}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    size = out_path.stat().st_size / 1e6
    print(f"\n{stats['rows']} spreadsheet rows -> {len(final)} sections  ({size:.2f} MB)")
    print(f"  Fall {fall_year} / Winter {fall_year + 1}")
    print(f"  with set meeting times: {len(final) - stats['no_time']}   (no set time: {stats['no_time']})")
    print(f"  rows rescued (time but no weekday letters): {stats['recovered']}")
    if stats["unparsed"]:
        print(f"  could not read {len(stats['unparsed'])} cells, for example:")
        for item in stats["unparsed"][:5]:
            print("    ", item)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
