import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '@citevia/core';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import './date-range-filter.css';

export type DateRangeSelection = { days: string; start: string; end: string };

const DAY = 86400000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);
const validDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(dateOf(value).getTime()) &&
  isoDay(dateOf(value)) === value;
const monthOf = (value: string) => `${value.slice(0, 7)}-01`;
const moveDay = (value: string, amount: number) =>
  isoDay(new Date(dateOf(value).getTime() + amount * DAY));
const moveMonth = (value: string, amount: number) => {
  const date = dateOf(value);
  return isoDay(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1)),
  );
};
const shortDate = (value: string) =>
  dateOf(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
const fullDate = (value: string) =>
  dateOf(value).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function initialDateRange(demo?: Project['demo']): DateRangeSelection {
  const today = isoDay(new Date());
  if (demo) {
    const end = today < demo.endDate ? today : demo.endDate;
    return { days: 'custom', start: demo.startDate, end: end < demo.startDate ? demo.startDate : end };
  }
  return { days: '7', start: moveDay(today, -6), end: today };
}

export default function DateRangeFilter({
  value,
  onChange,
  includeLast24Hours = true,
  demo,
}: {
  value: DateRangeSelection;
  onChange: (next: DateRangeSelection) => void;
  includeLast24Hours?: boolean;
  demo?: Project['demo'];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pendingCalendarFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [month, setMonth] = useState(monthOf(isoDay(new Date())));
  const [focusDay, setFocusDay] = useState(isoDay(new Date()));
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 484,
    maxHeight: 600,
  });
  const today = isoDay(new Date());
  const maxDay = demo?.endDate || today;
  const minDay = demo?.startDate;
  const historyEnd = today < maxDay ? today : maxDay;
  const demoPresets = demo
    ? [
        { label: 'All history', start: demo.startDate, end: historyEnd },
        { label: 'Full year', start: demo.startDate, end: demo.endDate },
      ]
    : [];
  const presets = includeLast24Hours
    ? ['1', '7', '14', '30', '90']
    : ['7', '14', '30', '90'];
  const presetLabel = (days: string) =>
    days === '1' ? 'Last 24 hours' : `Last ${days} days`;
  const label =
    value.days === 'custom' && validDay(value.start) && validDay(value.end)
      ? `${shortDate(value.start)}${value.start === value.end ? '' : ` – ${shortDate(value.end)}`}`
      : presetLabel(value.days);
  const effectiveEnd = draft.end || draft.start;
  const error =
    !validDay(draft.start) || !validDay(effectiveEnd)
      ? 'Choose a valid start and end date.'
      : draft.start > effectiveEnd
        ? 'End date must be on or after start date.'
        : minDay && draft.start < minDay
          ? `Choose dates on or after ${shortDate(minDay)}.`
        : effectiveEnd > maxDay
          ? demo
            ? `Choose dates up to ${shortDate(maxDay)}.`
            : 'Choose dates up to today.'
          : dateOf(effectiveEnd).getTime() -
                dateOf(draft.start).getTime() +
                DAY >
              366 * DAY
            ? 'Choose a range of 366 days or fewer.'
            : '';

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = () => {
    const selected =
      value.days === 'custom' && validDay(value.start) && validDay(value.end)
        ? value
        : {
            ...value,
            start: moveDay(today, -(Math.max(1, Number(value.days) || 7) - 1)),
            end: today,
          };
    setDraft(selected);
    const initialDay = selected.end > maxDay ? maxDay : selected.end;
    setMonth(monthOf(initialDay));
    setFocusDay(initialDay);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const height = window.innerHeight;
      const viewportWidth = document.documentElement.clientWidth;
      const width = Math.min(484, viewportWidth - 24);
      const panelHeight = Math.min(
        panel.current?.offsetHeight || 500,
        height - 24,
      );
      const below = rect.bottom + 8;
      const top =
        below + panelHeight <= height - 12
          ? below
          : Math.max(12, rect.top - panelHeight - 8);
      setPosition({
        width,
        left: Math.max(
          12,
          Math.min(rect.right - width, viewportWidth - width - 12),
        ),
        top,
        maxHeight: height - top - 12,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLButtonElement>('[data-initial-focus]')
      ?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!pendingCalendarFocus.current) return;
    panel.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${focusDay}"]`)
      ?.focus();
    pendingCalendarFocus.current = false;
  }, [focusDay, month]);

  const selectPreset = (days: string) => {
    onChange({ days, start: moveDay(today, -(Number(days) - 1)), end: today });
    close(true);
  };
  const selectDate = (day: string) => {
    setFocusDay(day);
    setDraft((current) => {
      if (current.days !== 'custom' || !current.start || current.end)
        return { days: 'custom', start: day, end: '' };
      return day < current.start
        ? { days: 'custom', start: day, end: current.start }
        : { days: 'custom', start: current.start, end: day };
    });
  };
  const navigate = (amount: number) => {
    const nextMonth = moveMonth(month, amount);
    setMonth(nextMonth);
    setFocusDay(
      nextMonth === monthOf(maxDay)
        ? maxDay
        : minDay && nextMonth === monthOf(minDay)
          ? minDay
          : nextMonth,
    );
  };
  const calendarKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    day: string,
  ) => {
    let next = day;
    const weekday = dateOf(day).getUTCDay();
    if (event.key === 'ArrowRight') next = moveDay(day, 1);
    else if (event.key === 'ArrowLeft') next = moveDay(day, -1);
    else if (event.key === 'ArrowDown') next = moveDay(day, 7);
    else if (event.key === 'ArrowUp') next = moveDay(day, -7);
    else if (event.key === 'Home') next = moveDay(day, -weekday);
    else if (event.key === 'End') next = moveDay(day, 6 - weekday);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const nextMonth = moveMonth(day, event.key === 'PageUp' ? -1 : 1);
      const lastDay = Number(moveDay(moveMonth(nextMonth, 1), -1).slice(-2));
      next = `${nextMonth.slice(0, 8)}${String(Math.min(Number(day.slice(-2)), lastDay)).padStart(2, '0')}`;
    } else return;
    event.preventDefault();
    if (next > maxDay) next = maxDay;
    if (minDay && next < minDay) next = minDay;
    pendingCalendarFocus.current = true;
    setFocusDay(next);
    setMonth(monthOf(next));
  };
  const startOffset = dateOf(month).getUTCDay();
  const monthLength = Number(moveDay(moveMonth(month, 1), -1).slice(-2));
  const weeks = Math.ceil((startOffset + monthLength) / 7);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`monitor-pill date-range-trigger${value.days !== '7' ? ' is-filtered' : ''}`}
        aria-label={`Date range: ${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : show())}
      >
        <CalendarDays size={17} aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className="date-range-panel"
            role="dialog"
            aria-labelledby={`${id}-title`}
            style={position}
          >
            <header className="date-range-heading">
              <h2 id={`${id}-title`}>Date range</h2>
              <button
                type="button"
                aria-label="Close date range"
                onClick={() => close(true)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="date-range-body">
              <div className="date-range-presets" aria-label="Date presets">
                {presets.map((days, index) => (
                  <button
                    key={days}
                    type="button"
                    data-initial-focus={index === 0 ? '' : undefined}
                    aria-pressed={draft.days === days}
                    onClick={() => selectPreset(days)}
                  >
                    <span>{presetLabel(days)}</span>
                    {draft.days === days && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </button>
                ))}
                {demoPresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={
                      draft.days === 'custom' &&
                      draft.start === preset.start &&
                      draft.end === preset.end
                    }
                    onClick={() => {
                      onChange({ days: 'custom', start: preset.start, end: preset.end });
                      close(true);
                    }}
                  >
                    <span>{preset.label}</span>
                    {draft.days === 'custom' &&
                      draft.start === preset.start &&
                      draft.end === preset.end && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={draft.days === 'custom'}
                  onClick={() => {
                    setDraft({ ...draft, days: 'custom' });
                    panel.current
                      ?.querySelector<HTMLInputElement>('[name="range-start"]')
                      ?.focus();
                  }}
                >
                  <span>Custom range</span>
                  {draft.days === 'custom' && (
                    <Check size={14} aria-hidden="true" />
                  )}
                </button>
                <button
                  className="date-range-reset"
                  type="button"
                  onClick={() => selectPreset('7')}
                >
                  Reset to default
                </button>
              </div>
              <div className="date-range-calendar">
                <div className="date-range-month">
                  <button
                    type="button"
                    aria-label="Previous month"
                    disabled={Boolean(minDay && month <= monthOf(minDay))}
                    onClick={() => navigate(-1)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <strong id={`${id}-month`} aria-live="polite">
                    {dateOf(month).toLocaleDateString('en-US', {
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </strong>
                  <button
                    type="button"
                    aria-label="Next month"
                    disabled={month >= monthOf(maxDay)}
                    onClick={() => navigate(1)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
                <table role="grid" aria-labelledby={`${id}-month`}>
                  <thead>
                    <tr>
                      {[
                        'Sunday',
                        'Monday',
                        'Tuesday',
                        'Wednesday',
                        'Thursday',
                        'Friday',
                        'Saturday',
                      ].map((day) => (
                        <th key={day} scope="col" aria-label={day}>
                          {day.slice(0, 2)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: weeks }, (_, week) => (
                      <tr key={week}>
                        {Array.from({ length: 7 }, (_, weekday) => {
                          const number = week * 7 + weekday - startOffset + 1;
                          if (number < 1 || number > monthLength)
                            return <td key={weekday} />;
                          const day = `${month.slice(0, 8)}${String(number).padStart(2, '0')}`;
                          const selected =
                            day >= draft.start && day <= effectiveEnd;
                          const endpoint =
                            day === draft.start || day === effectiveEnd;
                          return (
                            <td key={weekday} aria-selected={selected}>
                              <button
                                type="button"
                                data-date={day}
                                aria-label={fullDate(day)}
                                aria-current={
                                  day === today ? 'date' : undefined
                                }
                                disabled={day > maxDay || Boolean(minDay && day < minDay)}
                                tabIndex={day === focusDay ? 0 : -1}
                                className={`${selected ? 'in-range' : ''}${endpoint ? ' range-endpoint' : ''}`}
                                onFocus={() => setFocusDay(day)}
                                onClick={() => selectDate(day)}
                                onKeyDown={(event) => calendarKey(event, day)}
                              >
                                {number}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="date-range-fields">
              <label>
                Start date
                <input
                  name="range-start"
                  type="date"
                  value={draft.start}
                  min={minDay}
                  max={maxDay}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      days: 'custom',
                      start: event.target.value,
                    })
                  }
                />
              </label>
              <span aria-hidden="true">–</span>
              <label>
                End date
                <input
                  name="range-end"
                  type="date"
                  value={draft.end}
                  min={draft.start || minDay}
                  max={maxDay}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      days: 'custom',
                      end: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <p
              className={`date-range-help${error ? ' has-error' : ''}`}
              id={error ? `${id}-error` : undefined}
              aria-live="polite"
            >
              {error ||
                (draft.start && !draft.end
                  ? 'Choose an end date, or apply to view this day.'
                  : demo
                    ? 'Includes both dates (UTC).'
                    : 'Includes both dates. Times shown in UTC.')}
            </p>
            <footer className="date-range-actions">
              <button
                type="button"
                className="button button-outline"
                onClick={() => close(true)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={Boolean(error)}
                onClick={() => {
                  onChange(
                    draft.days === 'custom'
                      ? {
                          days: 'custom',
                          start: draft.start,
                          end: effectiveEnd,
                        }
                      : draft,
                  );
                  close(true);
                }}
              >
                Apply
              </button>
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
