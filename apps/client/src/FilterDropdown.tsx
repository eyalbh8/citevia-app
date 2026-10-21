import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './filter-dropdown.css';

export type FilterOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  disabled?: boolean;
};
type Props = {
  label: string;
  options: FilterOption[];
  icon?: ReactNode;
  placeholder?: string;
  displayValue?: string;
  className?: string;
  active?: boolean;
  disabled?: boolean;
} & (
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
);

/** Shared single/multiple filter menu. Empty value means every option is included. */
export default function FilterDropdown(props: Props) {
  const {
    label,
    options,
    icon,
    placeholder,
    displayValue,
    className = '',
    disabled = false,
  } = props;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [focusedValue, setFocusedValue] = useState<string | null>(null);
  const focused = options.findIndex(
    (option) => option.value === focusedValue && !option.disabled,
  );
  const setFocused = (index: number) =>
    setFocusedValue(options[index]?.value ?? null);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 260,
    maxHeight: 360,
  });
  const values = props.multiple
    ? props.value
    : props.value
      ? [props.value]
      : [];
  const isSelected = (value: string) =>
    value === '' ? !values.length : values.includes(value);
  const selected = options.filter((option) => isSelected(option.value));
  const triggerIcon =
    icon ?? (selected.length === 1 ? selected[0].icon : undefined);
  const caption =
    displayValue ??
    (values.length === 0 && placeholder
      ? placeholder
      : selected.length === 1
        ? selected[0].label
        : values.length
          ? `${values.length} selected`
          : label);
  const active = props.active ?? Boolean(values.length);
  const enabled = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (fromEnd = false) => {
    if (disabled || !enabled.length) return;
    const chosen = options.findIndex(
      (option) => !option.disabled && isSelected(option.value),
    );
    setFocused(
      chosen >= 0 ? chosen : fromEnd ? enabled[enabled.length - 1] : enabled[0],
    );
    typeahead.current = { text: '', time: 0 };
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (props.multiple) {
      props.onChange(
        option.value === ''
          ? []
          : values.includes(option.value)
            ? values.filter((value) => value !== option.value)
            : [...values, option.value],
      );
    } else {
      props.onChange(option.value);
      close(true);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(
        Math.max(260, rect.width),
        320,
        viewportWidth - 24,
      );
      const height = Math.min(
        panel.current?.scrollHeight || 360,
        360,
        viewportHeight - 24,
      );
      const top =
        rect.bottom + height + 8 <= viewportHeight - 12
          ? rect.bottom + 8
          : Math.max(
              12,
              Math.min(rect.top - height - 8, viewportHeight - height - 12),
            );
      setPosition({
        width,
        top,
        left: Math.max(12, Math.min(rect.left, viewportWidth - width - 12)),
        maxHeight: Math.min(360, viewportHeight - top - 12),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open || focused >= 0) return;
    const next = options.findIndex(
      (option) => !option.disabled && isSelected(option.value),
    );
    const fallback = options.findIndex((option) => !option.disabled);
    if (fallback < 0) setOpen(false);
    else setFocused(next >= 0 ? next : fallback);
  }, [open, focused, options]);
  useLayoutEffect(() => {
    if (open)
      list.current
        ?.querySelector(`[data-option-index="${focused}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [focused, open]);

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      // Resume the page's tab order at the trigger, including within a drawer.
      close(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      choose(focused);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = enabled.indexOf(focused);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? enabled.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) %
              enabled.length;
      if (enabled.length) setFocused(enabled[next]);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - typeahead.current.time < 600 ? typeahead.current.text : '') +
        event.key.toLocaleLowerCase();
      typeahead.current = { text, time: now };
      const search = [...text].every((character) => character === text[0])
        ? text[0]
        : text;
      const start = search.length === 1 ? focused + 1 : focused;
      const match = Array.from(
        { length: options.length },
        (_, index) => (start + index) % options.length,
      ).find(
        (index) =>
          !options[index].disabled &&
          options[index].label.toLocaleLowerCase().startsWith(search),
      );
      if (match !== undefined) setFocused(match);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`filter-dropdown-trigger ${className}${active ? ' is-filtered' : ''}${open ? ' is-open' : ''}`}
        disabled={disabled || !enabled.length}
        aria-label={caption === label ? label : `${label}: ${caption}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show(event.key === 'ArrowUp');
          }
        }}
      >
        {triggerIcon && (
          <span className="filter-dropdown-icon" aria-hidden="true">
            {triggerIcon}
          </span>
        )}
        <span className="filter-dropdown-value">{caption}</span>
        <ChevronDown
          className="filter-dropdown-chevron"
          size={14}
          aria-hidden="true"
        />
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="filter-dropdown-panel" style={position}>
            <div className="filter-dropdown-heading" id={`${id}-heading`}>
              {label}
            </div>
            <div
              ref={list}
              id={id}
              className="filter-dropdown-list"
              role="listbox"
              tabIndex={0}
              aria-labelledby={`${id}-heading`}
              aria-multiselectable={props.multiple || undefined}
              aria-activedescendant={
                options[focused] ? `${id}-option-${focused}` : undefined
              }
              onKeyDown={keydown}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-option-${index}`}
                  data-option-index={index}
                  role="option"
                  aria-selected={isSelected(option.value)}
                  aria-disabled={option.disabled || undefined}
                  aria-label={option.label}
                  className={`filter-dropdown-option${isSelected(option.value) ? ' is-selected' : ''}${focused === index ? ' is-focused' : ''}${option.value === '' ? ' is-all' : ''}`}
                  title={option.label}
                  onPointerMove={() => !option.disabled && setFocused(index)}
                  onClick={() => choose(index)}
                >
                  {option.icon && (
                    <span
                      className="filter-dropdown-option-icon"
                      aria-hidden="true"
                    >
                      {option.icon}
                    </span>
                  )}
                  <span className="filter-dropdown-option-text">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  <span
                    className={`filter-dropdown-check${props.multiple ? ' is-checkbox' : ''}`}
                    aria-hidden="true"
                  >
                    {isSelected(option.value) && (
                      <Check size={14} strokeWidth={2.5} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>,
          trigger.current?.closest('[role="dialog"]') || document.body,
        )}
    </>
  );
}
