/**
 * TagDropManager
 *
 * Main orchestrator for the Tag Drop system.
 * Manages state, coordinates between popup/overlay components,
 * and integrates with the tag service layer.
 *
 * Ported from the CRM tag-drop system. Looplet remappings:
 *   - `useProfile()` → `useAuth().user` (no `profiles` table / auth-store).
 *   - `projects` → `jobs` for the job picker.
 *   - deep-link creator name/avatar resolved via `getTaggableStaff` RPC
 *     (organization_memberships + auth.users) instead of a `profiles` query.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { TagDropPopup } from './TagDropPopup';
import { ModernTagOverlay } from './ModernTagOverlay';
import DrawingCanvas, { DrawingToolbar, type DrawingCanvasRef } from './DrawingCanvas';
import type { DrawingState, DrawingTool } from './types';
import { useTagState, TagStateProvider, type TagOverlayData } from '@/hooks/useTagState';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { X, Check, Undo2, Redo2, Eye, EyeOff, User, Search, Briefcase, Tag } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  createTag,
  deleteTag,
  getTaggableStaff,
  markTagAsRead,
  saveTagDraft,
  loadTagDraft,
} from '@/services/tags/tag-service';
import { toast } from '@/hooks/use-toast';
import type { AttachmentType } from '@/constants/tags';
import type { StaffMember, UploadedFile, TagPopupPosition } from './types';

export interface TagDropManagerProps {
  /** Whether tag dropping mode is active */
  isActive?: boolean;
  /** Callback when a tag is created */
  onTagCreated?: (tagId: string) => void;
  /** Callback when tag mode is toggled */
  onModeChange?: (isActive: boolean) => void;
  /** Organization ID for the tags */
  organizationId?: string;
  /** Current page URL for context */
  pageUrl?: string;
}

interface TagDropManagerState {
  isPopupOpen: boolean;
  popupCoords: TagPopupPosition | null;
  isDragging: boolean;
  dragOffset: { x: number; y: number };
  tagComment: string;
  selectedStaff: StaffMember[];
  uploadedFiles: UploadedFile[];
  isRecordingAudio: boolean;
  isRecordingScreen: boolean;
  staffSelectionError: string | null;
  requiresApproval: boolean;
  isUploading: boolean;
  uploadProgress: number;
  isReplyMode: boolean;
  activeConversationId: string | null;
  conversationContext?: string | undefined;
  selectedJob: { id: string; title: string } | null;
  showJobPicker: boolean;
  isDrawingMode: boolean;
  drawingData: string | null;
}

/**
 * Drawing Modal Component
 * Provides a full-screen drawing canvas with toolbar
 */
interface DrawingModalProps {
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
}

interface JobPickerModalProps {
  organizationId?: string | undefined;
  onSelect: (job: { id: string; name: string }) => void;
  onClose: () => void;
}

const JobPickerModal: React.FC<JobPickerModalProps> = ({ organizationId, onSelect, onClose }) => {
  const [query, setQuery] = useState('');
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    let q = supabase
      .from('jobs')
      .select('id, name')
      .is('deleted_at', null)
      .order('name')
      .limit(80);
    if (organizationId) q = q.eq('organization_id', organizationId);
    q.then((res) => {
      setJobs((res.data ?? []) as { id: string; name: string }[]);
      setLoading(false);
    });
  }, [organizationId]);

  const filtered = query.trim()
    ? jobs.filter((j) => j.name.toLowerCase().includes(query.toLowerCase()))
    : jobs;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Briefcase className="h-4 w-4" /> Attach Job
          </DialogTitle>
        </DialogHeader>
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search jobs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto space-y-1">
          {loading && <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No jobs found</p>
          )}
          {filtered.map((job) => (
            <button
              key={job.id}
              type="button"
              className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-accent transition-colors"
              onClick={() => onSelect(job)}
            >
              {job.name}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const DrawingModal: React.FC<DrawingModalProps> = ({ onSave, onCancel }) => {
  const canvasRef = useRef<DrawingCanvasRef | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [drawingState, setDrawingState] = useState<DrawingState>({
    isActive: false,
    tool: 'pencil' as DrawingTool,
    color: '#ef4444',
    lineWidth: 3,
    isSmartShapeEnabled: false,
  });

  // historyTick is intentionally referenced so the canRedo lookup re-runs on
  // every undo/redo button press without us caching it across renders.
  void historyTick
  const canRedo = canvasRef.current?.canRedo() ?? false;

  const handleStateChange = useCallback(<K extends keyof DrawingState>(key: K, value: DrawingState[K]) => {
    setDrawingState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    // captureDrawing(), not toDataURL(): the imperative ref is a plain object
    // spread of the canvas element, and spreading a DOM element does not carry
    // prototype methods — ref.toDataURL is undefined at runtime.
    const dataUrl = canvasRef.current?.captureDrawing?.();
    if (dataUrl) onSave(dataUrl);
  }, [onSave]);

  // Annotations are drawn directly OVER the live page: a transparent
  // full-viewport canvas with a floating toolbar — the recipient sees the
  // strokes projected over the same UI, so arrows point at real elements.
  return (
    <div className="fixed inset-0 z-[10000]">
      <DrawingCanvas
        ref={canvasRef}
        width={window.innerWidth}
        height={window.innerHeight}
        drawingState={drawingState}
        onDrawEnd={() => setHistoryTick(t => t + 1)}
        className="absolute inset-0"
        noBg
      />

      {/* Floating toolbar — one wide strip across the top, matching the
          reply-bar style: tools inline, actions pinned right. */}
      <div className="absolute left-1/2 top-3 z-[10001] flex max-w-[94vw] -translate-x-1/2 flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-2xl border border-slate-200 bg-white/95 px-4 py-2.5 shadow-2xl backdrop-blur">
        <h3 className="text-sm font-bold text-slate-800">Draw on the page</h3>
        <DrawingToolbar
          drawingState={drawingState}
          onStateChange={handleStateChange}
          className="!flex-row !flex-wrap !items-center !gap-x-4 !gap-y-2 !border-0 !bg-transparent !p-0"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { canvasRef.current?.undo(); setHistoryTick(t => t + 1) }}
            title="Undo last stroke"
          >
            <Undo2 className="h-4 w-4 mr-1" />
            Undo
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { canvasRef.current?.redo(); setHistoryTick(t => t + 1) }}
            disabled={!canRedo}
            title="Redo last undone stroke"
          >
            <Redo2 className="h-4 w-4 mr-1" />
            Redo
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            <X className="h-4 w-4 mr-1" />
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave}>
            <Check className="h-4 w-4 mr-1" />
            Save Drawing
          </Button>
        </div>
      </div>
    </div>
  );
};

const initialState: TagDropManagerState = {
  isPopupOpen: false,
  popupCoords: null,
  isDragging: false,
  dragOffset: { x: 0, y: 0 },
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
  conversationContext: undefined,
  selectedJob: null,
  showJobPicker: false,
  isDrawingMode: false,
  drawingData: null,
};

export const TagDropManagerContent: React.FC<TagDropManagerProps> = ({
  isActive = false,
  onTagCreated,
  onModeChange,
  organizationId,
  pageUrl,
}) => {
  const { user } = useAuth();
  const { activeTag, isTagOverlayVisible, showTagOverlay, hideTagOverlay, tagsHidden, setTagsHidden, tagStatusFilter, setTagStatusFilter, tagsMineOnly, setTagsMineOnly } = useTagState();
  const [state, setState] = useState<TagDropManagerState>(initialState);
  const [availableStaff, setAvailableStaff] = useState<StaffMember[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Right-click context menu position — shows "Drop Tag Here" mini menu
  const [rightClickPos, setRightClickPos] = useState<{ x: number; y: number } | null>(null);

  // Fetch available staff on mount
  useEffect(() => {
    const fetchStaff = async () => {
      const result = await getTaggableStaff(organizationId);
      if (result.data) {
        setAvailableStaff(
          result.data.map((s) => ({
            id: s.id,
            name: s.full_name,
            // Conditional spread keeps these absent (not `undefined`) so they
            // satisfy exactOptionalPropertyTypes on StaffMember.
            ...(s.avatar_url ? { avatar_url: s.avatar_url } : {}),
            ...(s.role ? { role: s.role } : {}),
          }))
        );
      }
    };
    fetchStaff();
  }, [organizationId]);

  // Deep link from tag-drop notifications: landing on `<page>?tag=<id>` (the
  // notification's action_url) projects the tag's drawing over the live page
  // and opens the standard tag card (ModernTagOverlay) anchored at the tag's
  // pin coordinates. Reply/close clears both — back to the normal page.
  const location = useLocation();
  const [projectedTag, setProjectedTag] = useState<TagOverlayData | null>(null);
  useEffect(() => {
    const tagId = new URLSearchParams(location.search).get('tag');
    if (!tagId) { setProjectedTag(null); return; }
    let cancelled = false;
    (async () => {
      const { data: tag } = await supabase
        .from('tags')
        .select('id, organization_id, creator_id, page_url, comment, coords, drawing_data, drawing_url, requires_approval, approval_status, timestamp, tag_attachments ( attachment_type, storage_url )')
        .eq('id', tagId)
        .is('deleted_at', null)
        .maybeSingle();
      if (cancelled || !tag) return;

      // No `profiles` table in Looplet — resolve creator name/avatar from the
      // org's taggable-staff list (organization_memberships + auth.users).
      const { data: staff } = await getTaggableStaff(tag.organization_id);
      const creator = staff?.find((s) => s.id === tag.creator_id);

      const attachments = ((tag.tag_attachments as { attachment_type: string; storage_url: string }[] | null) ?? [])
        .map((a) => ({ type: a.attachment_type as AttachmentType, url: a.storage_url }));

      const tagData: TagOverlayData = {
        id: tag.id,
        comment: tag.comment ?? undefined,
        senderName: creator?.full_name || 'Teammate',
        senderAvatar: creator?.avatar_url ?? undefined,
        time: tag.timestamp ? new Date(Number(tag.timestamp)).toLocaleString() : undefined,
        coordinates: (tag.coords as { x: number; y: number } | null) ?? undefined,
        mediaType: attachments[0]?.type,
        drawingData: tag.drawing_data ?? undefined,
        drawingUrl: tag.drawing_url ?? undefined,
        attachments,
        approvalStatus: (tag.approval_status as 'pending' | 'approved' | 'rejected' | null) ?? undefined,
        requiresApproval: !!tag.requires_approval,
        creatorId: tag.creator_id,
        organizationId: tag.organization_id,
        pageUrl: tag.page_url,
      };
      setProjectedTag(tagData);
      showTagOverlay(tagData);
      if (user?.id) void markTagAsRead(tagId, user.id);
    })();
    return () => { cancelled = true; };
    // location.key (not just .search) so re-clicking "View tag" for the same
    // tag re-opens the overlay after it was dismissed.
  }, [location.key, location.search, user?.id, showTagOverlay]);

  // Handle page click to open popup when in active mode
  useEffect(() => {
    if (!isActive) return;

    const handlePageClick = (e: MouseEvent) => {
      // Ignore clicks on the popup itself
      const target = e.target as HTMLElement;
      if (target.closest('.tag-popup-content') || target.closest('.tag-overlay')) {
        return;
      }

      // Open popup at click position
      setState((prev) => ({
        ...prev,
        isPopupOpen: true,
        popupCoords: {
          x: Math.min(e.clientX, window.innerWidth - 600),
          y: Math.min(e.clientY, window.innerHeight - 500),
        },
      }));

      // Disable active mode after placing
      onModeChange?.(false);
    };

    document.addEventListener('click', handlePageClick);
    return () => document.removeEventListener('click', handlePageClick);
  }, [isActive, onModeChange]);

  // Close popup
  const handleClose = useCallback(() => {
    setState(() => ({ ...initialState }));
  }, []);

  // Handle popup dragging
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    setState((prev) => {
      if (!prev.popupCoords) return prev;
      return {
        ...prev,
        isDragging: true,
        dragOffset: {
          x: clientX - prev.popupCoords.x,
          y: clientY - prev.popupCoords.y,
        },
      };
    });
  }, []);

  useEffect(() => {
    if (!state.isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      setState((prev) => ({
        ...prev,
        popupCoords: {
          x: e.clientX - prev.dragOffset.x,
          y: e.clientY - prev.dragOffset.y,
        },
      }));
    };

    const handleMouseUp = () => {
      setState((prev) => ({ ...prev, isDragging: false }));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [state.isDragging]);

  // Custom event: other menus (FeatureContextMenu, Sidebar) dispatch this to
  // open the popup directly at a given position without a second contextmenu handler.
  useEffect(() => {
    const onDropAt = (e: Event) => {
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail
      setState((prev) => ({
        ...prev,
        isPopupOpen: true,
        popupCoords: {
          x: Math.min(x, window.innerWidth - 600),
          y: Math.min(y, window.innerHeight - 500),
        },
      }))
    }
    window.addEventListener('looplet:drop-tag-at', onDropAt as EventListener)
    return () => window.removeEventListener('looplet:drop-tag-at', onDropAt as EventListener)
  }, [])

  // Fallback global right-click → "Drop Tag Here" mini menu.
  // Only fires when no other context menu (FeatureContextMenu, Sidebar, list rows)
  // would handle the click — those menus include "Drop Tag Here" themselves.
  useEffect(() => {
    const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'A', 'BUTTON', 'OPTION'])
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (
        SKIP_TAGS.has(target.tagName) ||
        target.isContentEditable ||
        target.closest('[data-tour]') ||          // FeatureContextMenu owns this
        target.closest('[data-sidebar-nav-item]') || // Sidebar UniversalContextMenu owns this
        target.closest('[data-row-index]') ||     // List rows (ListRow) — RightClickMenu owns this
        target.closest('.tag-popup-content') ||
        target.closest('.tag-overlay') ||
        target.closest('[data-no-tag-drop]')
      ) return
      e.preventDefault()
      setRightClickPos({ x: e.clientX, y: e.clientY })
    }
    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [])

  const handleRightClickDrop = useCallback(() => {
    if (!rightClickPos) return
    setState((prev) => ({
      ...prev,
      isPopupOpen: true,
      popupCoords: {
        x: Math.min(rightClickPos.x, window.innerWidth - 600),
        y: Math.min(rightClickPos.y, window.innerHeight - 500),
      },
    }))
    setRightClickPos(null)
  }, [rightClickPos])

  // Comment change
  const handleCommentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setState((prev) => ({ ...prev, tagComment: e.target.value }));
    },
    []
  );

  // Staff selection
  const handleStaffSelect = useCallback((staff: StaffMember) => {
    setState((prev) => {
      const isSelected = prev.selectedStaff.some((s) => s.id === staff.id);
      return {
        ...prev,
        selectedStaff: isSelected
          ? prev.selectedStaff.filter((s) => s.id !== staff.id)
          : [...prev.selectedStaff, staff],
        staffSelectionError: null,
      };
    });
  }, []);

  // Approval toggle
  const handleApprovalChange = useCallback((checked: boolean) => {
    setState((prev) => ({ ...prev, requiresApproval: checked }));
  }, []);

  // Screen recording toggle
  const handleToggleScreenRecord = useCallback(async () => {
    if (state.isRecordingScreen) {
      // Stop recording
      mediaRecorderRef.current?.stop();
      setState((prev) => ({ ...prev, isRecordingScreen: false }));
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          setState((prev) => ({
            ...prev,
            uploadedFiles: [
              ...prev.uploadedFiles,
              { type: 'video', previewUrl: url, file: blob },
            ],
            isRecordingScreen: false,
          }));
          stream.getTracks().forEach((t) => t.stop());
        };

        recorder.start();
        mediaRecorderRef.current = recorder;
        setState((prev) => ({ ...prev, isRecordingScreen: true }));
      } catch (error) {
        console.error('Screen recording failed:', error);
        toast({ title: 'Failed to start screen recording', variant: 'destructive' });
      }
    }
  }, [state.isRecordingScreen]);

  // Image upload
  const handleImageUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;

      Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          setState((prev) => ({
            ...prev,
            uploadedFiles: [
              ...prev.uploadedFiles,
              {
                type: 'image',
                previewUrl: reader.result as string,
                file,
              },
            ],
          }));
        };
        reader.readAsDataURL(file);
      });

      e.target.value = '';
    },
    []
  );

  // Audio recording
  const handleAudioRecord = useCallback(async () => {
    if (state.isRecordingAudio) {
      mediaRecorderRef.current?.stop();
      setState((prev) => ({ ...prev, isRecordingAudio: false }));
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);

        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
        recorder.onstop = () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const url = URL.createObjectURL(blob);
          setState((prev) => ({
            ...prev,
            uploadedFiles: [
              ...prev.uploadedFiles,
              { type: 'audio', previewUrl: url, file: blob },
            ],
            isRecordingAudio: false,
          }));
          stream.getTracks().forEach((t) => t.stop());
        };

        recorder.start();
        mediaRecorderRef.current = recorder;
        setState((prev) => ({ ...prev, isRecordingAudio: true }));
      } catch (error) {
        console.error('Audio recording failed:', error);
        toast({ title: 'Failed to start audio recording', variant: 'destructive' });
      }
    }
  }, [state.isRecordingAudio]);

  // Paint/Drawing mode
  const handlePaintClick = useCallback(() => {
    setState((prev) => ({ ...prev, isDrawingMode: true }));
  }, []);

  const handleDrawingSave = useCallback((dataUrl: string) => {
    setState((prev) => ({
      ...prev,
      drawingData: dataUrl,
      uploadedFiles: [
        ...prev.uploadedFiles,
        { type: 'drawing', previewUrl: dataUrl },
      ],
      isDrawingMode: false,
    }));
  }, []);

  const handleDrawingCancel = useCallback(() => {
    setState((prev) => ({ ...prev, isDrawingMode: false }));
  }, []);

  // Save tag
  const handleSaveTag = useCallback(async () => {
    if (state.selectedStaff.length === 0) {
      setState((prev) => ({
        ...prev,
        staffSelectionError: 'Please select at least one staff member',
      }));
      return;
    }

    if (!user?.id) {
      toast({ title: 'Please log in to create tags', variant: 'destructive' });
      return;
    }

    setState((prev) => ({ ...prev, isUploading: true, uploadProgress: 10 }));

    try {
      // Prepare attachments (in real implementation, upload to storage first)
      const attachments = state.uploadedFiles
        .filter((f) => f.type !== 'drawing')
        .map((f) => ({
          type: f.type,
          url: f.previewUrl, // In production, this would be a storage URL
        }));

      setState((prev) => ({ ...prev, uploadProgress: 50 }));

      const result = await createTag({
        creatorId: user.id,
        comment: state.tagComment,
        taggedStaffIds: state.selectedStaff.map((s) => s.id),
        attachments,
        coords: state.popupCoords || { x: 0, y: 0 },
        requiresApproval: state.requiresApproval,
        pageUrl: pageUrl || window.location.pathname,
        // Conditional spreads keep optional fields absent (not `undefined`) so
        // they satisfy exactOptionalPropertyTypes on CreateTagPayload.
        ...(state.drawingData ? { drawingData: state.drawingData } : {}),
        ...(organizationId ? { organizationId } : {}),
      });

      setState((prev) => ({ ...prev, uploadProgress: 100 }));

      if (result.error) {
        toast({ title: result.error.message, variant: 'destructive' });
      } else if (result.data) {
        if (state.selectedJob?.id) {
          await supabase
            .from('tags')
            .update({ job_id: state.selectedJob.id })
            .eq('id', result.data.id);
        }
        toast({ title: 'Tag created successfully!' });
        onTagCreated?.(result.data.id);
        handleClose();
      }
    } catch (error) {
      console.error('Error creating tag:', error);
      toast({ title: 'Failed to create tag', variant: 'destructive' });
    } finally {
      setState((prev) => ({ ...prev, isUploading: false, uploadProgress: 0 }));
    }
  }, [
    state.selectedStaff,
    state.tagComment,
    state.uploadedFiles,
    state.popupCoords,
    state.drawingData,
    state.requiresApproval,
    state.selectedJob,
    user,
    pageUrl,
    organizationId,
    onTagCreated,
    handleClose,
  ]);

  // Save draft
  const handleSaveDraft = useCallback(async () => {
    if (!user?.id || !organizationId) {
      toast({ title: 'Unable to save draft', variant: 'destructive' });
      return;
    }

    const result = await saveTagDraft({
      userId: user.id,
      organizationId,
      pageUrl: pageUrl || window.location.pathname,
      comment: state.tagComment,
      taggedStaffIds: state.selectedStaff.map((s) => s.id),
      requiresApproval: state.requiresApproval,
      ...(state.drawingData ? { drawingData: state.drawingData } : {}),
      ...(state.selectedJob?.id ? { jobId: state.selectedJob.id } : {}),
    });

    if (result.error) {
      toast({ title: result.error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Draft saved' });
    }
  }, [
    user,
    organizationId,
    pageUrl,
    state.tagComment,
    state.drawingData,
    state.selectedStaff,
    state.requiresApproval,
    state.selectedJob,
  ]);

  // Load draft
  const handleLoadDraft = useCallback(async () => {
    if (!user?.id) return;

    const result = await loadTagDraft(
      user.id,
      pageUrl || window.location.pathname
    );

    if (result.data) {
      setState((prev) => ({
        ...prev,
        tagComment: result.data?.comment || '',
        drawingData: result.data?.drawingData || null,
        selectedStaff: availableStaff.filter((s) =>
          result.data?.taggedStaffIds?.includes(s.id)
        ),
        requiresApproval: result.data?.requiresApproval || false,
        selectedJob: result.data?.jobId
          ? { id: result.data.jobId, title: 'Loaded Job' }
          : null,
      }));
      toast({ title: 'Draft loaded' });
    } else if (result.error) {
      toast({ title: result.error.message, variant: 'destructive' });
    } else {
      toast({ title: 'No draft found' });
    }
  }, [user, pageUrl, availableStaff]);

  // Attach job
  const handleAttachJob = useCallback(() => {
    setState((prev) => ({ ...prev, showJobPicker: true }));
  }, []);

  const handleJobSelected = useCallback((job: { id: string; name: string }) => {
    setState((prev) => ({ ...prev, selectedJob: { id: job.id, title: job.name }, showJobPicker: false }));
  }, []);

  const handleJobPickerClose = useCallback(() => {
    setState((prev) => ({ ...prev, showJobPicker: false }));
  }, []);

  // Deselect job
  const handleDeselectJob = useCallback(() => {
    setState((prev) => ({ ...prev, selectedJob: null }));
  }, []);

  // Remove file
  const handleRemoveFile = useCallback((index: number) => {
    setState((prev) => ({
      ...prev,
      uploadedFiles: prev.uploadedFiles.filter((_, i) => i !== index),
    }));
  }, []);

  // Handle tag reply
  const handleReply = useCallback((tagId: string | number, creator?: { id: string; name: string }) => {
    setState((prev) => ({
      ...prev,
      isReplyMode: true,
      activeConversationId: String(tagId),
      isPopupOpen: true,
      // A reply already knows its recipient — preselect the tag's creator so
      // the staff picker can stay collapsed (don't notify yourself).
      selectedStaff: creator && creator.id !== user?.id
        ? [{ id: creator.id, name: creator.name }]
        : prev.selectedStaff,
      popupCoords: {
        x: window.innerWidth / 2 - 290,
        y: window.innerHeight / 2 - 250,
      },
    }));
    hideTagOverlay();
  }, [hideTagOverlay, user?.id]);

  // Handle tag delete
  const handleDelete = useCallback(
    async (tagId: string | number) => {
      const result = await deleteTag(String(tagId));
      if (result.error) {
        toast({ title: result.error.message, variant: 'destructive' });
      } else {
        toast({ title: 'Tag deleted' });
      }
    },
    []
  );

  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Right-click mini menu */}
      {rightClickPos && (
        <>
          {/* Backdrop — click outside to dismiss */}
          <div
            className="fixed inset-0 z-[9980]"
            onMouseDown={() => setRightClickPos(null)}
          />
          <div
            className="fixed z-[9981] min-w-[160px] overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 py-1.5 shadow-2xl shadow-slate-900/15 backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/95"
            style={{
              left: Math.min(rightClickPos.x, window.innerWidth - 180),
              top: Math.min(rightClickPos.y, window.innerHeight - 60),
            }}
          >
            <button
              type="button"
              onClick={handleRightClickDrop}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-[13px] font-semibold text-slate-700 transition-colors hover:bg-blue-50 hover:text-blue-700 dark:text-slate-200 dark:hover:bg-blue-500/10 dark:hover:text-blue-300"
            >
              <Tag className="h-3.5 w-3.5 text-blue-500" />
              Drop Tag Here
            </button>
          </div>
        </>
      )}

      {/* Cursor indicator when active */}
      {isActive && (
        <div
          className="fixed inset-0 z-[9990] pointer-events-none"
          style={{ cursor: 'crosshair' }}
        >
          <div className="absolute inset-0 bg-blue-500/5" />
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 flex-wrap max-w-[95vw] justify-center">
            <div className="bg-blue-600 text-white px-4 py-2 rounded-full text-sm font-medium shadow-lg">
              Click anywhere to drop a tag
            </div>
            <button
              type="button"
              onClick={() => setTagsHidden(!tagsHidden)}
              className="pointer-events-auto bg-white/95 hover:bg-white text-slate-700 px-3 py-2 rounded-full text-xs font-bold shadow-lg flex items-center gap-1.5 border border-slate-200"
              title={tagsHidden ? 'Show existing tags' : 'Hide existing tags'}
            >
              {tagsHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {tagsHidden ? 'Show tags' : 'Hide tags'}
            </button>
            <button
              type="button"
              onClick={() => setTagsMineOnly(!tagsMineOnly)}
              className={cn(
                'pointer-events-auto px-3 py-2 rounded-full text-xs font-bold shadow-lg flex items-center gap-1.5 border transition-colors',
                tagsMineOnly
                  ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
                  : 'bg-white/95 hover:bg-white text-slate-700 border-slate-200',
              )}
              title={tagsMineOnly ? 'Show everyone\'s tags' : 'Show only my tags'}
            >
              <User className="h-3.5 w-3.5" />
              {tagsMineOnly ? 'Mine' : 'All authors'}
            </button>
            <div className="pointer-events-auto bg-white/95 rounded-full shadow-lg border border-slate-200 flex items-center gap-0.5 p-0.5">
              {(['all', 'pending', 'approved', 'rejected', 'no_approval'] as const).map((f) => {
                const label = f === 'no_approval' ? 'No approval' : f.charAt(0).toUpperCase() + f.slice(1);
                const active = tagStatusFilter === f;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setTagStatusFilter(f)}
                    className={cn(
                      'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors',
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Deep-linked tag: drawing projected over the live page while the tag
          card is open — closing the card or replying clears the arrows. */}
      {projectedTag && isTagOverlayVisible && (projectedTag.drawingUrl || projectedTag.drawingData) && (
        <img
          src={projectedTag.drawingUrl || projectedTag.drawingData}
          alt=""
          className="pointer-events-none fixed inset-0 z-[9960] h-full w-full select-none"
        />
      )}

      {/* Tag Drop Popup — hidden while drawing so the page underneath is fully visible */}
      <TagDropPopup
        isOpen={state.isPopupOpen && !state.isDrawingMode}
        coords={state.popupCoords}
        isDragging={state.isDragging}
        tagComment={state.tagComment}
        selectedStaff={state.selectedStaff}
        uploadedFiles={state.uploadedFiles}
        isRecordingAudio={state.isRecordingAudio}
        isRecordingScreen={state.isRecordingScreen}
        staffSelectionError={state.staffSelectionError}
        requiresApproval={state.requiresApproval}
        isUploading={state.isUploading}
        uploadProgress={state.uploadProgress}
        isReplyMode={state.isReplyMode}
        activeConversationId={state.activeConversationId}
        conversationContext={state.conversationContext}
        selectedJob={state.selectedJob}
        availableStaff={availableStaff}
        onClose={handleClose}
        onDragStart={handleDragStart}
        onCommentChange={handleCommentChange}
        onStaffSelect={handleStaffSelect}
        onApprovalChange={handleApprovalChange}
        onToggleScreenRecord={handleToggleScreenRecord}
        onImageUpload={handleImageUpload}
        onAudioRecord={handleAudioRecord}
        onPaintClick={handlePaintClick}
        onSaveTag={handleSaveTag}
        onSaveDraft={handleSaveDraft}
        onAttachJob={handleAttachJob}
        onLoadDraft={handleLoadDraft}
        onDeselectJob={handleDeselectJob}
        onRemoveFile={handleRemoveFile}
      />

      {/* Drawing Canvas Modal */}
      {state.isDrawingMode && (
        <DrawingModal
          onSave={handleDrawingSave}
          onCancel={handleDrawingCancel}
        />
      )}

      {/* Job Picker Modal */}
      {state.showJobPicker && (
        <JobPickerModal
          organizationId={organizationId}
          onSelect={handleJobSelected}
          onClose={handleJobPickerClose}
        />
      )}

      {/* Tag Overlay — Reply preselects the tag's creator */}
      <ModernTagOverlay
        onReply={(tagId) =>
          handleReply(
            tagId,
            activeTag?.creatorId
              ? { id: activeTag.creatorId, name: activeTag.senderName || 'Teammate' }
              : undefined,
          )
        }
        onDelete={handleDelete}
        className="tag-overlay"
      />
    </>
  );
};

/**
 * TagDropManager with built-in Provider
 */
export const TagDropManager: React.FC<TagDropManagerProps> = (props) => {
  return (
    <TagStateProvider>
      <TagDropManagerContent {...props} />
    </TagStateProvider>
  );
};

export default TagDropManager;
