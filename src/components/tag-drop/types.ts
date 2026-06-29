/**
 * Tag Drop System Types
 */

export interface Point {
  x: number;
  y: number;
  timestamp?: number;
}

export type DrawingTool = 'pencil' | 'eraser' | 'line' | 'arrow' | 'rectangle' | 'circle' | 'star' | 'smart_shape' | 'job_tag' | 'ruler';

export interface DrawingState {
  isActive: boolean;
  tool: DrawingTool;
  color: string;
  lineWidth: number;
  isDrawingOnPage?: boolean;
  isSmartShapeEnabled?: boolean;
}

export interface JobTag {
  id: string;
  x: number;
  y: number;
  content: string;
  isAiGenerated?: boolean;
}

export interface DrawingAction {
  tool: DrawingTool;
  path: Point[];
  color: string;
  lineWidth: number;
  timestamp: number;
}

// ============================================================================
// Tag Drop Panel Types
// ============================================================================

export type PanelSize = 'quarter' | 'half' | 'custom' | 'minimized';

export type ActiveTab = 'ai' | 'team' | 'trades' | 'tasks' | 'calendar' | 'comments' | 'ai-buis' | 'settings';

export type PanelDrawingTool = 'pencil' | 'circle' | 'rectangle' | 'arrow' | 'highlight' | 'eraser' | 'text' | 'magic' | 'lasso';

export interface TagMarker {
  id: string;
  x: number;
  y: number;
  timestamp: number;
  drawingData?: string;
  drawingUrl?: string;
  comment?: string;
  senderName?: string;
  senderAvatar?: string;
  mediaType?: 'image' | 'audio' | 'drawing' | 'video';
  attachments?: {
    type: 'image' | 'audio' | 'drawing' | 'video';
    url: string;
  }[];
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  requiresApproval?: boolean;
  creatorId?: string;
}

export interface StaffMember {
  id: string;
  name: string;
  email?: string;
  full_name?: string;
  avatar_url?: string;
  role?: string;
  isSystemTag?: boolean;
}

export interface UploadedFile {
  file?: File | Blob;
  previewUrl: string;
  type: 'image' | 'audio' | 'drawing' | 'video';
  supabaseUrl?: string;
}

export interface TagPopupPosition {
  x: number;
  y: number;
}

export interface TagDropManagerProps {
  isTagDropMode: boolean;
  onTagCreated?: (tag: TagMarker) => void;
  onReply?: (tagId: string | number) => void;
  children: React.ReactNode;
  className?: string;
  pageId?: string;
  organizationId?: string;
}

export interface TagDropPopupProps {
  isOpen: boolean;
  coords: TagPopupPosition | null;
  isDragging: boolean;
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
  conversationContext?: string;
  selectedJob: { id: string; title: string } | null;
  availableStaff: StaffMember[];
  onClose: () => void;
  onDragStart: (e: React.MouseEvent) => void;
  onCommentChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onStaffSelect: (staff: StaffMember) => void;
  onApprovalChange: (checked: boolean) => void;
  onToggleScreenRecord: () => void;
  onImageUpload: () => void;
  onAudioRecord: () => void;
  onPaintClick: () => void;
  onSaveTag: () => void;
  onSaveDraft: () => void;
  onAttachJob: () => void;
  onLoadDraft: () => void;
  onDeselectJob: () => void;
  onRemoveFile: (index: number) => void;
}
