/**
 * P0-04 — Media attachment scope (persist-or-hide).
 *
 * Durable media upload (image / audio / video) is NOT wired: the
 * `tag-attachments` storage bucket exists (migration 0200) but no uploader was
 * ever built, so a captured base64/blob preview URL would not survive a reload.
 * Rather than pretend to support it, the Screen / Image / Voice controls are
 * omitted entirely (no dead buttons, no "coming soon" copy). The paths that DO
 * persist — comments, drawings (Paint), @mentions / staff notify, deep links —
 * stay fully enabled.
 *
 * These tests pin that contract on the presentational popup (no full manager /
 * Supabase needed): undurable media controls are absent, while the comment and
 * mention paths still render and fire their callbacks.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TagDropPopup } from '@/components/tag-drop/TagDropPopup';
import type { StaffMember, TagDropPopupProps } from '@/components/tag-drop/types';

const accountantStaff: StaffMember = { id: 's1', name: 'Alice Accountant', role: 'accountant' };
const staffMember: StaffMember = { id: 's2', name: 'Bob Bookkeeper', role: 'staff' };

function makeProps(overrides: Partial<TagDropPopupProps> = {}): TagDropPopupProps {
  const noop = vi.fn();
  return {
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
    availableStaff: [accountantStaff, staffMember],
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
    ...overrides,
  };
}

describe('TagDropPopup — media attachment scope (fresh tag)', () => {
  it('omits the Screen / Image / Voice controls entirely — no dead buttons, no coming-soon copy', () => {
    render(<TagDropPopup {...makeProps()} />);

    for (const label of ['Screen', 'Image', 'Voice']) {
      expect(screen.queryByRole('button', { name: new RegExp(label, 'i') })).toBeNull();
    }
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByText(/^Soon$/i)).toBeNull();
  });

  it('keeps the Paint (drawing) control enabled — drawings persist', () => {
    const onPaintClick = vi.fn();
    render(<TagDropPopup {...makeProps({ onPaintClick })} />);

    const paint = screen.getByRole('button', { name: /Paint/i });
    expect(paint).not.toBeDisabled();
    fireEvent.click(paint);
    expect(onPaintClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the comment path working (textarea fires onCommentChange)', () => {
    const onCommentChange = vi.fn();
    render(<TagDropPopup {...makeProps({ onCommentChange })} />);

    const textarea = screen.getByPlaceholderText('Add your comment...');
    fireEvent.change(textarea, { target: { value: 'Please review the GST split' } });
    expect(onCommentChange).toHaveBeenCalled();
  });

  it('keeps the mention/notify path working (staff picker lists members + fires select)', () => {
    const onStaffSelect = vi.fn();
    render(<TagDropPopup {...makeProps({ onStaffSelect })} />);

    expect(screen.getByText('Alice Accountant')).toBeInTheDocument();
    expect(screen.getByText('Bob Bookkeeper')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select Bob Bookkeeper'));
    expect(onStaffSelect).toHaveBeenCalledWith(staffMember);

    // The @Looplet AI mention target stays available too.
    expect(screen.getByLabelText('Select @Looplet AI assistant')).toBeInTheDocument();
  });
});

describe('TagDropPopup — media attachment scope (reply bar)', () => {
  const replyProps = () =>
    makeProps({ isReplyMode: true, selectedStaff: [accountantStaff], activeConversationId: 't1' });

  it('omits the undurable media chips and keeps Paint clickable', () => {
    const onPaintClick = vi.fn();
    const onImageUpload = vi.fn();
    render(
      <TagDropPopup {...replyProps()} onPaintClick={onPaintClick} onImageUpload={onImageUpload} />,
    );

    for (const label of ['Screen', 'Image', 'Voice']) {
      expect(screen.queryByRole('button', { name: new RegExp(label, 'i') })).toBeNull();
    }

    const paint = screen.getByRole('button', { name: /Paint/i });
    expect(paint).not.toBeDisabled();
    fireEvent.click(paint);
    expect(onPaintClick).toHaveBeenCalledTimes(1);
    expect(onImageUpload).not.toHaveBeenCalled();
  });

  it('keeps the reply comment box working', () => {
    const onCommentChange = vi.fn();
    render(<TagDropPopup {...replyProps()} onCommentChange={onCommentChange} />);

    const textarea = screen.getByPlaceholderText(/Type your reply/i);
    fireEvent.change(textarea, { target: { value: 'On it' } });
    expect(onCommentChange).toHaveBeenCalled();
  });
});
