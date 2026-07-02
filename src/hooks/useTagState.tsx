import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AttachmentType } from '@/constants/tags';

/**
 * Tag data interface for the overlay display
 * Used by useTagState to manage active tag information
 */
export interface TagOverlayData {
  id: string | number;
  // Optionals carry `| undefined` explicitly: under the repo's
  // `exactOptionalPropertyTypes`, the ported renderer/overlay build these from
  // nullable DB rows (`x ?? undefined`), which a bare `?:` would reject.
  comment?: string | undefined;
  senderName?: string | undefined;
  senderAvatar?: string | undefined;
  time?: string | undefined;
  coordinates?: { x: number; y: number } | undefined;
  mediaType?: AttachmentType | undefined;
  drawingData?: string | undefined;
  drawingUrl?: string | undefined;
  attachments?:
    | {
        type: AttachmentType;
        url: string;
      }[]
    | undefined;
  creatorId?: string | undefined;
  approvalStatus?: 'pending' | 'approved' | 'rejected' | undefined;
  requiresApproval?: boolean | undefined;
  taggedStaffIds?: string[] | undefined;
  organizationId?: string | undefined;
  pageUrl?: string | undefined;
}

// Keep backward compatibility alias
type TagData = TagOverlayData;

export type TagStatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'no_approval';

interface TagStateContextType {
  activeTag: TagOverlayData | null;
  setActiveTag: (tag: TagOverlayData | null) => void;
  isTagOverlayVisible: boolean;
  showTagOverlay: (tag: TagOverlayData) => void;
  hideTagOverlay: () => void;
  /** Global toggle: when true, ModernTagRenderer skips drawing markers
   *  (useful for screenshots / focus mode). Persists in localStorage. */
  tagsHidden: boolean;
  setTagsHidden: (hidden: boolean) => void;
  /** Filter visible markers by approval state. Persists in localStorage. */
  tagStatusFilter: TagStatusFilter;
  setTagStatusFilter: (filter: TagStatusFilter) => void;
  /** When true, ModernTagRenderer only shows markers the current user
   *  created. Persists in localStorage. */
  tagsMineOnly: boolean;
  setTagsMineOnly: (mineOnly: boolean) => void;
}

// Export the TagData type for backward compatibility
export type { TagOverlayData as TagData };

const TagStateContext = createContext<TagStateContextType | undefined>(undefined);

export const useTagState = () => {
  const context = useContext(TagStateContext);
  if (!context) {
    throw new Error('useTagState must be used within a TagStateProvider');
  }
  return context;
};

interface TagStateProviderProps {
  children: ReactNode;
}

const TAGS_HIDDEN_KEY = 'looplet:tags_hidden';
const TAGS_FILTER_KEY = 'looplet:tags_filter';
const TAGS_MINE_KEY = 'looplet:tags_mine_only';
const VALID_FILTERS: readonly TagStatusFilter[] = [
  'all',
  'pending',
  'approved',
  'rejected',
  'no_approval',
];

export const TagStateProvider: React.FC<TagStateProviderProps> = ({ children }) => {
  const [activeTag, setActiveTag] = useState<TagOverlayData | null>(null);
  const [isTagOverlayVisible, setIsTagOverlayVisible] = useState(false);
  const [tagsHidden, setTagsHiddenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TAGS_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  });

  const setTagsHidden = useCallback((hidden: boolean) => {
    setTagsHiddenState(hidden);
    try {
      if (hidden) localStorage.setItem(TAGS_HIDDEN_KEY, '1');
      else localStorage.removeItem(TAGS_HIDDEN_KEY);
    } catch {
      // localStorage unavailable — accept in-memory only
    }
  }, []);

  const [tagStatusFilter, setTagStatusFilterState] = useState<TagStatusFilter>(() => {
    try {
      const raw = localStorage.getItem(TAGS_FILTER_KEY);
      if (raw && (VALID_FILTERS as readonly string[]).includes(raw)) return raw as TagStatusFilter;
    } catch {
      /* noop */
    }
    return 'all';
  });

  const setTagStatusFilter = useCallback((filter: TagStatusFilter) => {
    setTagStatusFilterState(filter);
    try {
      if (filter === 'all') localStorage.removeItem(TAGS_FILTER_KEY);
      else localStorage.setItem(TAGS_FILTER_KEY, filter);
    } catch {
      /* noop */
    }
  }, []);

  const [tagsMineOnly, setTagsMineOnlyState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TAGS_MINE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const setTagsMineOnly = useCallback((mineOnly: boolean) => {
    setTagsMineOnlyState(mineOnly);
    try {
      if (mineOnly) localStorage.setItem(TAGS_MINE_KEY, '1');
      else localStorage.removeItem(TAGS_MINE_KEY);
    } catch {
      /* noop */
    }
  }, []);

  // Fix memory leak: store timeout ref for cleanup
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  const showTagOverlay = useCallback((tag: TagData) => {
    // Clear any pending hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setActiveTag(tag);
    setIsTagOverlayVisible(true);
  }, []);

  const hideTagOverlay = useCallback(() => {
    setIsTagOverlayVisible(false);
    // Clear existing timeout if any
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    // Store new timeout ref for potential cleanup
    hideTimeoutRef.current = setTimeout(() => {
      setActiveTag(null);
      hideTimeoutRef.current = null;
    }, 300);
  }, []);

  const value: TagStateContextType = {
    activeTag,
    setActiveTag,
    isTagOverlayVisible,
    showTagOverlay,
    hideTagOverlay,
    tagsHidden,
    setTagsHidden,
    tagStatusFilter,
    setTagStatusFilter,
    tagsMineOnly,
    setTagsMineOnly,
  };

  return <TagStateContext.Provider value={value}>{children}</TagStateContext.Provider>;
};

export default TagStateProvider;
