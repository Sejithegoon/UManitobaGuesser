/* static/calendarCore.js
   Pure logic for the Class Calendar page: date helpers, conflict detection and .ics building.
   No DOM in here, so it can be tested in Node. */
(function (root) {
    'use strict';

    const TZ = 'America/Winnipeg';
    const DAY_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const DAY_SHORT = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // UM 2026-27 dates with no classes (University closures + term breaks for most programs).
    // Source: UM Academic Schedule 2026-2027, "Dates Applicable to all UM Students" and "Term Breaks".
    // Update these every year. Some programs (Medicine, OT, Pharmacy, PT...) have different breaks.
    const BREAKS = [
        { from: '2026-09-30', to: '2026-09-30', label: 'Orange Shirt Day' },
        { from: '2026-10-12', to: '2026-10-12', label: 'Thanksgiving' },
        { from: '2026-11-09', to: '2026-11-13', label: 'Fall term break (incl. Remembrance Day)' },
        { from: '2026-12-24', to: '2027-01-04', label: 'Winter holiday' },
        { from: '2027-02-15', to: '2027-02-19', label: 'Winter term break (incl. Louis Riel Day)' },
        { from: '2027-03-26', to: '2027-03-26', label: 'Good Friday' }
    ];

    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

    function parseIso(iso) {
        const [y, m, d] = iso.split('-').map(Number);
        return { y, m, d };
    }
    function dowOfIso(iso) {
        const { y, m, d } = parseIso(iso);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    }
    function addDays(iso, n) {
        const { y, m, d } = parseIso(iso);
        const dt = new Date(Date.UTC(y, m - 1, d + n));
        return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }

    function breakDates() {
        const out = [];
        BREAKS.forEach(b => {
            for (let d = b.from; d <= b.to; d = addDays(d, 1)) out.push(d);
        });
        return out;
    }

    // Year of a (month, day) in a term. Fall rows: Jan-Jun belongs to the next calendar year.
    function yearFor(term, month, fallYear) {
        if (term === 'F') return month <= 6 ? fallYear + 1 : fallYear;
        return fallYear + 1;
    }

    const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

    // Turn a section's compact meetings into a normalized form (cached on the section)
    function normalize(sec, fallYear) {
        if (sec._mt) return sec._mt;
        sec._mt = (sec.m || []).map(mt => {
            const days = (mt.d || []).map(c => DAY_NUM[c]);
            const a = toMin(mt.a), b = toMin(mt.b);
            if (mt.r) {
                const s = isoOf(yearFor(sec.T, mt.r[0], fallYear), mt.r[0], mt.r[1]);
                const e = isoOf(yearFor(sec.T, mt.r[2], fallYear), mt.r[2], mt.r[3]);
                return { kind: 'w', s, e, days, a, b, raw: mt };
            }
            const dates = mt.x.map(([m, d]) => isoOf(yearFor(sec.T, m, fallYear), m, d));
            return { kind: 'x', dates, days, a, b, raw: mt };
        });
        return sec._mt;
    }

    function meetingsOverlap(p, q) {
        if (!(p.a < q.b && q.a < p.b)) return false;
        if (p.kind === 'w' && q.kind === 'w') {
            if (p.s > q.e || q.s > p.e) return false;
            return p.days.some(d => q.days.includes(d));
        }
        if (p.kind === 'x' && q.kind === 'x') {
            return p.dates.some(d => q.dates.includes(d));
        }
        const w = p.kind === 'w' ? p : q;
        const x = p.kind === 'w' ? q : p;
        return x.dates.some(d => d >= w.s && d <= w.e && w.days.includes(dowOfIso(d)));
    }

    function sectionsConflict(a, b, fallYear) {
        const A = normalize(a, fallYear), B = normalize(b, fallYear);
        return A.some(p => B.some(q => meetingsOverlap(p, q)));
    }

    function overlapsWindow(mt, w0, w1) {
        if (mt.kind === 'w') return mt.s <= w1 && mt.e >= w0;
        return mt.dates.some(d => d >= w0 && d <= w1);
    }

    // ---------- Formatting ----------
    function fmtTime12(hhmm) {
        let [h, m] = hhmm.split(':').map(Number);
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return m ? `${h}:${pad(m)} ${ap}` : `${h}:00 ${ap}`;
    }
    function fmtRange(a, b) {
        const A = fmtTime12(a), B = fmtTime12(b);
        const apA = A.slice(-2), apB = B.slice(-2);
        return apA === apB ? `${A.slice(0, -3)}\u2013${B}` : `${A}\u2013${B}`;
    }
    function fmtMD(iso) {
        const { m, d } = parseIso(iso);
        return `${MONTHS[m - 1]} ${d}`;
    }
    function fmtDays(codes) {
        return codes.map(c => DAY_SHORT[c]).join(' ');
    }

    // ---------- ICS ----------
    function nthSunday(year, monthIdx, n) {
        const first = (7 - new Date(Date.UTC(year, monthIdx, 1)).getUTCDay()) % 7;
        return 1 + first + (n - 1) * 7;
    }
    function isDST(iso) {
        const { y, m, d } = parseIso(iso);
        const key = m * 100 + d;
        return key >= 300 + nthSunday(y, 2, 2) && key < 1100 + nthSunday(y, 10, 1);
    }
    function icsLocal(iso, mins) {
        return iso.replace(/-/g, '') + 'T' + pad(Math.floor(mins / 60)) + pad(mins % 60) + '00';
    }
    function icsUtc(ms) {
        const d = new Date(ms);
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    }
    function untilUtc(iso) {
        const { y, m, d } = parseIso(iso);
        const off = isDST(iso) ? 5 : 6;           // Winnipeg is UTC-5 (CDT) or UTC-6 (CST)
        return icsUtc(Date.UTC(y, m - 1, d, 23 + off, 59, 59));
    }
    function esc(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    }
    // Fold lines at 75 octets (counting UTF-8 bytes)
    function fold(line) {
        const enc = new TextEncoder();
        const out = [];
        let cur = '', bytes = 0;
        for (const ch of line) {
            const b = enc.encode(ch).length;
            if (bytes + b > 74) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; }
            else { cur += ch; bytes += b; }
        }
        out.push(cur);
        return out.join('\r\n');
    }

    const VTIMEZONE = [
        'BEGIN:VTIMEZONE',
        `TZID:${TZ}`,
        'BEGIN:DAYLIGHT',
        'TZOFFSETFROM:-0600',
        'TZOFFSETTO:-0500',
        'TZNAME:CDT',
        'DTSTART:19700308T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
        'END:DAYLIGHT',
        'BEGIN:STANDARD',
        'TZOFFSETFROM:-0500',
        'TZOFFSETTO:-0600',
        'TZNAME:CST',
        'DTSTART:19701101T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
        'END:STANDARD',
        'END:VTIMEZONE'
    ];

    function triggerFor(min) {
        return min % 60 === 0 ? `-PT${min / 60}H` : `-PT${min}M`;
    }

    // sections: selected section objects. opts: { fallYear, reminder (minutes), skipBreaks, now (Date) }
    function buildICS(sections, opts) {
        const { fallYear, reminder = 0, skipBreaks = true } = opts;
        const stamp = icsUtc((opts.now || new Date()).getTime());
        const skipList = skipBreaks ? breakDates() : [];
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//UManitoba Guesser//Class Calendar//EN',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            'X-WR-CALNAME:UManitoba Classes',
            `X-WR-TIMEZONE:${TZ}`,
            ...VTIMEZONE
        ];
        const skipped = [];
        let events = 0;

        function pushEvent(sec, uid, startIso, a, b, extra) {
            const desc = [
                sec.t,
                `Section ${sec.s} \u00B7 CRN ${sec.n}`,
                sec.i ? `Instructor: ${sec.i}` : null,
                sec.cr ? `Credit hours: ${sec.cr}` : null,
                "Room isn't included in UM's public schedule. Check Aurora.",
                'Made with umanitobaguesser.ca/calendar.html'
            ].filter(Boolean).join('\n');
            lines.push(
                'BEGIN:VEVENT',
                `UID:${uid}@umanitobaguesser.ca`,
                `DTSTAMP:${stamp}`,
                `DTSTART;TZID=${TZ}:${icsLocal(startIso, a)}`,
                `DTEND;TZID=${TZ}:${icsLocal(startIso, b)}`,
                ...extra,
                `SUMMARY:${esc(`${sec.c} ${sec.s}`)}`,
                `DESCRIPTION:${esc(desc)}`,
                'CATEGORIES:UManitoba Classes',
                'TRANSP:OPAQUE'
            );
            if (reminder > 0) {
                lines.push(
                    'BEGIN:VALARM',
                    'ACTION:DISPLAY',
                    `DESCRIPTION:${esc(`${sec.c} ${sec.s} starts soon`)}`,
                    `TRIGGER:${triggerFor(reminder)}`,
                    'END:VALARM'
                );
            }
            lines.push('END:VEVENT');
            events++;
        }

        sections.forEach(sec => {
            const mts = normalize(sec, fallYear);
            if (!mts.length) { skipped.push(sec); return; }
            mts.forEach((mt, idx) => {
                if (mt.kind === 'w') {
                    // first date on/after the start that falls on one of the meeting days
                    let first = mt.s, guard = 0;
                    while (!mt.days.includes(dowOfIso(first)) && guard++ < 7) first = addDays(first, 1);
                    if (first > mt.e) return;
                    const ex = skipList
                        .filter(d => d >= first && d <= mt.e && mt.days.includes(dowOfIso(d)))
                        .map(d => icsLocal(d, mt.a));
                    const extra = [
                        `RRULE:FREQ=WEEKLY;BYDAY=${mt.days.map(n => DAY_CODES[n]).join(',')};UNTIL=${untilUtc(mt.e)}`
                    ];
                    if (ex.length) extra.push(`EXDATE;TZID=${TZ}:${ex.join(',')}`);
                    pushEvent(sec, `${sec.n}-${idx}`, first, mt.a, mt.b, extra);
                } else {
                    mt.dates.forEach(iso => {
                        pushEvent(sec, `${sec.n}-${idx}-${iso.replace(/-/g, '')}`, iso, mt.a, mt.b, []);
                    });
                }
            });
        });

        lines.push('END:VCALENDAR');
        return { text: lines.map(fold).join('\r\n') + '\r\n', events, skipped };
    }

    const api = {
        TZ, DAY_NUM, DAY_CODES, DAY_SHORT, BREAKS,
        pad, isoOf, parseIso, dowOfIso, addDays, breakDates, yearFor, toMin,
        normalize, meetingsOverlap, sectionsConflict, overlapsWindow,
        fmtTime12, fmtRange, fmtMD, fmtDays, isDST, buildICS
    };
    root.CalCore = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
