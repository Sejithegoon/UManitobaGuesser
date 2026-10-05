/* static/calendar.js
   UI for the Class Calendar page: search, add/remove sections, week preview and .ics download.
   The date/conflict/.ics logic lives in calendarCore.js (window.CalCore). */
(function () {
    'use strict';

    const C = window.CalCore;
    const DATA_URL = './static/courses.json';
    const STORE_KEY = 'calSelected';
    const OPTS_KEY = 'calOpts';
    const PAGE = 4;                        // courses shown per "page" of results
    const SEC_PREVIEW = 4;                 // sections shown per course before "Show all"
    const COLORS = ['#0b6e4f', '#2a7ab0', '#b4540a', '#7b3fa0', '#c2185b', '#00838f', '#5d6d1e', '#a83232', '#3949ab', '#8d6e00'];
    const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0];  // Mon..Sun

    const $ = (id) => document.getElementById(id);
    const el = {
        q: $('q'), dep: $('dep'), termSeg: $('termSeg'), chips: $('chips'),
        resultCount: $('resultCount'), results: $('results'), showMore: $('showMore'),
        countBadge: $('countBadge'), emptyState: $('emptyState'), selList: $('selList'), notices: $('notices'),
        weekWrap: $('weekWrap'), termTabs: $('termTabs'), week: $('week'),
        opts: $('opts'), reminder: $('reminder'), skipBreaks: $('skipBreaks'), breakList: $('breakList'),
        actions: $('actions'), downloadBtn: $('downloadBtn'), summary: $('summary'), clearBtn: $('clearBtn'),
        mobileBar: $('mobileBar'), mobileBarText: $('mobileBarText'), toast: $('toast'), schedule: $('mySchedule')
    };

    let fallYear = 2026;
    let sections = [];            // all sections from courses.json
    let byCrn = new Map();
    let courses = [];             // [{ code, title, cr, dep, secs: [...], hay }]
    let selected = [];            // CRNs in the order they were added
    let term = 'all';             // search filter
    let previewTerm = null;       // week preview tab
    let matches = [];
    let shown = PAGE;
    let expanded = new Set();     // course codes showing every section

    // ---------- helpers ----------
    const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const termName = (T) => T === 'F' ? `Fall ${fallYear}` : `Winter ${fallYear + 1}`;
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

    function load(key, fallback) {
        try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
    }
    function save(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode etc. */ }
    }

    let toastTimer;
    function toast(msg) {
        el.toast.textContent = msg;
        el.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
    }

    function colorOf(crn) {
        const i = selected.indexOf(crn);
        return COLORS[(i < 0 ? 0 : i) % COLORS.length];
    }

    function dateRange(sec) {
        const mts = C.normalize(sec, fallYear);
        let s = null, e = null;
        mts.forEach(mt => {
            const a = mt.kind === 'w' ? mt.s : mt.dates[0];
            const b = mt.kind === 'w' ? mt.e : mt.dates[mt.dates.length - 1];
            if (!s || a < s) s = a;
            if (!e || b > e) e = b;
        });
        (sec.o || []).forEach(r => {
            const a = C.isoOf(C.yearFor(sec.T, r[0], fallYear), r[0], r[1]);
            const b = C.isoOf(C.yearFor(sec.T, r[2], fallYear), r[2], r[3]);
            if (!s || a < s) s = a;
            if (!e || b > e) e = b;
        });
        return s ? `${C.fmtMD(s)} – ${C.fmtMD(e)}` : '';
    }

    // One line per meeting, e.g. "Mon Wed Fri 9:30–10:20 AM"
    function meetingLines(sec) {
        const out = (sec.m || []).map(mt => {
            const when = `${C.fmtDays(mt.d)} ${C.fmtRange(mt.a, mt.b)}`;
            return mt.x ? `${when} (${mt.x.length} dates only)` : when;
        });
        if (!out.length) out.push('No set meeting time');
        return out;
    }

    const hasTime = (sec) => (sec.m || []).length > 0;

    // ---------- data ----------
    function buildIndex() {
        const map = new Map();
        sections.forEach(sec => {
            byCrn.set(sec.n, sec);
            let c = map.get(sec.c);
            if (!c) {
                c = { code: sec.c, title: sec.t, cr: sec.cr, dep: sec.d, secs: [], words: new Set() };
                map.set(sec.c, c);
            }
            c.secs.push(sec);
            c.words.add(norm(sec.i));
            c.words.add(sec.n);
        });
        courses = [...map.values()];
        courses.forEach(c => {
            const code = norm(c.code);
            c.codeKey = code;
            c.codeTight = code.replace(/ /g, '');
            c.hay = [code, c.codeTight, norm(c.title), ...c.words].join(' | ');
            c.secs.sort((a, b) => (a.T === b.T ? 0 : a.T === 'F' ? -1 : 1) || a.s.localeCompare(b.s));
        });
        courses.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

        const deps = [...new Set(courses.map(c => c.dep))].sort();
        el.dep.insertAdjacentHTML('beforeend', deps.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join(''));
    }

    // ---------- search ----------
    function search() {
        const raw = norm(el.q.value);
        const tokens = raw ? raw.split(' ') : [];
        const tight = raw.replace(/ /g, '');
        const dep = el.dep.value;

        const scored = [];
        courses.forEach(c => {
            if (dep && c.dep !== dep) return;
            if (term !== 'all' && !c.secs.some(s => s.T === term)) return;
            if (tokens.length && !tokens.every(t => c.hay.includes(t)) && !c.hay.includes(tight)) return;
            let score = 3;
            if (tight) {
                if (c.codeTight === tight) score = 0;
                else if (c.codeTight.startsWith(tight)) score = 1;
                else if (norm(c.title).includes(raw)) score = 2;
            }
            scored.push({ c, score });
        });
        scored.sort((a, b) => a.score - b.score);   // stable: keeps alphabetical order within a score
        matches = scored.map(x => x.c);
        shown = PAGE;
        expanded = new Set();
        renderResults();
    }

    function sectionRow(sec, crnSet) {
        const on = selected.includes(sec.n);
        let clash = '';
        if (!on) {
            const hit = selected.map(n => byCrn.get(n)).find(o => o && C.sectionsConflict(sec, o, fallYear));
            if (hit) clash = `<div class="warn"><i class="fa-solid fa-triangle-exclamation"></i> Overlaps ${escHtml(hit.c)} ${escHtml(hit.s)}</div>`;
        }
        const highlight = crnSet && crnSet.has(sec.n) ? ' style="background:rgba(255,193,7,0.12)"' : '';
        return `
            <div class="sec"${highlight}>
                <div class="sec-info">
                    <div class="sec-top">
                        <strong class="sec-id">${escHtml(sec.s)}</strong>
                        <span class="term-badge ${sec.T}">${termName(sec.T)}</span>
                        <span class="crn">CRN ${escHtml(sec.n)}</span>
                    </div>
                    ${meetingLines(sec).map(l => `<div>${escHtml(l)}</div>`).join('')}
                    <div class="sec-ins">${escHtml(dateRange(sec))}${sec.i ? ` · ${escHtml(sec.i)}` : ''}</div>
                    ${clash}
                </div>
                <button type="button" class="add-btn${on ? ' on' : ''}" data-crn="${escHtml(sec.n)}" aria-pressed="${on}">
                    ${on ? '<i class="fa-solid fa-check"></i> Added' : '<i class="fa-solid fa-plus"></i> Add'}
                </button>
            </div>`;
    }

    function renderResults() {
        const raw = norm(el.q.value);
        // If the user typed a CRN, highlight that section
        const crnSet = /^\d{5}$/.test(raw) ? new Set([raw]) : null;

        if (!matches.length) {
            el.resultCount.textContent = '';
            el.results.innerHTML = `<p class="muted">No classes match "${escHtml(el.q.value)}". Try a course code like <strong>COMP 1010</strong>, a title word, an instructor or a 5-digit CRN.</p>`;
            el.showMore.hidden = true;
            return;
        }
        const total = matches.length;
        el.resultCount.textContent = `${total.toLocaleString()} course${total === 1 ? '' : 's'} found` +
            (total > shown ? ` · showing ${shown}` : '');

        el.results.innerHTML = matches.slice(0, shown).map(c => {
            const all = c.secs.filter(s => (term === 'all' || s.T === term) && (!crnSet || crnSet.has(s.n)));
            const open = expanded.has(c.code) || all.length <= SEC_PREVIEW + 1;
            // Collapsed: first few sections, plus any you've already added so they stay visible
            const secs = open ? all : all.filter((s, i) => i < SEC_PREVIEW || selected.includes(s.n));
            const hidden = all.length - secs.length;
            const toggleBtn = all.length > SEC_PREVIEW + 1
                ? `<button type="button" class="sec-more" data-code="${escHtml(c.code)}">${open
                    ? '<i class="fa-solid fa-chevron-up"></i> Show fewer sections'
                    : `<i class="fa-solid fa-chevron-down"></i> Show ${hidden} more section${hidden === 1 ? '' : 's'}`}</button>`
                : '';
            return `
                <article class="course">
                    <div class="course-head">
                        <span class="course-code">${escHtml(c.code)}</span>
                        <span class="course-title">${escHtml(c.title)}</span>
                        ${c.cr && c.cr !== '0' ? `<span class="course-cr">${escHtml(c.cr)} credit hours</span>` : ''}
                    </div>
                    ${secs.map(s => sectionRow(s, crnSet)).join('')}
                    ${toggleBtn}
                </article>`;
        }).join('');
        el.showMore.hidden = total <= shown;
    }

    // ---------- selection ----------
    function toggle(crn) {
        const sec = byCrn.get(crn);
        if (!sec) return;
        const i = selected.indexOf(crn);
        if (i >= 0) {
            selected.splice(i, 1);
            toast(`Removed ${sec.c} ${sec.s}`);
        } else {
            const hit = selected.map(n => byCrn.get(n)).find(o => o && C.sectionsConflict(sec, o, fallYear));
            selected.push(crn);
            previewTerm = sec.T;
            toast(hit ? `Added ${sec.c} ${sec.s} — it overlaps ${hit.c} ${hit.s}` : `Added ${sec.c} ${sec.s}`);
        }
        save(STORE_KEY, selected);
        renderResults();
        renderSchedule();
    }

    function conflictsOf(sec, list) {
        return list.filter(o => o !== sec && C.sectionsConflict(sec, o, fallYear));
    }

    function renderSchedule() {
        const list = selected.map(n => byCrn.get(n)).filter(Boolean);
        const n = list.length;
        el.countBadge.textContent = n;
        el.emptyState.hidden = n > 0;
        el.weekWrap.hidden = n === 0;
        el.opts.hidden = n === 0;
        el.actions.hidden = n === 0;
        el.mobileBar.hidden = n === 0;
        el.mobileBarText.textContent = `My schedule (${n})`;

        // Selected list, grouped by term
        let html = '';
        ['F', 'W'].forEach(T => {
            const secs = list.filter(s => s.T === T);
            if (!secs.length) return;
            html += `<h3 class="term-head">${termName(T)}</h3>`;
            html += secs.map(sec => {
                const clashes = conflictsOf(sec, list);
                return `
                    <div class="sel">
                        <span class="swatch" style="background:${colorOf(sec.n)}"></span>
                        <div class="sel-body">
                            <strong>${escHtml(sec.c)} ${escHtml(sec.s)}</strong> · ${escHtml(sec.t)}
                            <div class="sel-meta">${meetingLines(sec).map(escHtml).join('<br>')}</div>
                            <div class="sel-meta">CRN ${escHtml(sec.n)}${sec.i ? ` · ${escHtml(sec.i)}` : ''}</div>
                            ${clashes.length ? `<div class="warn"><i class="fa-solid fa-triangle-exclamation"></i> Overlaps ${clashes.map(o => escHtml(`${o.c} ${o.s}`)).join(', ')}</div>` : ''}
                        </div>
                        <button type="button" class="rm" data-crn="${escHtml(sec.n)}" aria-label="Remove ${escHtml(sec.c)} ${escHtml(sec.s)}">&times;</button>
                    </div>`;
            }).join('');
        });
        el.selList.innerHTML = html;

        // Notices
        const notes = [];
        const untimed = list.filter(s => !hasTime(s));
        if (untimed.length) {
            notes.push(`<div class="notice"><strong>${untimed.map(s => escHtml(`${s.c} ${s.s}`)).join(', ')}</strong> ${untimed.length === 1 ? 'has' : 'have'} no set meeting time, so ${untimed.length === 1 ? 'it' : 'they'} won't appear in the calendar file.</div>`);
        }
        const clashCount = list.filter(s => conflictsOf(s, list).length).length;
        if (clashCount) {
            notes.push(`<div class="notice bad">Some of your classes overlap. They're outlined in red in the week preview.</div>`);
        }
        el.notices.innerHTML = notes.join('');

        renderWeek(list);
        renderSummary(list);
    }

    // ---------- week preview ----------
    function renderWeek(list) {
        const terms = ['F', 'W'].filter(T => list.some(s => s.T === T));
        if (!terms.length) { el.week.innerHTML = ''; el.termTabs.innerHTML = ''; return; }
        if (!terms.includes(previewTerm)) previewTerm = terms[0];

        el.termTabs.innerHTML = terms.map(T =>
            `<button type="button" data-tab="${T}" class="${T === previewTerm ? 'on' : ''}">${termName(T)}</button>`).join('');

        // Collect every timed meeting in this term
        const blocks = [];
        list.filter(s => s.T === previewTerm).forEach(sec => {
            C.normalize(sec, fallYear).forEach(mt => {
                mt.days.forEach(day => blocks.push({ sec, mt, day, a: mt.a, b: mt.b }));
            });
        });

        if (!blocks.length) {
            el.week.className = 'week empty';
            el.week.removeAttribute('style');
            el.week.innerHTML = `<p class="muted">No classes with set times in ${termName(previewTerm)}.</p>`;
            return;
        }

        // Which days and hours to show
        const days = WEEK_DAYS.filter(d => d >= 1 && d <= 5 || blocks.some(b => b.day === d));
        let h0 = Math.min(8, ...blocks.map(b => Math.floor(b.a / 60)));
        let h1 = Math.max(17, ...blocks.map(b => Math.ceil(b.b / 60)));
        const hours = h1 - h0;

        // Mark clashes (same day, overlapping time, and actually overlapping dates)
        blocks.forEach(x => {
            x.clash = blocks.some(y => y !== x && y.sec !== x.sec && y.day === x.day && x.a < y.b && y.a < x.b && C.meetingsOverlap(x.mt, y.mt));
        });

        el.week.className = 'week';
        el.week.style.setProperty('--cols', days.length);
        el.week.style.setProperty('--hours', hours);

        const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        let html = '<div class="w-corner"></div>' + days.map(d => `<div class="w-dayhead">${dayName[d]}</div>`).join('');

        let times = '';
        for (let h = h0; h < h1; h++) {
            const label = h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`;
            times += `<span style="top:calc(${h - h0} * var(--hour))">${label}</span>`;
        }
        html += `<div class="w-times">${times}</div>`;

        days.forEach(d => {
            const evs = blocks.filter(b => b.day === d).sort((p, q) => p.a - q.a || q.b - p.b);
            // Side-by-side lanes for blocks that overlap in time
            let cluster = [], clusterEnd = -1;
            const flush = () => {
                const lanes = [];
                cluster.forEach(ev => {
                    let li = lanes.findIndex(end => end <= ev.a);
                    if (li < 0) { li = lanes.length; lanes.push(0); }
                    lanes[li] = ev.b;
                    ev.lane = li;
                });
                cluster.forEach(ev => { ev.lanes = lanes.length; });
                cluster = [];
            };
            evs.forEach(ev => {
                if (ev.a >= clusterEnd) flush();
                cluster.push(ev);
                clusterEnd = Math.max(clusterEnd, ev.b);
            });
            flush();

            html += `<div class="w-col">${evs.map(ev => {
                const top = (ev.a - h0 * 60) / 60, len = (ev.b - ev.a) / 60;
                const w = 100 / ev.lanes;
                const cls = ['blk', ev.mt.kind === 'x' ? 'sporadic' : '', ev.clash ? 'clash' : ''].join(' ');
                const tip = `${ev.sec.c} ${ev.sec.s} · ${C.fmtRange(ev.mt.raw.a, ev.mt.raw.b)}` +
                    (ev.mt.kind === 'x' ? ` · only on ${ev.mt.dates.length} dates` : '');
                return `<div class="${cls}" title="${escHtml(tip)}" style="top:calc(${top} * var(--hour));height:calc(${len} * var(--hour) - 2px);left:calc(${ev.lane * w}% + 2px);width:calc(${w}% - 4px);background:${colorOf(ev.sec.n)}">
                    <b>${escHtml(ev.sec.c)}</b><span>${escHtml(ev.sec.s)} · ${C.fmtRange(ev.mt.raw.a, ev.mt.raw.b)}</span></div>`;
            }).join('')}</div>`;
        });

        el.week.innerHTML = html;
    }

    // ---------- download ----------
    function icsOpts() {
        return { fallYear, reminder: Number(el.reminder.value) || 0, skipBreaks: el.skipBreaks.checked };
    }

    function renderSummary(list) {
        if (!list.length) { el.summary.textContent = ''; return; }
        const { events, skipped } = C.buildICS(list, icsOpts());
        const timed = list.length - skipped.length;
        el.downloadBtn.disabled = events === 0;
        el.summary.textContent = events
            ? `${timed} class${timed === 1 ? '' : 'es'} · ${events} calendar event${events === 1 ? '' : 's'} (weekly classes repeat automatically)`
            : 'None of your classes have set meeting times, so there is nothing to add yet.';
    }

    function download() {
        const list = selected.map(n => byCrn.get(n)).filter(Boolean);
        const { text, events } = C.buildICS(list, icsOpts());
        if (!events) { toast('Nothing to download yet'); return; }
        const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'umanitoba-classes.ics';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Calendar file downloaded. See step 3 to add it.');
    }

    // ---------- events ----------
    function wire() {
        let t;
        el.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 120); });
        el.dep.addEventListener('change', search);

        el.termSeg.addEventListener('click', e => {
            const b = e.target.closest('button[data-term]');
            if (!b) return;
            term = b.dataset.term;
            el.termSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
            search();
        });

        el.chips.addEventListener('click', e => {
            const b = e.target.closest('button[data-q]');
            if (!b) return;
            el.q.value = b.dataset.q;
            search();
            el.q.focus();
        });

        el.results.addEventListener('click', e => {
            const b = e.target.closest('.add-btn');
            if (b) { toggle(b.dataset.crn); return; }
            const more = e.target.closest('.sec-more');
            if (more) {
                const code = more.dataset.code;
                if (expanded.has(code)) expanded.delete(code); else expanded.add(code);
                renderResults();
                if (!expanded.has(code)) {
                    const card = [...el.results.querySelectorAll('.sec-more')].find(x => x.dataset.code === code);
                    if (card) card.closest('.course').scrollIntoView({ block: 'nearest' });
                }
            }
        });
        el.showMore.addEventListener('click', () => { shown += PAGE; renderResults(); });

        el.selList.addEventListener('click', e => {
            const b = e.target.closest('.rm');
            if (b) toggle(b.dataset.crn);
        });

        el.termTabs.addEventListener('click', e => {
            const b = e.target.closest('button[data-tab]');
            if (!b) return;
            previewTerm = b.dataset.tab;
            renderWeek(selected.map(n => byCrn.get(n)).filter(Boolean));
        });

        const saveOpts = () => {
            save(OPTS_KEY, { reminder: el.reminder.value, skipBreaks: el.skipBreaks.checked });
            renderSummary(selected.map(n => byCrn.get(n)).filter(Boolean));
        };
        el.reminder.addEventListener('change', saveOpts);
        el.skipBreaks.addEventListener('change', saveOpts);

        el.downloadBtn.addEventListener('click', download);
        el.clearBtn.addEventListener('click', () => {
            if (!selected.length || !confirm('Remove all classes from your schedule?')) return;
            selected = [];
            save(STORE_KEY, selected);
            renderResults();
            renderSchedule();
        });

        el.mobileBar.addEventListener('click', () => el.schedule.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(([en]) => el.mobileBar.classList.toggle('gone', en.isIntersecting))
                .observe(el.schedule);
        }
    }

    // ---------- start ----------
    async function init() {
        el.breakList.textContent = C.BREAKS.map(b => `${b.label} (${b.from === b.to ? C.fmtMD(b.from) : `${C.fmtMD(b.from)}–${C.fmtMD(b.to)}`})`).join(', ');
        const o = load(OPTS_KEY, {});
        if (o.reminder != null) el.reminder.value = o.reminder;
        if (o.skipBreaks != null) el.skipBreaks.checked = !!o.skipBreaks;
        wire();

        try {
            const res = await fetch(DATA_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            fallYear = (data.meta && data.meta.fallYear) || fallYear;
            sections = data.sections || [];
        } catch (err) {
            console.error('Could not load courses:', err);
            const local = location.protocol === 'file:';
            el.results.innerHTML = `<p class="muted">Couldn't load the class list.` +
                (local ? ` Browsers block this when the page is opened straight from a file. Run <code>python -m http.server</code> in the project folder and open <strong>http://localhost:8000/calendar.html</strong>.` : ' Please refresh the page to try again.') + `</p>`;
            return;
        }

        el.termSeg.querySelector('[data-term="F"]').textContent = termName('F');
        el.termSeg.querySelector('[data-term="W"]').textContent = termName('W');

        buildIndex();
        selected = load(STORE_KEY, []).filter(n => byCrn.has(n));
        search();
        renderSchedule();
    }

    init();
})();
