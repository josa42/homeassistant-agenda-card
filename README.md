# Agenda Card

[![GitHub Release](https://img.shields.io/github/v/release/josa42/homeassistant-agenda-card?style=flat-square)](https://github.com/josa42/homeassistant-agenda-card/releases)
[![License](https://img.shields.io/github/license/josa42/homeassistant-agenda-card?style=flat-square)](LICENSE)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=flat-square)](https://hacs.xyz/)

One day's events from several calendars, one line each: the title on the
left, the time on the right, the description below. Events that have ended are
dimmed.

The look follows the event list of [Atomic Calendar Revive](https://github.com/totaldebug/atomic-calendar-revive),
with only that list kept: no month or planner view, no header and no options
to style it.

<br><br>

## Configuration

```yaml
type: custom:agenda-card
entities:
  - calendar.family
  - calendar.school
```

| Option            | Default | Description                                                        |
| ----------------- | ------- | ------------------------------------------------------------------ |
| `entities`        |         | The calendars to show, as entity IDs                              |
| `days_ahead`      | `0`     | Which day to show: `0` today, `1` tomorrow, and so on             |
| `hide_duplicates` | `false` | Show an event that sits in several calendars once                 |

Two cards make a today and tomorrow view:

```yaml
- type: heading
  heading: Heute
- type: custom:agenda-card
  entities: [calendar.family, calendar.school]
- type: heading
  heading: Morgen
- type: custom:agenda-card
  entities: [calendar.family, calendar.school]
  days_ahead: 1
```

A description that is a timetable, like
`07:50 Deutsch 09:50 Mathe 10:40 Kunst`, is shown one entry per line, the
times in a column. It needs at least two entries and has to start with a time;
anything else stays plain text.

All-day events come first and show no time. On today, the events that have
ended move to the top. An event that runs past the day says until when.

Tapping an event opens the day: an hour grid on the left with every event of
the day as a block, one color per calendar, and the tapped event's details on
the right, with the full date and time, the calendar, the location and the
whole description. Tapping another block shows its details instead. On a
phone the day sits above the details. Tap beside it, the close button or
Escape to close it. The card fetches the events again every
minute.

<br><br>

## Installation

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=josa42&repository=homeassistant-agenda-card&category=plugin)

Or add it by hand:

1. Open HACS
2. Click the three dots menu (top right) → Custom repositories
3. Add repository URL: `https://github.com/josa42/homeassistant-agenda-card`
4. Category: `Dashboard`
5. Click "Add", then "Download" on the Agenda Card
6. Reload your browser with a hard refresh

Without HACS, copy `agenda-card.js` from the [latest release](https://github.com/josa42/homeassistant-agenda-card/releases)
to `config/www/` and add `/local/agenda-card.js?v=1` as a JavaScript module
under Settings → Dashboards → ⋮ → Resources. Bump the `?v=` query every time
you replace the file, or the browser keeps the old copy.

<br><br>

## Development

`npm run sandbox` serves a test page at <http://127.0.0.1:8766/sandbox/>. It
loads the card straight from the working tree with mocked calendars, so a
reload shows every change.

<br><br>

## License

[MIT](LICENSE)
