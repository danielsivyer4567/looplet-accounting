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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TagStateProvider } from '@/hooks/useTagState';
import { ModernTagRenderer } from '@/components/tag-drop/ModernTagRenderer';
import { TagDropPopup } from '@/components/tag-drop/TagDropPopup';
import { TagDropManager } from '@/components/tag-drop/TagDropManager';
import type { TagMarker, StaffMember, TagDropPopupProps } from '@/components/tag-drop/types';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));

const tagServiceMocks = vi.hoisted(() => ({
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getTaggableStaff: vi.fn(),
  loadTagDraft: vi.fn(),
  markTagAsRead: vi.fn(),
  saveTagDraft: vi.fn(),
  updateApprovalStatus: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => {
  const query = {
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  };
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  query.select.mockReturnValue(query);
  query.update.mockReturnValue(query);

  return {
    from: vi.fn(() => query),
    query,
  };
});

vi.mock('@/services/tags/tag-service', () => tagServiceMocks);
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: supabaseMocks.from,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  tagServiceMocks.getTaggableStaff.mockResolvedValue({ data: [], error: null });
  supabaseMocks.query.maybeSingle.mockResolvedValue({ data: null, error: null });
});

const markers: TagMarker[] = [
  {
    id: 't1',
    x: 100,
    y: 120,
    timestamp: 1_700_000_000_000,
    comment: 'Check this invoice',
    creatorId: 'u1',
  },
  {
    id: 't2',
    x: 480,
    y: 360,
    timestamp: 1_700_000_100_000,
    comment: 'Second pin',
    creatorId: 'u2',
  },
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
  const accountantStaff: StaffMember = { id: 's1', name: 'Alice Accountant', role: 'accountant' };
  const bookkeeperStaff: StaffMember = { id: 's2', name: 'Bob Bookkeeper', role: 'staff' };
  const staff: StaffMember[] = [accountantStaff, bookkeeperStaff];

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

  it('highlights and checks selected accountant rows', () => {
    const { container } = render(<TagDropPopup {...baseProps} selectedStaff={[accountantStaff]} />);

    const accountantRow = container.querySelector('[data-accountant-row="true"]');
    expect(accountantRow).toHaveTextContent('Alice Accountant');
    expect(accountantRow).toHaveTextContent('Accountant');
    expect(screen.getByLabelText('Select Alice Accountant')).toBeChecked();
    expect(screen.getByLabelText('Select Bob Bookkeeper')).not.toBeChecked();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<TagDropPopup {...baseProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('TagDropManager', () => {
  it('ignores page clicks from data-no-tag-drop controls', () => {
    render(
      <MemoryRouter>
        <button type="button" data-no-tag-drop>
          Toolbar control
        </button>
        <TagDropManager isActive organizationId="org-1" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toolbar control' }), {
      clientX: 120,
      clientY: 160,
    });

    expect(screen.queryByText('Tag Drop')).not.toBeInTheDocument();
  });

  it('preselects non-self accountants when opening a fresh tag', async () => {
    tagServiceMocks.getTaggableStaff.mockResolvedValue({
      data: [
        {
          id: 'u1',
          email: 'me@example.com',
          full_name: 'Current User',
          role: 'accountant',
          avatar_url: null,
        },
        {
          id: 's1',
          email: 'alice@example.com',
          full_name: 'Alice Accountant',
          role: 'accountant',
          avatar_url: null,
        },
        {
          id: 's2',
          email: 'bob@example.com',
          full_name: 'Bob Bookkeeper',
          role: 'staff',
          avatar_url: null,
        },
      ],
      error: null,
    });

    render(
      <MemoryRouter>
        <TagDropManager isActive organizationId="org-1" />
      </MemoryRouter>,
    );

    fireEvent.click(document.body, { clientX: 120, clientY: 160 });

    await screen.findByText('Tag Drop');

    await waitFor(() => {
      expect(screen.getByLabelText('Select Alice Accountant')).toBeChecked();
    });
    expect(screen.getByLabelText('Select Current User')).not.toBeChecked();
    expect(screen.getByLabelText('Select Bob Bookkeeper')).not.toBeChecked();
  });

  it('opens a tag overlay from a notification deep link', async () => {
    tagServiceMocks.getTaggableStaff.mockResolvedValue({
      data: [
        {
          id: 'u2',
          email: 'alice@example.com',
          full_name: 'Alice Accountant',
          role: 'accountant',
          avatar_url: null,
        },
      ],
      error: null,
    });
    supabaseMocks.query.maybeSingle.mockResolvedValue({
      data: {
        id: 'tag-1',
        organization_id: 'org-1',
        creator_id: 'u2',
        page_url: '/bills',
        comment: 'Check the GST split',
        coords: { x: 140, y: 180 },
        drawing_data: null,
        drawing_url: null,
        requires_approval: false,
        approval_status: null,
        timestamp: 1_700_000_000_000,
        tag_attachments: [],
      },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/bills?tag=tag-1']}>
        <TagDropManager organizationId="org-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Check the GST split')).toBeInTheDocument();
    expect(screen.getByText('Alice Accountant')).toBeInTheDocument();
    expect(tagServiceMocks.markTagAsRead).toHaveBeenCalledWith('tag-1', 'u1');
  });
});
