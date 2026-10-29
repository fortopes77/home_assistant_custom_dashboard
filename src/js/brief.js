// The day-ahead summary on Home: facts gathered from Home Assistant, written up by an AI agent that is
// set up in Home Assistant (AI Task or a conversation agent), or by a simple template when there is none.

import { domainOf, nameOf } from './entities.js';
import { calOnDay, calAddDays, calStartOfDay, calTimeLabel } from './calendar.js';

const WEATHER_WORDS = {
  'clear-night': 'clear', cloudy: 'cloudy', exceptional: 'unusual weather', fog: 'foggy', hail: 'hail',
  lightning: 'lightning', 'lightning-rainy': 'storms', partlycloudy: 'partly cloudy', pouring: 'heavy rain',
  rainy: 'rain', snowy: 'snow', 'snowy-rainy': 'sleet', sunny: 'sunny', windy: 'windy', 'windy-variant': 'windy',
};
export const weatherWord = (c) => WEATHER_WORDS[c] || (c ? c.replace(/[-_]/g, ' ') : '');

export function dayPart(now = new Date()) {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

export function greetingFor(now = new Date()) {
  return { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Good night' }[dayPart(now)];
}

/** AI Task entities first (made for this), then conversation agents other than the built-in one. */
export function briefAgents(states) {
  const all = [...states.values()];
  const pick = (d) => all.filter((s) => domainOf(s.entity_id) === d && s.state !== 'unavailable')
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return [
    ...pick('ai_task').map((s) => ({ id: s.entity_id, name: nameOf(s), kind: 'ai_task' })),
    ...pick('conversation').filter((s) => s.entity_id !== 'conversation.home_assistant')
      .map((s) => ({ id: s.entity_id, name: nameOf(s), kind: 'conversation' })),
  ];
}

const fmtT = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * What the summary is about. `key` changes only when something worth a new summary changes
 * (not every minute or every tenth of a degree).
 */
export function briefFacts({ now = new Date(), place = '', weather = null, unit = '°', forecast = null, events = [], calNames = {}, people = [] }) {
  const part = dayPart(now);
  const today = calStartOfDay(now);
  const evLine = (ev, day) => `${calTimeLabel(ev, day)}: ${ev.title}${ev.location ? ` (${ev.location})` : ''}${calNames[ev.cal] ? ` [${calNames[ev.cal]}]` : ''}`;
  const todays = calOnDay(events, today).filter((ev) => ev.allDay || ev.end > now);
  const tomorrow = calAddDays(today, 1);
  const tomorrows = calOnDay(events, tomorrow);
  const w = weather && weather.state !== 'unavailable' ? weather : null;
  const facts = {
    part,
    date: now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    time: fmtT(now),
    place,
    weatherNow: w ? `${weatherWord(w.state)}${w.attributes?.temperature != null ? `, ${w.attributes.temperature}${unit}` : ''}` : '',
    forecast: forecast ? [
      weatherWord(forecast.condition),
      forecast.temperature != null ? `high ${Math.round(forecast.temperature)}${unit}` : '',
      forecast.templow != null ? `low ${Math.round(forecast.templow)}${unit}` : '',
      forecast.precipitation_probability != null ? `${forecast.precipitation_probability}% chance of rain` : '',
    ].filter(Boolean).join(', ') : '',
    today: todays.map((ev) => evLine(ev, today)),
    tomorrow: tomorrows.map((ev) => evLine(ev, tomorrow)),
    people: people.map((p) => `${p.name}: ${p.place}`),
    // for the template
    _today: todays,
    _tomorrow: tomorrows,
    _temp: w?.attributes?.temperature,
    _unit: unit,
  };
  facts.key = JSON.stringify([today.toDateString(), part, facts.today, facts.tomorrow,
    w?.state || '', forecast?.condition || '', forecast?.temperature != null ? Math.round(forecast.temperature) : '',
    people.map((p) => p.place === 'Home')]);
  return facts;
}

export function briefPrompt(f) {
  const later = f.part === 'evening' || f.part === 'night';
  return [
    `Write a short day-ahead summary for a family's home dashboard${f.place ? ` (${f.place})` : ''}.`,
    `It is ${f.date}, ${f.time} (${f.part}).`,
    'Write 2 or 3 short, warm, practical sentences, at most 60 words, in plain text: no greeting (the dashboard already says hello), no lists, no emoji, no markdown.',
    later
      ? 'It is late in the day, so mention anything still on tonight and focus on what tomorrow brings.'
      : 'Focus on what is coming up today; mention tomorrow only if something early needs preparing tonight.',
    'Mention the weather and anything to bring or wear because of it. Only use the facts below and do not invent anything. Do not control any devices.',
    '',
    `Weather now: ${f.weatherNow || 'unknown'}`,
    `Forecast today: ${f.forecast || 'unknown'}`,
    `Still on today: ${f.today.length ? f.today.join('; ') : 'nothing on the calendar'}`,
    `Tomorrow: ${f.tomorrow.length ? f.tomorrow.join('; ') : 'nothing on the calendar'}`,
    f.people.length ? `Where everyone is: ${f.people.join('; ')}` : '',
  ].filter((l) => l !== null).join('\n');
}

const listEvents = (evs, day) => {
  const items = evs.slice(0, 3).map((ev) => `${ev.title}${ev.allDay ? '' : ` at ${fmtT(ev.start < day ? day : ev.start)}`}`);
  const more = evs.length > 3 ? ` and ${evs.length - 3} more` : '';
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')}${more ? `, ${items.at(-1)}${more}` : ` and ${items.at(-1)}`}`;
};

/** The summary without AI, from the same facts. */
export function briefLocal(f, now = new Date()) {
  const out = [];
  if (f.weatherNow || f.forecast) {
    const t = f._temp != null ? `${f._temp}${f._unit}` : '';
    const now0 = f.weatherNow ? `${f.weatherNow.split(',')[0].replace(/^\w/, (c) => c.toUpperCase())}${t ? `, ${t} now` : ''}` : '';
    out.push(`${[now0, f.forecast && !f.weatherNow ? f.forecast.replace(/^\w/, (c) => c.toUpperCase()) : f.forecast].filter(Boolean).join('. Today: ')}.`);
  }
  const today = calStartOfDay(now);
  const later = f.part === 'evening' || f.part === 'night';
  if (f._today.length) out.push(`${later ? 'Still on tonight' : 'On today'}: ${listEvents(f._today, today)}.`);
  else if (!later) out.push('Nothing on the calendar today.');
  if (f._tomorrow.length && (later || !f._today.length)) out.push(`Tomorrow: ${listEvents(f._tomorrow, calAddDays(today, 1))}.`);
  else if (later) out.push('Nothing on the calendar tomorrow.');
  return out.join(' ');
}
