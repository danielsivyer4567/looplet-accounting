/**
 * Tests for the SC-2E tag-drop UI components.
 *
 * Covers the two presentational entry points without mounting the full
 * manager (that lands in SC-2F):
 *   - ModernTagRenderer — one clickable pin per marker, respects mine-only.
 *   - TagDropPopup       — staff picker lists members; closed → renders nothing.
 *
 * useAuth is mocked (no AuthProvider needed); TagStateProvider is the real one.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagStateProvider } from '@/hooks/useTagState';
import { ModernTagRenderer } from '@/components/tag-drop/ModernTagRenderer';
import { TagDropPopup } from '@/components/tag-drop/TagDropPopup';
import type { TagMarker, StaffMember, TagDropPopupProps } from '@/components/tag-drop/types';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));

const markers: TagMarker[] = [
  { id: 't1', x: 100, y: 120, timestamp: 1_700_000_000_000, comment: 'Check this invoice', creatorId: 'u1' },
  { id: 't2', x: 480, y: 360, timestamp: 1_700_000_100_000, comment: 'Second pin', creatorId: 'u2' },
];

describe('ModernTagRenderer', () => {
  it('renders one clickable pin per marker', () => {
    render(
      <TagStateProvider>
        <ModernTagRenderer markers={markers} />
      </TagStateProvider>,
    );
    expect(screen.getByLabelText('Tag: Check this invoice')).toBeInTheDocument();
    expect(screen.getByLabelText('Tag: Second pin')).toBeInTheDocument();
  });

  it('renders nothing when there are no markers', () => {
    const { container } = render(
      <TagStateProvider>
        <ModernTagRenderer markers={[]} />
      </TagStateProvider>,
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('TagDropPopup', () => {
  const noop = vi.fn();
  const staff: StaffMember[] = [
    { id: 's1', name: 'Alice Accountant', role: 'accountant' },
    { id: 's2', name: 'Bob Bookkeeper', role: 'staff' },
  ];

  const baseProps: TagDropPopupProps = {
    isOpen: true,
    coords: { x: 40, y: 40 },
    isDragging: false,
    tagComment: '',
    selectedStaff: [],
    uploadedFiles: [],
    isRecordingAudio: false,
    isRecordingScreen: false,
    staffSelectionError: null,
    requiresApproval: false,
    isUploading: false,
    uploadProgress: 0,
    isReplyMode: false,
    activeConversationId: null,
    selectedJob: null,
    availableStaff: staff,
    onClose: noop,
    onDragStart: noop,
    onCommentChange: noop,
    onStaffSelect: noop,
    onApprovalChange: noop,
    onToggleScreenRecord: noop,
    onImageUpload: noop,
    onAudioRecord: noop,
    onPaintClick: noop,
    onSaveTag: noop,
    onSaveDraft: noop,
    onAttachJob: noop,
    onLoadDraft: noop,
    onDeselectJob: noop,
    onRemoveFile: noop,
  };

  it('lists the available staff in the notify picker when open', () => {
    render(<TagDropPopup {...baseProps} />);
    expect(screen.getByText('Tag Drop')).toBeInTheDocument();
    expect(screen.getByText('Alice Accountant')).toBeInTheDocument();
    expect(screen.getByText('Bob Bookkeeper')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<TagDropPopup {...baseProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });
});
