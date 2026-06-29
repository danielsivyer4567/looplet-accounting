/**
 * useTagDrop Hook
 *
 * Provides an easy-to-use interface for the Tag Drop system.
 * Manages activation state and provides callbacks for tag operations.
 */

import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

interface TagDropContextType {
  /** Whether tag drop mode is currently active */
  isTagDropActive: boolean;
  /** Activate tag drop mode (click to place a tag) */
  activateTagDrop: () => void;
  /** Deactivate tag drop mode */
  deactivateTagDrop: () => void;
  /** Toggle tag drop mode */
  toggleTagDrop: () => void;
  /** Handle when a tag is created */
  onTagCreated: (callback: (tagId: string) => void) => void;
  /** Trigger the tag created callback */
  triggerTagCreated: (tagId: string) => void;
}

const TagDropContext = createContext<TagDropContextType | undefined>(undefined);

export function useTagDrop() {
  const context = useContext(TagDropContext);
  if (!context) {
    throw new Error('useTagDrop must be used within a TagDropProvider');
  }
  return context;
}

interface TagDropProviderProps {
  children: ReactNode;
}

export function TagDropProvider({ children }: TagDropProviderProps) {
  const [isTagDropActive, setIsTagDropActive] = useState(false);
  const [tagCreatedCallbacks, setTagCreatedCallbacks] = useState<
    ((tagId: string) => void)[]
  >([]);

  const activateTagDrop = useCallback(() => {
    setIsTagDropActive(true);
  }, []);

  const deactivateTagDrop = useCallback(() => {
    setIsTagDropActive(false);
  }, []);

  const toggleTagDrop = useCallback(() => {
    setIsTagDropActive((prev) => !prev);
  }, []);

  const onTagCreated = useCallback((callback: (tagId: string) => void) => {
    setTagCreatedCallbacks((prev) => [...prev, callback]);
    return () => {
      setTagCreatedCallbacks((prev) => prev.filter((cb) => cb !== callback));
    };
  }, []);

  const triggerTagCreated = useCallback(
    (tagId: string) => {
      tagCreatedCallbacks.forEach((cb) => cb(tagId));
    },
    [tagCreatedCallbacks]
  );

  const value: TagDropContextType = {
    isTagDropActive,
    activateTagDrop,
    deactivateTagDrop,
    toggleTagDrop,
    onTagCreated,
    triggerTagCreated,
  };

  return (
    <TagDropContext.Provider value={value}>{children}</TagDropContext.Provider>
  );
}

export default useTagDrop;
