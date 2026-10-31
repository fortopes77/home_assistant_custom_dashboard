// Family calendar for Home: events from Home Assistant calendar.* entities, as an upcoming list or a month grid.

import { esc } from './controls.js';
import { icon } from './icons.js';
import { domainOf, nameOf } from './entities.js';

export const CAL_COLORS = ['#2f6fde', '#e0598b', '#1f9d55', '#e09a1f', '#7c5cd6', '#1a8fb0', '#d4513b', '#6b7a8f'];
const CAL_DAY_MS = 86_400_000;

export function calendarsOf(states) {
  return [...states.values()]
    .filter((s) => domainOf(s.entity_id) === 'calendar')
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

export const calStartOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const calAddDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const calDayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const calFromKey = (k) => new Date(`${k}T00:00:00`);

/**
 * One event from calendar.get_events ({start: '2026-10-01' | ISO date-time}) or the REST API
 * ({start: {date} | {dateTime}}), as { cal, title, start, end, allDay, location, description }.
 */
export function calParse(raw, cal) {
  const s = raw.start?.dateTime || raw.start?.date || raw.start;
  const e = raw.end?.dateTime || raw.end?.date || raw.end || s;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const parse = (v) => (allDay ? new Date(`${v}T00:00:00`) : new Date(v));
  const start = parse(s);
  let end = parse(e);
  if (allDay && end <= start) end = calAddDays(start, 1);
  if (end < start) end = start;
  return {
    cal,
    title: (raw.summary || raw.message || 'Event').trim(),
    start,
    end,
    allDay,
    location: raw.location || '',
    // Google Calendar descriptions can carry HTML; show them as plain text.
    description: (raw.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
    // Only the REST API sends these; without a uid the event can't be changed.
    uid: raw.uid || '',
    recurrenceId: raw.recurrence_id || '',
    rrule: raw.rrule || '',
  };
}

// ---------- who it's for, and changing events ----------

export const CAL_CREATE = 1;
export const CAL_DELETE = 2;
export const CAL_UPDATE = 4;
export const calCan = (s, f) => !!((s?.attributes?.supported_features || 0) & f);

/** A key that finds the same event again after a reload. */
export const calEvKey = (ev) => [ev.cal, ev.uid || ev.title, ev.recurrenceId || +ev.start].join('|');

// "Who: Azelia & Andrew" on its own line in the description, for calendars shared by everyone.
const WHO_LINE = /^\s*who\s*:\s*(.+?)\s*$/im;
export function calWhoTag(description) {
  const m = (description || '').match(WHO_LINE);
  return m ? m[1].split(/\s*(?:,|&|\+|\band\b)\s*/i).filter(Boolean) : [];
}
export const calNotes = (description) => (description || '').replace(WHO_LINE, '').trim();

export const CAL_REPEATS = [
  ['', "Doesn't repeat"],
  ['FREQ=DAILY', 'Every day'],
  ['FREQ=WEEKLY', 'Every week'],
  ['FREQ=WEEKLY;INTERVAL=2', 'Every 2 weeks'],
  ['FREQ=MONTHLY', 'Every month'],
  ['FREQ=YEARLY', 'Every year'],
];

const pad = (n) => String(n).padStart(2, '0');
export const calTimeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Local time with its UTC offset, which is how Home Assistant wants dtstart and dtend. */
export function calIsoLocal(d) {
  const o = -d.getTimezoneOffset();
  return `${calDayKey(d)}T${calTimeValue(d)}:00${o >= 0 ? '+' : '-'}${pad(Math.trunc(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}

/**
 * The event to send from the editor's fields: { summary, dtstart, dtend, location?, description?, rrule? }.
 * All-day events end the day after their last day, as iCalendar does. Returns { error } when it can't be saved.
 */
export function calEventFromForm({ title, allDay, date, endDate, start, end, location, notes, whoLine, rrule }) {
  const summary = (title || '').trim();
  if (!summary) return { error: 'Give it a name' };
  if (!date) return { error: 'Pick a day' };
  const last = endDate && endDate > date ? endDate : date;
  const event = { summary };
  if (allDay) {
    event.dtstart = date;
    event.dtend = calDayKey(calAddDays(calFromKey(last), 1));
  } else {
    const from = new Date(`${date}T${start || '09:00'}:00`);
    let to = new Date(`${last}T${end || start || '10:00'}:00`);
    if (to <= from) to = new Date(+from + 3_600_000);
    event.dtstart = calIsoLocal(from);
    event.dtend = calIsoLocal(to);
  }
  if ((location || '').trim()) event.location = location.trim();
  const description = [(notes || '').trim(), whoLine].filter(Boolean).join('\n\n');
  if (description) event.description = description;
  if (rrule) event.rrule = rrule;
  return { event };
}

export function calSort(a, b) {
  return (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title);
}

/** Events on one local day (multi-day events show on every day they cover). */
export function calOnDay(events, day) {
  const from = calStartOfDay(day);
  const to = calAddDays(from, 1);
  return events
    .filter((ev) => ev.start < to && (ev.end > from || (+ev.end === +ev.start && ev.start >= from)))
    .sort(calSort);
}

const timeFmt = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function calTimeLabel(ev, day) {
  if (ev.allDay) return 'All day';
  const from = calStartOfDay(day);
  const to = calAddDays(from, 1);
  const startsToday = ev.start >= from;
  const endsToday = ev.end <= to;
  if (!startsToday && !endsToday) return 'All day';
  if (!startsToday) return `Until ${timeFmt(ev.end)}`;
  if (+ev.end === +ev.start) return timeFmt(ev.start);
  return endsToday ? `${timeFmt(ev.start)} – ${timeFmt(ev.end)}` : `From ${timeFmt(ev.start)}`;
}

// "9:00 AM – 10:00 AM" as the start with the end under it, so the time column stays narrow.
function calTimeHtml(label) {
  const [from, to] = label.split(' – ');
  return to ? `${esc(from)}<small>– ${esc(to)}</small>` : esc(label);
}

export function calDayLabel(day, today) {
  const diff = Math.round((calStartOfDay(day) - calStartOfDay(today)) / CAL_DAY_MS);
  const date = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  if (diff === 0) return `Today · ${date}`;
  if (diff === 1) return `Tomorrow · ${date}`;
  return date;
}

function calRow(ev, day, colors, now) {
  const done = !ev.allDay && ev.end <= now;
  return `<div class="cal-ev${done ? ' done' : ''}" style="--cal:${colors[ev.cal] || CAL_COLORS[0]}">
      <span class="cal-time">${calTimeHtml(calTimeLabel(ev, day))}</span>
      <span class="cal-title">${esc(ev.title)}${ev.location ? `<small>${esc(ev.location)}</small>` : ''}</span>
    </div>`;
}

/** The next `days` days, each day that has something on, with Today always shown. */
export function calAgendaHtml(events, { now = new Date(), days = 14, colors = {} } = {}) {
  const today = calStartOfDay(now);
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = calAddDays(today, i);
    const list = calOnDay(events, day);
    if (!list.length && i > 0) continue;
    out.push(`<button type="button" class="cal-day" data-cal-day="${calDayKey(day)}">
      <span class="cal-day-label">${esc(calDayLabel(day, now))}</span>
      ${list.length ? list.map((ev) => calRow(ev, day, colors, now)).join('') : '<span class="cal-none muted">Nothing on today</span>'}
    </button>`);
  }
  if (out.length === 1 && !calOnDay(events, today).length) {
    out.push(`<p class="muted cal-empty">Nothing in the next ${days} days.</p>`);
  }
  return `<div class="cal-agenda">${out.join('')}</div>`;
}

/** First day of the month grid: the Monday on or before the 1st. */
export function calGridStart(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  return calAddDays(first, -((first.getDay() + 6) % 7));
}

export function calMonthHtml(events, month, { now = new Date(), colors = {}, colorOf = (ev) => colors[ev.cal] } = {}) {
  const start = calGridStart(month);
  const todayKey = calDayKey(now);
  const names = [...Array(7)].map((_, i) => calAddDays(start, i).toLocaleDateString(undefined, { weekday: 'narrow' }));
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const first = calAddDays(start, w * 7);
    if (w >= 4 && first.getMonth() !== month.getMonth()) break;
    weeks.push([...Array(7)].map((_, i) => calAddDays(first, i)));
  }
  const cell = (day) => {
    const list = calOnDay(events, day);
    const other = day.getMonth() !== month.getMonth();
    const key = calDayKey(day);
    return `<button type="button" class="cal-cell${other ? ' other' : ''}${key === todayKey ? ' today' : ''}" data-cal-day="${key}"
        aria-label="${esc(day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}, ${list.length} ${list.length === 1 ? 'event' : 'events'}">
      <span class="cal-num">${day.getDate()}</span>
      ${list.slice(0, 3).map((ev) => `<span class="cal-chip" style="--cal:${colorOf(ev) || CAL_COLORS[0]}">${esc(ev.title)}</span>`).join('')}
      ${list.length > 3 ? `<span class="cal-more">+${list.length - 3}</span>` : ''}
    </button>`;
  };
  return `<div class="cal-month">
    <div class="cal-month-head">
      <button type="button" class="icon-btn" data-cal-month="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
      <button type="button" class="cal-month-name" data-cal-month="0">${esc(month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</button>
      <button type="button" class="icon-btn" data-cal-month="1" aria-label="Next month">${icon('chevronRight')}</button>
    </div>
    <div class="cal-grid">
      ${names.map((n) => `<span class="cal-wd">${esc(n)}</span>`).join('')}
      ${weeks.flat().map(cell).join('')}
    </div>
  </div>`;
}

/** Everything on one day, for the sheet. Events open with a tap; `who(ev)` gives { label, color } or null. */
export function calDaySheetHtml(events, day, {
  now = new Date(), colors = {}, calNames = {}, who = () => null, canAdd = false,
} = {}) {
  const list = calOnDay(events, day);
  return `
    <div class="sheet-head">
      <span class="tile-icon">${icon('calendar')}</span>
      <div>
        <h2 id="detail-title">${esc(calDayLabel(day, now))}</h2>
        <p class="muted">${list.length ? `${list.length} ${list.length === 1 ? 'event' : 'events'}` : 'Nothing on'}</p>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button>
    </div>
    <div class="sheet-body cal-sheet">
      ${list.map((ev) => {
        const w = who(ev);
        const notes = calNotes(ev.description);
        return `<button type="button" class="cal-ev big" data-cal-ev="${esc(calEvKey(ev))}" style="--cal:${w?.color || colors[ev.cal] || CAL_COLORS[0]}">
        <span class="cal-time">${calTimeHtml(calTimeLabel(ev, day))}</span>
        <span class="cal-title">${esc(ev.title)}${w ? ` <span class="who-pill">${esc(w.label)}</span>` : ''}
          <small>${esc([calNames[ev.cal], ev.location].filter(Boolean).join(' · '))}</small>
          ${notes ? `<span class="cal-desc">${esc(notes)}</span>` : ''}
        </span>
      </button>`;
      }).join('') || '<p class="muted">Nothing on this day.</p>'}
      ${canAdd ? `<button type="button" class="btn primary" data-cal-add="${calDayKey(day)}">${icon('plus')}Add an event</button>` : ''}
    </div>`;
}
