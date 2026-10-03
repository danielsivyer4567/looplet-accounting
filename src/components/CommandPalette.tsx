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

/**
 * How well an item matches: 0 label starts with the query, 1 label contains it, 2 the route
 * or hint contains it, 3 only the keywords contain it; -1 no match. Every word must match.
 */
function score(item: CommandItem, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const label = item.label.toLowerCase();
  const hint = (item.hint ?? '').toLowerCase();
  const keywords = (item.keywords ?? '').toLowerCase();
  let worst = 0;
  for (const word of words) {
    const s = label.startsWith(word) ? 0 : label.includes(word) ? 1 : hint.includes(word) ? 2 : keywords.includes(word) ? 3 : -1;
    if (s < 0) return -1;
    worst = Math.max(worst, s);
  }
  return worst;
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

  // Pages first, then actions; within a group the best matches first (a stable sort keeps the
  // nav order among equals). `visible` is this same flattened order, so arrow keys follow the list.
  const groups = useMemo(() => {
    const order: CommandItem['group'][] = ['Pages', 'Actions'];
    return order
      .map((group) => ({
        group,
        items: items
          .filter((i) => i.group === group)
          .map((item, index) => ({ item, index, s: score(item, query) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => a.s - b.s || a.index - b.index)
          .map((x) => x.item),
      }))
      .filter((g) => g.items.length > 0);
  }, [items, query]);
  const visible = useMemo(() => groups.flatMap((g) => g.items), [groups]);

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
