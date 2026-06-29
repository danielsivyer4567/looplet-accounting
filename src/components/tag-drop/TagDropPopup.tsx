import React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/constants/z-index';
import { isAccountant } from '@/constants/tags';
import {
  X,
  Users,
  Upload,
  Mic,
  Video,
  Palette,
  AlertCircle,
  Briefcase,
  Archive,
  Send,
  Check,
  FileText,
  MapPin,
  MessageSquare,
  Monitor,
  Image as ImageIcon,
  ChevronDown,
} from 'lucide-react';
import type { StaffMember, UploadedFile, TagPopupPosition } from './types';

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
  conversationContext?: string | undefined;
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

/**
 * TagDropPopup - Modal for creating tags/notifications with attachments
 */
export const TagDropPopup: React.FC<TagDropPopupProps> = ({
  isOpen,
  coords,
  isDragging,
  tagComment,
  selectedStaff,
  uploadedFiles,
  isRecordingAudio,
  isRecordingScreen,
  staffSelectionError,
  requiresApproval,
  isUploading,
  uploadProgress,
  isReplyMode,
  activeConversationId,
  conversationContext,
  selectedJob,
  availableStaff,
  onClose,
  onDragStart,
  onCommentChange,
  onStaffSelect,
  onApprovalChange,
  onToggleScreenRecord,
  onImageUpload,
  onAudioRecord,
  onPaintClick,
  onSaveTag,
  onSaveDraft,
  onAttachJob,
  onLoadDraft,
  onDeselectJob,
  onRemoveFile,
}) => {
  // Staff picker collapses to a summary row in reply mode — the reply already
  // knows its recipient (preselected by handleReply). Fresh tags start open.
  const [staffOpen, setStaffOpen] = React.useState(!isReplyMode);
  React.useEffect(() => {
    if (isOpen) setStaffOpen(!isReplyMode || selectedStaff.length === 0);
    // Only re-evaluate when the popup opens / switches mode — not on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isReplyMode]);

  if (!isOpen) return null;

  // Compact reply bar — replies skip the full two-panel modal: a wide strip at
  // the top of the screen with the reply box, attachments and send/cancel.
  // The recipient is already known (preselected tag creator); the full modal
  // remains for fresh tag drops.
  if (isReplyMode) {
    return (
      <div
        className="tag-popup-content fixed left-1/2 top-3 w-[min(880px,94vw)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white shadow-2xl pointer-events-auto dark:border-white/10 dark:bg-slate-900"
        style={{ zIndex: Z_INDEX.NOTIFICATION_PANEL + 50 }}
      >
        {/* Header: recipient + context snippet */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400">
            <MessageSquare className="h-3.5 w-3.5" />
          </div>
          <p className="shrink-0 text-sm font-bold text-slate-800 dark:text-slate-100">
            Reply to {selectedStaff[0]?.name ?? 'team'}
          </p>
          {conversationContext && (
            <p className="min-w-0 truncate text-xs text-slate-500">— "{conversationContext}"</p>
          )}
          <button
            type="button"
            onClick={() => setStaffOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Recipients
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', staffOpen && 'rotate-180')}
            />
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            onClick={onClose}
            aria-label="Close reply"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Recipients dropdown (collapsed by default — reply knows its target) */}
        {staffOpen && (
          <div className="mx-4 mt-2 max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
            {availableStaff.map((staff) => {
              const accountant = isAccountant(staff);
              const selected = selectedStaff.some((s) => s.id === staff.id);
              return (
                <div
                  key={staff.id}
                  data-accountant-row={accountant ? 'true' : undefined}
                  className={cn(
                    'flex cursor-pointer items-center justify-between rounded-lg p-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800',
                    accountant &&
                      'border border-blue-200 bg-blue-50/80 hover:bg-blue-100 dark:border-blue-400/30 dark:bg-blue-500/10 dark:hover:bg-blue-500/15',
                  )}
                  onClick={() => onStaffSelect(staff)}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-slate-600 dark:text-slate-300">
                      {staff.name}
                    </span>
                    {accountant && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-500/20 dark:text-blue-200">
                        <Check className="h-2.5 w-2.5" />
                        Accountant
                      </span>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Select ${staff.name}`}
                    className="h-4 w-4 rounded border-slate-300 accent-slate-600 dark:border-slate-600"
                    checked={selected}
                    onChange={() => onStaffSelect(staff)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Quick reply box */}
        <div className="px-4 pt-2">
          <textarea
            autoFocus
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:ring-1 focus:ring-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            placeholder="Type your reply — ↵ to send"
            rows={2}
            value={tagComment}
            onChange={onCommentChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSaveTag();
              }
            }}
          />
        </div>

        {/* Attachment chips */}
        {uploadedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-2">
            {uploadedFiles.map((f, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {f.type === 'image' && f.previewUrl ? (
                  <img src={f.previewUrl} alt="" className="h-5 w-5 rounded object-cover" />
                ) : null}
                {f.type}
                <button
                  type="button"
                  onClick={() => onRemoveFile(i)}
                  className="rounded-full p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700"
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {staffSelectionError && (
          <p className="flex items-center gap-1 px-4 pt-2 text-xs text-red-500">
            <AlertCircle className="h-3 w-3" /> Please select at least one staff member
          </p>
        )}

        {/* Attachments + actions */}
        <div className="flex items-center gap-1.5 px-4 py-3">
          {[
            {
              icon: Monitor,
              label: 'Screen',
              onClick: onToggleScreenRecord,
              active: isRecordingScreen,
            },
            { icon: ImageIcon, label: 'Image', onClick: onImageUpload, active: false },
            { icon: Mic, label: 'Voice', onClick: onAudioRecord, active: isRecordingAudio },
            { icon: Palette, label: 'Paint', onClick: onPaintClick, active: false },
          ].map(({ icon: Icon, label, onClick, active }) => (
            <button
              key={label}
              type="button"
              onClick={onClick}
              title={label}
              className={cn(
                'flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                active
                  ? 'animate-pulse border-red-300 bg-red-50 text-red-600'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} className="rounded-xl">
              <X className="mr-1 h-3.5 w-3.5" /> Cancel
            </Button>
            <Button size="sm" onClick={onSaveTag} disabled={isUploading} className="rounded-xl">
              <Send className="mr-1 h-3.5 w-3.5" />{' '}
              {isUploading ? `Uploading ${uploadProgress}%` : 'Send Reply'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!coords) return null;

  return (
    <div
      className={cn(
        'tag-popup-content fixed bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-[90vw] sm:w-[580px] flex overflow-hidden pointer-events-auto',
        isDragging ? 'cursor-move' : 'cursor-default',
      )}
      style={{
        zIndex: Z_INDEX.NOTIFICATION_PANEL + 50,
        left: `${coords.x}px`,
        top: `${coords.y}px`,
      }}
    >
      {/* Left Panel - Branding */}
      <div
        className="w-56 bg-gradient-to-br from-blue-600 via-primary-700 to-slate-900 flex flex-col justify-between relative overflow-hidden text-left shadow-2xl cursor-move"
        onMouseDown={onDragStart}
      >
        <div className="relative z-10 p-6 flex flex-col h-full">
          <div className="relative w-14 h-14 mb-6">
            <div className="w-full h-full bg-white/20 rounded-xl flex items-center justify-center">
              <span className="text-2xl font-bold text-white">L</span>
            </div>
          </div>

          <div className="mt-auto pb-2">
            <h3 className="text-white font-bold text-[22px] leading-[1.12] tracking-tight font-sans text-left drop-shadow-md">
              Tag.
              <br />
              Notify.
              <br />
              <span className="whitespace-nowrap">
                Collaborate.
                <span className="text-emerald-400 font-normal inline-block ml-1">✓</span>
              </span>
            </h3>
          </div>
        </div>

        <div className="relative z-10 bg-black/20 backdrop-blur-md border-t border-white/5 p-4 text-center">
          <span className="text-white/90 font-medium text-lg tracking-wide">Looplet</span>
        </div>
      </div>

      {/* Right Panel - Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div>
            <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <div
                className={`h-8 w-8 rounded-xl flex items-center justify-center ${isReplyMode ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400' : 'bg-primary/10 text-primary'}`}
              >
                {isReplyMode ? (
                  <MessageSquare className="h-4 w-4" />
                ) : (
                  <MapPin className="h-4 w-4" />
                )}
              </div>
              {isReplyMode ? 'Reply' : 'Tag Drop'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {isReplyMode ? 'Continue the conversation' : 'Notify team members with context'}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 rounded-full transition-all"
            onClick={onClose}
            aria-label="Close tag popup"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col p-5 gap-4 bg-transparent overflow-y-auto max-h-[min(640px,78vh)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-200 dark:[&::-webkit-scrollbar-thumb]:bg-white/10">
          <div className="space-y-3">
            {/* Conversation Context */}
            {isReplyMode && activeConversationId && (
              <div className="bg-blue-900/30 border border-blue-400/50 rounded-lg p-2 backdrop-blur-sm">
                <div className="text-xs font-semibold text-blue-300 mb-1">
                  Replying to conversation
                </div>
                <div className="max-h-10 overflow-y-auto">
                  <div className="text-xs text-blue-200 truncate">
                    {conversationContext || 'Previous message'}
                  </div>
                </div>
              </div>
            )}

            {/* Comment Input */}
            <div className="space-y-1.5">
              <textarea
                className="w-full p-3 text-sm text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-xl resize-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400 bg-slate-50 dark:bg-slate-800 transition-all placeholder:text-slate-400"
                placeholder={isReplyMode ? 'Reply to conversation...' : 'Add your comment...'}
                rows={3}
                value={tagComment}
                onChange={onCommentChange}
              />
            </div>

            {/* Staff Selection — collapsible. In reply mode it starts collapsed
                showing who the reply goes to (preselected); expand to change. */}
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setStaffOpen((v) => !v)}
                className="w-full flex items-center justify-between rounded-lg px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {isReplyMode ? 'Sending to' : 'Notify Staff'}{' '}
                  <span className="text-red-500">*</span>
                </span>
                <span className="flex items-center gap-1.5 min-w-0">
                  {!staffOpen && (
                    <span className="truncate max-w-[200px] text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                      {selectedStaff.length > 0
                        ? selectedStaff.map((s) => s.name).join(', ')
                        : 'Choose…'}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
                      staffOpen && 'rotate-180',
                    )}
                  />
                </span>
              </button>
              {staffOpen && (
                <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-2 bg-white dark:bg-slate-900">
                  <div className="space-y-1">
                    {availableStaff.map((staff) => {
                      const accountant = isAccountant(staff);
                      const selected = selectedStaff.some((s) => s.id === staff.id);
                      return (
                        <div
                          key={staff.id}
                          data-accountant-row={accountant ? 'true' : undefined}
                          className={cn(
                            'flex items-center justify-between p-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer',
                            accountant &&
                              'border border-blue-200 bg-blue-50/80 hover:bg-blue-100 dark:border-blue-400/30 dark:bg-blue-500/10 dark:hover:bg-blue-500/15',
                          )}
                          onClick={() => onStaffSelect(staff)}
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-slate-600 dark:text-slate-300">
                              {staff.name}
                            </span>
                            {accountant && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-500/20 dark:text-blue-200">
                                <Check className="h-2.5 w-2.5" />
                                Accountant
                              </span>
                            )}
                          </span>
                          <input
                            type="checkbox"
                            aria-label={`Select ${staff.name}`}
                            className="h-4 w-4 text-slate-600 rounded border-slate-300 dark:border-slate-600 focus:ring-slate-400 accent-slate-600"
                            checked={selected}
                            onChange={() => onStaffSelect(staff)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      );
                    })}
                    {/* @Looplet AI assistant */}
                    <div
                      className="flex items-center justify-between p-1.5 hover:bg-gradient-to-r hover:from-primary-50 hover:to-primary-50 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer border-t border-dashed border-slate-200 dark:border-slate-700 mt-1 pt-1.5"
                      onClick={() => onStaffSelect({ id: 'looplet-ai', name: '@Looplet' })}
                    >
                      <span className="text-xs font-medium text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-primary-600 flex items-center gap-1.5">
                        <span className="w-4 h-4 rounded-full bg-gradient-to-r from-primary-500 to-primary-500 flex items-center justify-center text-[8px] text-white font-bold">
                          AI
                        </span>
                        @Looplet
                      </span>
                      <input
                        type="checkbox"
                        aria-label="Select @Looplet AI assistant"
                        className="h-4 w-4 text-primary-600 rounded border-primary-300 dark:border-primary-600 focus:ring-primary-400 accent-primary-600"
                        checked={selectedStaff.some((s) => s.id === 'looplet-ai')}
                        onChange={() => onStaffSelect({ id: 'looplet-ai', name: '@Looplet' })}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  </div>
                  {selectedStaff.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-slate-200">
                      {selectedStaff.map((s) => (
                        <span
                          key={s.id}
                          className="bg-gradient-to-r from-blue-100 to-blue-50 text-blue-700 text-xs px-2.5 py-1 rounded-full border border-blue-200 font-medium"
                        >
                          {s.name.split(' ')[0]}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {staffSelectionError && (
                <p className="text-red-500 text-xs flex items-center gap-1 mt-2 bg-red-50 p-2 rounded-lg">
                  <AlertCircle className="h-3 w-3" /> Please select at least one staff member
                </p>
              )}
            </div>

            {/* Approval Switch */}
            <div className="flex items-center justify-between py-2 px-1">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Request Approval
              </span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  aria-label="Request Approval"
                  className="sr-only peer"
                  checked={requiresApproval}
                  onChange={(e) => onApprovalChange(e.target.checked)}
                />
                <div
                  className={cn(
                    'w-8 h-4 rounded-full peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300',
                    requiresApproval ? 'bg-green-500' : 'bg-red-500',
                    "peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all",
                  )}
                />
              </label>
            </div>

            {/* Media Features */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                <Upload className="h-3 w-3" />
                Attachments
              </label>

              {/* File Previews */}
              {uploadedFiles.length > 0 && (
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {uploadedFiles.map((uploadedFile, index) => (
                    <div key={index} className="relative group">
                      {uploadedFile.type === 'image' && (
                        <img
                          src={uploadedFile.previewUrl}
                          alt="Preview"
                          className="w-full h-8 object-cover rounded border border-slate-600"
                        />
                      )}
                      {uploadedFile.type === 'audio' && (
                        <div className="w-full h-8 flex items-center justify-center bg-blue-900/30 rounded border border-blue-500">
                          <Mic className="h-3 w-3 text-blue-400" />
                        </div>
                      )}
                      {uploadedFile.type === 'video' && (
                        <div className="w-full h-8 flex items-center justify-center bg-green-900/30 rounded border border-green-500">
                          <Video className="h-3 w-3 text-green-400" />
                        </div>
                      )}
                      {uploadedFile.type === 'drawing' && (
                        <div className="w-full h-8 flex items-center justify-center bg-primary-900/30 rounded border border-primary-500">
                          <Palette className="h-3 w-3 text-primary-400" />
                        </div>
                      )}
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute -top-1 -right-1 h-4 w-4 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => onRemoveFile(index)}
                        aria-label="Remove file"
                      >
                        <X className="h-2 w-2" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Media Action Buttons */}
              <div className="grid grid-cols-4 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 h-16 border rounded-xl transition-all hover:bg-slate-50 dark:hover:bg-slate-800',
                    isRecordingScreen
                      ? 'bg-red-50 border-red-200 text-red-600'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
                  )}
                  onClick={onToggleScreenRecord}
                >
                  <Monitor className="h-4 w-4" />
                  <span className="text-[10px] font-medium">
                    {isRecordingScreen ? 'Stop' : 'Screen'}
                  </span>
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  className="flex flex-col items-center justify-center gap-1 h-16 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 border rounded-xl transition-all hover:bg-slate-50 dark:hover:bg-slate-800"
                  onClick={onImageUpload}
                >
                  <ImageIcon className="h-4 w-4" />
                  <span className="text-[10px] font-medium">Image</span>
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 h-16 border rounded-xl transition-all hover:bg-slate-50 dark:hover:bg-slate-800',
                    isRecordingAudio
                      ? 'bg-red-50 border-red-200 text-red-600'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
                  )}
                  onClick={onAudioRecord}
                >
                  <Mic className="h-4 w-4" />
                  <span className="text-[10px] font-medium">
                    {isRecordingAudio ? 'Stop' : 'Voice'}
                  </span>
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  className="flex flex-col items-center justify-center gap-1 h-16 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 border rounded-xl transition-all hover:bg-slate-50 dark:hover:bg-slate-800"
                  onClick={onPaintClick}
                >
                  <Palette className="h-4 w-4" />
                  <span className="text-[10px] font-medium">Paint</span>
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-50/50 dark:bg-slate-800/30 p-4 space-y-3 flex-shrink-0">
          {/* Upload Progress Bar */}
          {isUploading && (
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <div
                className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={uploadProgress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Upload progress: ${uploadProgress}%`}
              >
                <div
                  className="h-full bg-gradient-to-r from-slate-500 to-slate-600 transition-all duration-300 shadow-sm"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <span className="text-xs font-bold">{uploadProgress}%</span>
            </div>
          )}

          {/* Main Actions */}
          {!isUploading && !isReplyMode && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onAttachJob}
                className="h-10 px-4 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 text-slate-600 dark:text-slate-400 font-medium transition-all rounded-lg"
                title="Attach this tag to a specific job"
              >
                <Briefcase className="h-4 w-4 mr-1.5" />
                Attach Job
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={onSaveDraft}
                className="h-10 px-4 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 text-slate-600 dark:text-slate-400 font-medium transition-all rounded-lg"
                title="Save as draft for later use"
              >
                <Archive className="h-4 w-4 mr-1.5" />
                Draft
              </Button>

              <Button
                variant="default"
                size="sm"
                onClick={onSaveTag}
                className="h-10 px-5 bg-slate-900 hover:bg-slate-800 text-white font-medium shadow-sm transition-all rounded-lg flex items-center gap-2 ml-auto"
                title="Notify selected staff members immediately"
              >
                <Send className="h-4 w-4" />
                Notify Staff
                <Check className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Reply Mode Actions */}
          {!isUploading && isReplyMode && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                className="flex-1 h-11 border-2 border-slate-600 hover:border-red-500 hover:bg-red-900/20 text-red-500 font-semibold transition-all"
              >
                <X className="h-4 w-4 mr-1.5" />
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={onSaveTag}
                className="flex-1 h-11 bg-gradient-to-r from-slate-600 to-slate-700 hover:from-slate-500 hover:to-blue-500 text-white font-bold shadow-lg hover:shadow-xl transition-all"
              >
                <Send className="h-4 w-4 mr-1.5" />
                Send Reply
              </Button>
            </div>
          )}

          {/* Utilities Row */}
          {!isUploading && !isReplyMode && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLoadDraft}
                  className="h-8 text-slate-400 hover:text-slate-600 text-xs font-medium"
                  title="Load a previously saved draft"
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Load Draft
                </Button>

                {selectedJob && (
                  <div className="flex items-center gap-1 px-2.5 py-1 bg-teal-50 dark:bg-teal-900/20 rounded-lg border border-teal-200 dark:border-teal-800">
                    <Briefcase className="h-3 w-3 text-teal-500" />
                    <span className="text-xs text-teal-600 dark:text-teal-300 truncate max-w-[100px]">
                      {selectedJob.title}
                    </span>
                    <button
                      onClick={onDeselectJob}
                      className="ml-1 text-teal-400 hover:text-teal-700"
                      aria-label="Deselect job"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="h-8 text-slate-400 hover:text-slate-600 text-xs font-medium"
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Help Text */}
          {!isUploading && !isReplyMode && (
            <p className="text-[10px] text-slate-400 text-center leading-relaxed">
              <span className="font-semibold text-slate-600 dark:text-slate-300">
                How it works:
              </span>{' '}
              <span className="text-slate-400">
                Think of this like a team mention (@staff). Attach files to jobs, request approvals,
                share updates, or save drafts for later.
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default TagDropPopup;
