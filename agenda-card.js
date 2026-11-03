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
    start,
    end,
    allDay,
  };
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

  _render() {
    if (!this._config || !this._events) return;
    const now = new Date();
    const day = this._eventsDay;
    const events = sortEvents(this._events, day, now);

    const rows = events
      .map(
        (e, i) => `
          <div class="agenda-event${e.end < now ? " finished" : ""}${i === events.length - 1 ? " last" : ""}"
               data-entity="${escapeHtml(e.entityId)}">
            <div class="agenda-top">
              <div class="agenda-title">${escapeHtml(e.title)}</div>
              <div class="agenda-hours">${escapeHtml(this._hours(e, day))}</div>
            </div>
            ${e.description ? `<div class="agenda-description">${escapeHtml(e.description)}</div>` : ""}
          </div>`
      )
      .join("");

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
        </style>
        <div class="agenda-list">${rows || TEXT.empty}</div>
      </ha-card>`;

    this.querySelector(".agenda-list").addEventListener("click", (ev) => {
      const row = ev.target.closest(".agenda-event");
      if (!row) return;
      this.dispatchEvent(
        new CustomEvent("hass-more-info", {
          detail: { entityId: row.getAttribute("data-entity") },
          bubbles: true,
          composed: true,
        })
      );
    });
  }

  getCardSize() {
    return (this._events?.length || 1) + 1;
  }
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
