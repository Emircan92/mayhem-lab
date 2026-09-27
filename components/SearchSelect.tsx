"use client";

import { useId, useMemo, useRef, useState } from "react";

export type SearchOption = {
  id: number;
  name: string;
  subtitle?: string;
  searchText?: string;
  tone?: string;
};

type SearchSelectProps = {
  label: string;
  options: SearchOption[];
  placeholder: string;
  onSelect: (id: number) => void;
  excludeIds?: ReadonlySet<number>;
  disabled?: boolean;
};

function searchable(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

export function SearchSelect({
  label,
  options,
  placeholder,
  onSelect,
  excludeIds = new Set(),
  disabled = false,
}: SearchSelectProps) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const matches = useMemo(() => {
    const needle = searchable(query);
    return options
      .filter((option) => !excludeIds.has(option.id))
      .filter((option) => {
        if (!needle) return true;
        return searchable(`${option.name} ${option.id} ${option.searchText ?? ""}`).includes(needle);
      })
      .slice(0, 8);
  }, [excludeIds, options, query]);

  function choose(option: SearchOption) {
    onSelect(option.id);
    setQuery("");
    setOpen(false);
    setActiveIndex(0);
  }

  return (
    <div className="search-select">
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${inputId}-listbox`}
        aria-autocomplete="list"
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 100);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.min(current + 1, Math.max(matches.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter" && open && matches[activeIndex]) {
            event.preventDefault();
            choose(matches[activeIndex]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <div className="search-results" id={`${inputId}-listbox`} role="listbox">
          {matches.length ? (
            matches.map((option, index) => (
              <button
                className={index === activeIndex ? "search-result is-active" : "search-result"}
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                <span className={`result-mark ${option.tone ?? ""}`} aria-hidden="true" />
                <span className="result-copy">
                  <strong>{option.name}</strong>
                  {option.subtitle ? <small>{option.subtitle}</small> : null}
                </span>
                <kbd>↵</kbd>
              </button>
            ))
          ) : (
            <p className="search-empty">No matches</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
