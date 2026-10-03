import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search, type LucideIcon } from 'lucide-react';

export interface CommandItem {
  id: string;
  label: string;
  /** Shown after the label: a route, a shortcut, a note. */
  hint?: string | undefined;
  group: 'Pages' | 'Actions';
  icon?: LucideIcon | undefined;
  /** Extra words the search should match ("payday" for Payroll). */
  keywords?: string | undefined;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
}

function matches(item: CommandItem, query: string): boolean {
  if (!query) return true;
  const hay = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * The ⌘K / Ctrl+K palette: a combobox over the app's pages and actions. Arrow keys move,
 * Enter runs, Escape closes, and focus returns to wherever it came from.
 */
export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const titleId = useId();

  const visible = useMemo(() => items.filter((item) => matches(item, query)), [items, query]);
  const groups = useMemo(() => {
    const order: CommandItem['group'][] = ['Pages', 'Actions'];
    return order.map((group) => ({ group, items: visible.filter((i) => i.group === group) })).filter((g) => g.items.length > 0);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    return () => {
      openerRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const activeItem = visible[Math.min(active, Math.max(visible.length - 1, 0))];
  const optionId = (item: CommandItem) => `${listId}-${item.id}`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (visible.length ? (i + 1) % visible.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (visible.length ? (i - 1 + visible.length) % visible.length : 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(visible.length - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeItem) {
        onClose();
        activeItem.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="palette-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="palette-kbd" aria-hidden="true">
            Esc
          </kbd>
        </div>
        <div id={listId} role="listbox" aria-label="Pages and actions" className="palette-list">
          {groups.length === 0 ? (
            <p className="palette-empty">Nothing matches “{query}”.</p>
          ) : (
            groups.map(({ group, items: groupItems }) => (
              <div key={group} role="group" aria-label={group} className="palette-group">
                <div className="palette-group-label" aria-hidden="true">
                  {group}
                </div>
                {groupItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeItem?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      id={optionId(item)}
                      role="option"
                      aria-selected={isActive}
                      className={`palette-option${isActive ? ' is-active' : ''}`}
                      onMouseEnter={() => setActive(visible.indexOf(item))}
                      onClick={() => {
                        onClose();
                        item.run();
                      }}
                    >
                      {Icon ? <Icon size={16} aria-hidden="true" /> : <span className="palette-option-spacer" aria-hidden="true" />}
                      <span className="palette-option-label">{item.label}</span>
                      {item.hint ? <span className="palette-option-hint">{item.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
