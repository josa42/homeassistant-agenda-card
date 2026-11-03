const CARD_VERSION = "0.0.0";

// Which build is loaded is the first question on any bug report, and a card has
// nowhere else to say so. The release workflow keeps this in step with the tag.
console.info(
  `%c AGENDA-CARD %c ${CARD_VERSION} `,
  "color:#fff;background:#03a9f4;font-weight:700",
  "color:#03a9f4;background:#fff;font-weight:700"
);

// Events are fetched again at this interval, which also re-dims the ones that
// have ended since.
const REFRESH_MS = 60 * 1000;

const TEXT = {
  empty: "Keine Einträge",
  until: "Bis",
  allDay: "Ganztägig",
  close: "Schließen",
};

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

// HA sends an all-day event as dates, its end the day after the last one. Both
// become local midnights, and the end the last moment of the last day.
function parseEvent(raw, entityId) {
  const allDay = Boolean(raw.start.date);
  const start = allDay ? new Date(`${raw.start.date}T00:00:00`) : new Date(raw.start.dateTime);
  const end = allDay
    ? new Date(new Date(`${raw.end.date}T00:00:00`).getTime() - 1)
    : new Date(raw.end.dateTime);
  return {
    entityId,
    title: raw.summary || "",
    description: raw.description || "",
    location: raw.location || "",
    start,
    end,
    allDay,
  };
}

// A description like "07:50 Deutsch 09:50 Mathe 10:40 Kunst" is a timetable:
// at least two entries, each a time and what follows it up to the next time.
// Anything else returns null and is shown as plain text.
const TIMETABLE_ENTRY = /^(\d{1,2}:\d{2})\s+(\S.*)$/s;

function parseTimetable(description) {
  const parts = description.trim().split(/\s+(?=\d{1,2}:\d{2}\s)/);
  if (parts.length < 2) return null;
  const entries = parts.map((p) => p.match(TIMETABLE_ENTRY));
  if (entries.some((m) => !m)) return null;
  return entries.map(([, time, text]) => ({ time, text: text.trim() }));
}

// The day view in the details dialog.
const HOUR_PX = 44;
const DAY_FIRST_HOUR = 7;
const DAY_LAST_HOUR = 20;
const CALENDAR_COLORS = [
  "var(--blue-color, #2196f3)",
  "var(--green-color, #4caf50)",
  "var(--orange-color, #ff9800)",
  "var(--purple-color, #926bc7)",
  "var(--teal-color, #009688)",
  "var(--pink-color, #e91e63)",
  "var(--amber-color, #ffc107)",
  "var(--indigo-color, #3f51b5)",
];

// Events that overlap, directly or through others, form a group and share
// its width: each takes the first column free at its start.
function layoutColumns(timed) {
  const sorted = [...timed].sort((a, b) => a.from - b.from || b.to - a.to);
  const placed = [];
  let group = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((p) => p.col + 1));
    for (const p of group) placed.push({ ...p, cols });
    group = [];
  };
  for (const t of sorted) {
    if (t.from >= groupEnd && group.length) flush();
    const ends = [];
    for (const p of group) ends[p.col] = Math.max(ends[p.col] ?? -1, p.t.to);
    let col = ends.findIndex((end) => end <= t.from);
    if (col === -1) col = ends.length;
    group.push({ t, col });
    groupEnd = Math.max(groupEnd, t.to);
  }
  if (group.length) flush();
  return placed;
}

function hideDuplicates(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.title}|${e.start.getTime()}|${e.end.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// All-day events first, then the rest by start. On today, the events that
// have ended move to the top, each group keeping its order.
function sortEvents(events, day, now) {
  const allDay = events
    .filter((e) => e.allDay)
    .sort((a, b) => b.title.localeCompare(a.title));
  const timed = events
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start - b.start);
  const sorted = [...allDay, ...timed];
  if (!sameDay(day, now)) return sorted;
  const finished = (e) => e.end < now;
  return [...sorted.filter(finished), ...sorted.filter((e) => !finished(e))];
}

class AgendaCard extends HTMLElement {
  static async getConfigElement() {
    await loadHaComponents();
    return document.createElement("agenda-card-editor");
  }

  static getStubConfig(hass) {
    const calendars = Object.keys(hass?.states || {}).filter((id) => id.startsWith("calendar."));
    return { type: "custom:agenda-card", entities: calendars.slice(0, 3) };
  }

  setConfig(config) {
    if (!Array.isArray(config.entities) || !config.entities.length) {
      throw new Error("entities: at least one calendar is needed");
    }
    this._config = {
      ...config,
      entities: config.entities.map((e) => (typeof e === "string" ? e : e.entity)),
      days_ahead: Number(config.days_ahead) || 0,
    };
    this._events = null;
    this._fetched = 0;
    this._fetch();
  }

  connectedCallback() {
    this._timer = setInterval(() => this._fetch(), REFRESH_MS);
    this._fetch();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._fetch();
  }

  _day() {
    return addDays(startOfDay(new Date()), this._config.days_ahead);
  }

  async _fetch() {
    if (!this._hass || !this._config || this._loading) return;
    this._loading = true;
    const day = this._day();
    const start = day.toISOString();
    const end = addDays(day, 1).toISOString();
    try {
      // One calendar failing leaves the others on the card.
      const lists = await Promise.all(
        this._config.entities.map((id) =>
          this._hass
            .callApi("GET", `calendars/${id}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
            .then((raw) => raw.map((r) => parseEvent(r, id)))
            .catch((err) => {
              console.warn(`agenda-card: ${id}`, err);
              return [];
            })
        )
      );
      let events = lists.flat().filter((e) => e.end >= day && e.start < addDays(day, 1));
      if (this._config.hide_duplicates) events = hideDuplicates(events);
      this._events = events;
      this._eventsDay = day;
    } finally {
      this._loading = false;
    }
    this._render();
  }

  _time(date) {
    const format = this._hass?.locale?.time_format;
    const hour12 = format === "12" ? true : format === "24" ? false : undefined;
    return date.toLocaleTimeString(this._locale(), { hour: "2-digit", minute: "2-digit", hour12 });
  }

  _date(date) {
    return date.toLocaleDateString(this._locale(), { day: "numeric", month: "long" });
  }

  _locale() {
    return this._hass?.locale?.language || this._hass?.language || "de";
  }

  // All-day events show no time. A timed event that runs past the day says
  // until when, on the day it ends.
  _hours(e, day) {
    if (e.allDay) return "";
    const next = addDays(day, 1);
    const startsBefore = e.start < day;
    const endsAfter = e.end >= next;
    const until = TEXT.until;
    if (startsBefore && endsAfter) return `${until} ${this._date(e.end)}`;
    if (startsBefore) return `${until} ${this._time(e.end)}`;
    if (endsAfter) {
      return `${this._time(e.start)}, ${until.toLowerCase()} ${this._date(e.end)} ${this._time(e.end)}`;
    }
    return `${this._time(e.start)} - ${this._time(e.end)}`;
  }

  // The whole event, from its first day to its last, for the details.
  _when(e) {
    const date = (d) =>
      d.toLocaleDateString(this._locale(), { weekday: "long", day: "numeric", month: "long" });
    if (e.allDay) {
      return sameDay(e.start, e.end) ? `${date(e.start)} · ${TEXT.allDay}` : `${date(e.start)} – ${date(e.end)}`;
    }
    if (sameDay(e.start, e.end)) return `${date(e.start)} · ${this._time(e.start)} – ${this._time(e.end)}`;
    return `${date(e.start)}, ${this._time(e.start)} – ${date(e.end)}, ${this._time(e.end)}`;
  }

  _render() {
    if (!this._config || !this._events) return;
    if (!this._built) this._build();
    const now = new Date();
    const day = this._eventsDay;
    const events = sortEvents(this._events, day, now);
    this._shown = events;

    const rows = events
      .map(
        (e, i) => `
          <div class="agenda-event${e.end < now ? " finished" : ""}${i === events.length - 1 ? " last" : ""}"
               data-index="${i}">
            <div class="agenda-top">
              <div class="agenda-title">${escapeHtml(e.title)}</div>
              <div class="agenda-hours">${escapeHtml(this._hours(e, day))}</div>
            </div>
            ${description(e.description)}
          </div>`
      )
      .join("");
    this._listEl.innerHTML = rows || TEXT.empty;
  }

  // Built once, so a refresh replaces only the list and leaves an open
  // details dialog alone.
  _build() {
    this.innerHTML = `
      <ha-card class="agenda">
        <style>
          .agenda { padding: 16px; cursor: default; }
          .agenda .agenda-list { padding-top: 4px; }
          .agenda .agenda-event { padding-left: 10px; cursor: pointer; }
          .agenda .agenda-event.last { padding-bottom: 8px; }
          .agenda .agenda-event.finished { opacity: .6; filter: grayscale(80%); }
          .agenda .agenda-top { display: flex; justify-content: space-between; color: var(--primary-text-color); }
          .agenda .agenda-title, .agenda .agenda-description { user-select: text; }
          .agenda .agenda-hours { text-align: right; overflow-wrap: anywhere; }
          .agenda .agenda-description { padding: 0 5px; font-size: 80%; overflow-wrap: anywhere;
                                        color: var(--primary-text-color); }
          .agenda .agenda-timetable { display: grid; grid-template-columns: auto 1fr;
                                      column-gap: 8px; justify-content: start; line-height: 1.5; }
          .agenda .agenda-tt-time { font-variant-numeric: tabular-nums; }

          /* showModal() puts the dialog in the top layer, above the whole
             dashboard, whatever the card sits in. */
          .agenda-dialog { box-sizing: border-box; width: min(860px, calc(100vw - 32px));
            max-height: calc(100vh - 32px); padding: 24px; border: none;
            border-radius: var(--ha-dialog-border-radius, 24px);
            background: var(--ha-dialog-surface-background, var(--card-background-color, #fff));
            color: var(--primary-text-color); font-family: var(--ha-font-family-body, Roboto, sans-serif);
            font-size: 14px; line-height: 1.6; }
          .agenda-dialog::backdrop { background: rgba(0, 0, 0, .5); }
          .agenda-dialog .agenda-d-head { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; }
          .agenda-dialog h2 { flex: 1; margin: 0; font-size: 22px; font-weight: 400; line-height: 1.3;
                              overflow-wrap: anywhere; user-select: text; outline: none; }
          .agenda-dialog .agenda-d-close { flex: none; display: flex; padding: 4px; margin: -4px -4px 0 0;
            border: none; border-radius: 50%; background: none; color: inherit; cursor: pointer; }
          .agenda-dialog .agenda-d-close:hover { background: rgba(127, 127, 127, .15); }
          .agenda-dialog .agenda-d-row { display: flex; gap: 12px; align-items: flex-start; padding: 4px 0; }
          .agenda-dialog .agenda-d-row ha-icon { flex: none; --mdc-icon-size: 20px;
                                                 color: var(--secondary-text-color); }
          .agenda-dialog .agenda-d-text { flex: 1; min-width: 0; overflow-wrap: anywhere; user-select: text; }
          .agenda-dialog .agenda-d-description { white-space: pre-line; }
          .agenda-dialog .agenda-timetable { display: grid; grid-template-columns: auto 1fr;
                                             column-gap: 12px; justify-content: start; }
          .agenda-dialog .agenda-tt-time { font-variant-numeric: tabular-nums; }

          /* The day on the left, the chosen event on the right. On a phone
             the day sits above, at most half the screen high. */
          .agenda-dialog .agenda-d-layout { display: grid; grid-template-columns: 320px 1fr; gap: 24px;
                                            height: min(600px, calc(100vh - 80px)); }
          .agenda-dialog .agenda-d-info { min-width: 0; overflow: auto; }
          @media (max-width: 680px) {
            .agenda-dialog { padding: 16px; }
            .agenda-dialog .agenda-d-layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr;
                                              height: calc(100vh - 64px); gap: 16px; }
            .agenda-dialog .agenda-day { max-height: 45vh; }
          }
          .agenda-dialog .agenda-day { display: flex; flex-direction: column; min-height: 0;
            border-right: 1px solid var(--divider-color, rgba(127, 127, 127, .25)); padding-right: 16px; }
          @media (max-width: 680px) {
            .agenda-dialog .agenda-day { border-right: none; padding-right: 0; padding-bottom: 12px;
              border-bottom: 1px solid var(--divider-color, rgba(127, 127, 127, .25)); }
          }
          .agenda-dialog .agenda-day-date { font-size: 16px; margin-bottom: 8px; }
          .agenda-dialog .agenda-day-allday { display: flex; flex-direction: column; gap: 2px; margin: 0 0 8px 48px; }
          .agenda-dialog .agenda-day-scroll { flex: 1; min-height: 0; overflow-y: auto; }
          .agenda-dialog .agenda-day-grid { position: relative; margin-top: 8px; }
          .agenda-dialog .agenda-day-hour { position: absolute; left: 0; right: 0; height: 0;
            border-top: 1px solid var(--divider-color, rgba(127, 127, 127, .25)); }
          .agenda-dialog .agenda-day-hour span { position: absolute; left: 0; top: -9px; padding-right: 6px;
            font-size: 11px; line-height: 18px; color: var(--secondary-text-color);
            background: var(--ha-dialog-surface-background, var(--card-background-color, #fff));
            font-variant-numeric: tabular-nums; }
          .agenda-dialog .agenda-day-now { position: absolute; left: 44px; right: 0; height: 0;
            border-top: 2px solid var(--error-color, #db4437); z-index: 2; pointer-events: none; }
          .agenda-dialog .agenda-day-event { position: absolute; box-sizing: border-box; overflow: hidden;
            display: flex; flex-direction: column; justify-content: flex-start; margin: 0; padding: 1px 6px; border: none; border-left: 3px solid var(--ev); border-radius: 4px;
            background: color-mix(in srgb, var(--ev) 22%, transparent); color: inherit; font: inherit;
            font-size: 12px; line-height: 16px; text-align: left; cursor: pointer; }
          .agenda-dialog .agenda-day-allday .agenda-day-event { position: static; width: 100%; padding: 2px 6px; }
          .agenda-dialog .agenda-day-event:hover { background: color-mix(in srgb, var(--ev) 35%, transparent); }
          .agenda-dialog .agenda-day-event.selected { background: color-mix(in srgb, var(--ev) 50%, transparent);
            box-shadow: inset 0 0 0 1px var(--ev); }
          .agenda-dialog .agenda-day-event.finished { opacity: .6; }
          .agenda-dialog .agenda-day-event b { display: block; font-weight: 500; white-space: nowrap;
            overflow: hidden; text-overflow: ellipsis; }
          .agenda-dialog .agenda-day-event small { display: block; font-size: 11px; opacity: .8;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
          .agenda-dialog .agenda-d-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
            margin-right: 8px; background: var(--ev); vertical-align: 0; }
        </style>
        <div class="agenda-list"></div>
      </ha-card>
      <dialog class="agenda-dialog"></dialog>`;

    this._listEl = this.querySelector(".agenda-list");
    this._dialogEl = this.querySelector(".agenda-dialog");

    this._listEl.addEventListener("click", (ev) => {
      // Selecting text is not a tap.
      if (String(window.getSelection?.() || "")) return;
      const row = ev.target.closest(".agenda-event");
      if (row) this._openDetails(Number(row.getAttribute("data-index")));
    });
    this._dialogEl.addEventListener("click", (ev) => {
      // A click on the backdrop lands on the dialog itself.
      if (ev.target === this._dialogEl || ev.target.closest(".agenda-d-close")) {
        this._dialogEl.close();
        return;
      }
      const block = ev.target.closest(".agenda-day-event");
      if (block) this._select(Number(block.getAttribute("data-index")));
    });
    this._built = true;
  }

  // The day as it was when the dialog opened: a refresh while it is open
  // changes the list behind it, not the dialog.
  _openDetails(index) {
    this._dayEvents = this._shown || [];
    if (!this._dayEvents[index]) return;
    this._dialogEl.innerHTML = `
      <div class="agenda-d-layout">
        ${this._dayHtml(this._dayEvents, this._eventsDay)}
        <div class="agenda-d-info"></div>
      </div>`;
    this._select(index);
    this._dialogEl.showModal();
    // An hour of the day before the chosen event stays in view.
    const selected = this._dialogEl.querySelector(".agenda-day-grid .agenda-day-event.selected");
    const scroll = this._dialogEl.querySelector(".agenda-day-scroll");
    if (selected) scroll.scrollTop = Math.max(0, selected.offsetTop - HOUR_PX);
  }

  _select(index) {
    const e = this._dayEvents[index];
    if (!e) return;
    for (const b of this._dialogEl.querySelectorAll(".agenda-day-event")) {
      b.classList.toggle("selected", Number(b.getAttribute("data-index")) === index);
    }
    const calendar = this._hass?.states?.[e.entityId]?.attributes?.friendly_name || e.entityId;
    const row = (icon, html) =>
      `<div class="agenda-d-row"><ha-icon icon="${icon}"></ha-icon><div class="agenda-d-text">${html}</div></div>`;
    const timetable = e.description && parseTimetable(e.description);
    const text = timetable
      ? `<div class="agenda-timetable">${timetableRows(timetable)}</div>`
      : `<div class="agenda-d-description">${escapeHtml(e.description)}</div>`;

    // The title takes the focus, so the close button shows no focus ring
    // before anyone has used the keyboard.
    const info = this._dialogEl.querySelector(".agenda-d-info");
    info.innerHTML = `
      <div class="agenda-d-head">
        <h2 tabindex="-1" autofocus>${escapeHtml(e.title)}</h2>
        <button class="agenda-d-close" aria-label="${TEXT.close}"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      ${row("mdi:clock-outline", escapeHtml(this._when(e)))}
      ${row("mdi:calendar", `<span class="agenda-d-dot" style="--ev:${this._color(e)}"></span>${escapeHtml(calendar)}`)}
      ${e.location ? row("mdi:map-marker", escapeHtml(e.location)) : ""}
      ${e.description ? row("mdi:text", text) : ""}`;
    info.scrollTop = 0;
    info.querySelector("h2").focus();
  }

  // One color per calendar, in the order of `entities`.
  _color(e) {
    const i = Math.max(0, this._config.entities.indexOf(e.entityId));
    return CALENDAR_COLORS[i % CALENDAR_COLORS.length];
  }

  // An hour grid from 07:00 to 20:00, or wider when an event needs it. All-day
  // events sit above it, and events that overlap share the width.
  _dayHtml(events, day) {
    const next = addDays(day, 1);
    const hours = (d) => (d - day) / 3600000;
    const timed = events
      .map((e, index) => ({ e, index, from: Math.max(0, hours(e.start)), to: Math.min(24, hours(e.end)) }))
      .filter((t) => !t.e.allDay && !(t.e.start <= day && t.e.end >= next));
    const allDay = events
      .map((e, index) => ({ e, index }))
      .filter((t) => t.e.allDay || (t.e.start <= day && t.e.end >= next));

    const first = Math.min(DAY_FIRST_HOUR, ...timed.map((t) => Math.floor(t.from)));
    const last = Math.max(DAY_LAST_HOUR, ...timed.map((t) => Math.ceil(t.to)));
    const y = (h) => (h - first) * HOUR_PX;
    const now = new Date();
    const block = (t, style) => `
      <button class="agenda-day-event${t.e.end < now ? " finished" : ""}" data-index="${t.index}"
              style="--ev:${this._color(t.e)};${style}">
        <b>${escapeHtml(t.e.title)}</b>
        ${t.e.allDay || (t.to - t.from) * HOUR_PX < 34 ? "" : `<small>${escapeHtml(this._hours(t.e, day))}</small>`}
      </button>`;

    const lines = [];
    for (let h = first; h <= last; h++) {
      const label = h < 24 ? this._time(new Date(day.getTime() + h * 3600000)) : "";
      lines.push(`<div class="agenda-day-hour" style="top:${y(h)}px"><span>${label}</span></div>`);
    }
    const blocks = layoutColumns(timed).map(({ t, col, cols }) => {
      const top = y(t.from);
      const height = Math.max(18, (t.to - t.from) * HOUR_PX - 2);
      const left = `calc(48px + (100% - 48px) * ${col / cols})`;
      const width = `calc((100% - 48px) / ${cols} - 2px)`;
      return block(t, `top:${top}px;height:${height}px;left:${left};width:${width}`);
    });
    const nowLine =
      now >= day && now < next ? `<div class="agenda-day-now" style="top:${y(hours(now))}px"></div>` : "";

    const date = day.toLocaleDateString(this._locale(), { weekday: "long", day: "numeric", month: "long" });
    return `
      <div class="agenda-day">
        <div class="agenda-day-date">${escapeHtml(date)}</div>
        ${allDay.length ? `<div class="agenda-day-allday">${allDay.map((t) => block(t, "")).join("")}</div>` : ""}
        <div class="agenda-day-scroll">
          <div class="agenda-day-grid" style="height:${y(last) + 10}px">
            ${lines.join("")}${blocks.join("")}${nowLine}
          </div>
        </div>
      </div>`;
  }

  getCardSize() {
    return (this._events?.length || 1) + 1;
  }
}

function description(text) {
  if (!text) return "";
  const timetable = parseTimetable(text);
  if (!timetable) return `<div class="agenda-description">${escapeHtml(text)}</div>`;
  return `<div class="agenda-description agenda-timetable">${timetableRows(timetable)}</div>`;
}

function timetableRows(timetable) {
  return timetable
    .map((r) => `<span class="agenda-tt-time">${escapeHtml(r.time)}</span><span>${escapeHtml(r.text)}</span>`)
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Forces the HA frontend to load ha-form and the pickers, which are only
// pulled in once some built-in card editor has been created.
async function loadHaComponents() {
  if (customElements.get("ha-form") && customElements.get("ha-entity-picker")) return;
  const helpers = await window.loadCardHelpers?.();
  if (!helpers) return;
  const card = await helpers.createCardElement({ type: "entities", entities: [] });
  await card.constructor?.getConfigElement?.();
}

class AgendaCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  _schema() {
    return [
      { name: "entities", selector: { entity: { domain: "calendar", multiple: true } } },
      { name: "days_ahead", selector: { number: { min: 0, max: 7, mode: "box" } } },
      { name: "hide_duplicates", selector: { boolean: {} } },
    ];
  }

  _update() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) =>
        ({
          entities: "Kalender",
          days_ahead: "Tage voraus (0 = heute, 1 = morgen)",
          hide_duplicates: "Doppelte Termine nur einmal zeigen",
        })[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const next = { ...ev.detail.value };
        if (!next.days_ahead) delete next.days_ahead;
        if (!next.hide_duplicates) delete next.hide_duplicates;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: next },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.data = {
      ...this._config,
      entities: (this._config.entities || []).map((e) => (typeof e === "string" ? e : e.entity)),
    };
  }
}

customElements.define("agenda-card-editor", AgendaCardEditor);
customElements.define("agenda-card", AgendaCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "agenda-card",
  name: "Agenda",
  description: "Die Termine eines Tages aus mehreren Kalendern",
  preview: true,
  documentationURL: "https://github.com/josa42/homeassistant-agenda-card",
});
