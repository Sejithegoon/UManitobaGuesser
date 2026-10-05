# tools/

Scripts that build the data for the Class Calendar page. They are not part of the website itself.

## Yearly / termly update

1. Download the new schedule spreadsheets from UM (names look like `202690-class-schedule-public.xlsx`).
2. Put them in this folder (or in `tools/data/`). Delete last year's.
3. From the project folder run:

       python tools/build_courses.py

   You need `pandas` and `openpyxl` (`pip install pandas openpyxl`).
4. Check the summary it prints, then commit and push the new `static/courses.json`.
5. Update the holiday and term-break dates at the top of `static/calendarCore.js` (the `BREAKS` list)
   using UM's academic schedule for the new year.

Term codes: `YYYY90` = Fall of YYYY, `(YYYY+1)10` = Winter. The script reads the year and term from the file names.

## Files

- `build_courses.py` reads the .xlsx files and writes `static/courses.json`. This is the only script you need.
- `buildCalendarData.py` is the older two-step converter (it turned the `allCourses` JSON from the old
  `dataClean.py` into `static/courses.json`). `build_courses.py` replaces it, so it can be deleted.
- `202690-class-schedule-public.xlsx`, `202710-class-schedule-public.xlsx` are the current source spreadsheets
  (Fall 2026 and Winter 2027).
- `courses.json` is a leftover copy of `static/courses.json`. The website only reads the one in `static/`,
  so this copy can be deleted.
