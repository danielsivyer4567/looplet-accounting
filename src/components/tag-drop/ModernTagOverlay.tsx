import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  X,
  Reply,
  Clock,
  Image as ImageIcon,
  Brush,
  Mic,
  Video,
  ZoomIn,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTagState } from '@/hooks/useTagState';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/hooks/useAuth';
import { deleteTag, updateApprovalStatus } from '@/services/tags/tag-service';

interface ModernTagOverlayProps {
  onReply?: (tagId: string | number) => void;
  onDelete?: (tagId: string | number) => void;
  className?: string;
}

const getMediaIcon = (type?: string) => {
  switch (type) {
    case 'image':
      return <ImageIcon className="h-4 w-4" />;
    case 'drawing':
      return <Brush className="h-4 w-4" />;
    case 'audio':
      return <Mic className="h-4 w-4" />;
    case 'video':
      return <Video className="h-4 w-4" />;
    default:
      return null;
  }
};

const getApprovalStatusInfo = (
  status?: 'pending' | 'approved' | 'rejected',
  requiresApproval?: boolean,
) => {
  if (!requiresApproval) return null;

  switch (status) {
    case 'approved':
      return {
        icon: <ShieldCheck className="h-4 w-4" />,
        text: 'Approved',
        className: 'bg-green-50 border-green-200 text-green-700',
        iconClass: 'text-green-600',
      };
    case 'rejected':
      return {
        icon: <ShieldX className="h-4 w-4" />,
        text: 'Rejected',
        className: 'bg-red-50 border-red-200 text-red-700',
        iconClass: 'text-red-600',
      };
    case 'pending':
    default:
      return {
        icon: <ShieldAlert className="h-4 w-4" />,
        text: 'Pending Approval',
        className: 'bg-amber-50 border-amber-200 text-amber-700',
        iconClass: 'text-amber-600',
      };
  }
};

export const ModernTagOverlay: React.FC<ModernTagOverlayProps> = ({
  onReply,
  onDelete,
  className,
}) => {
  const { activeTag, setActiveTag, isTagOverlayVisible, hideTagOverlay } = useTagState();
  const { user } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState<'approved' | 'rejected' | null>(null);

  const handleApproval = async (status: 'approved' | 'rejected') => {
    if (!activeTag) return;
    setApprovalLoading(status);
    try {
      const result = await updateApprovalStatus(String(activeTag.id), status);
      if (result.error) {
        throw new Error(result.error.message);
      }
      toast({ title: `Tag ${status === 'approved' ? 'approved' : 'rejected'} successfully` });
      // Update the active tag in-place so the UI reflects the change immediately
      setActiveTag({ ...activeTag, approvalStatus: status });
    } catch (error) {
      console.error('Approval error:', error);
      toast({
        title: `Failed to ${status === 'approved' ? 'approve' : 'reject'} tag`,
        variant: 'destructive',
      });
    } finally {
      setApprovalLoading(null);
    }
  };

  const handleClose = useCallback(() => {
    hideTagOverlay();
  }, [hideTagOverlay]);

  const handleReply = () => {
    if (activeTag && onReply) {
      onReply(activeTag.id);
    }
  };

  const handleDelete = async () => {
    if (!activeTag) return;

    setIsDeleting(true);
    try {
      const result = await deleteTag(String(activeTag.id));
      if (result.error) {
        throw new Error(result.error.message);
      }
      toast({ title: 'Tag deleted successfully' });
      onDelete?.(activeTag.id);
      hideTagOverlay();
    } catch (error) {
      console.error('Delete error:', error);
      toast({ title: 'Failed to delete tag', variant: 'destructive' });
    } finally {
      setIsDeleting(false);
    }
  };

  const canDelete = user && activeTag && activeTag.creatorId === user.id;

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(event.target as Node)) {
        handleClose();
      }
    };

    if (isTagOverlayVisible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [isTagOverlayVisible, handleClose]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };

    if (isTagOverlayVisible) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
    return undefined;
  }, [isTagOverlayVisible, handleClose]);

  if (!isTagOverlayVisible || !activeTag) {
    return null;
  }

  const coordinates = activeTag.coordinates;
  const adjustedCoords = coordinates
    ? {
        x: Math.max(60, Math.min(window.innerWidth - 350, coordinates.x)),
        y: Math.max(60, Math.min(window.innerHeight - 300, coordinates.y)),
      }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  const approvalInfo = getApprovalStatusInfo(activeTag.approvalStatus, activeTag.requiresApproval);
  const drawingSource = activeTag.drawingUrl || activeTag.drawingData;

  return (
    <div className={cn('fixed inset-0 z-[9999] pointer-events-none', className)}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm pointer-events-auto" />

      {/* Tag Bubble Indicator */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: `${coordinates?.x || adjustedCoords.x}px`,
          top: `${coordinates?.y || adjustedCoords.y}px`,
          transform: 'translate(-50%, -50%)',
        }}
      >
        <div className="w-4 h-4 rounded-full bg-blue-500 animate-ping opacity-75" />
        <div className="absolute inset-0 w-4 h-4 rounded-full bg-blue-600" />
      </div>

      {/* Main Overlay Card */}
      <div
        ref={overlayRef}
        className="absolute pointer-events-auto"
        style={{
          left: `${adjustedCoords.x + 30}px`,
          top: `${adjustedCoords.y - 150}px`,
        }}
      >
        <div className="bg-white rounded-xl shadow-2xl overflow-hidden max-w-sm border border-gray-200 animate-in slide-in-from-left duration-200">
          {/* Header */}
          <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-slate-800 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {activeTag.senderAvatar ? (
                  <img
                    src={activeTag.senderAvatar}
                    alt={activeTag.senderName}
                    className="w-10 h-10 rounded-full border-2 border-cyan-400"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-cyan-400 text-slate-900 font-bold flex items-center justify-center">
                    {activeTag.senderName?.charAt(0) || 'T'}
                  </div>
                )}
                <div>
                  <p className="font-bold text-white">{activeTag.senderName || 'Unknown User'}</p>
                  <p className="text-xs text-cyan-400 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {activeTag.time}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClose}
                className="h-8 w-8 p-0 text-white hover:bg-white/20 rounded-full"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Approval Status Banner */}
          {approvalInfo && (
            <div
              className={cn('px-4 py-2 border-b flex items-center gap-2', approvalInfo.className)}
            >
              <span className={approvalInfo.iconClass}>{approvalInfo.icon}</span>
              <span className="text-sm font-medium">{approvalInfo.text}</span>
              {activeTag.requiresApproval && activeTag.approvalStatus === 'pending' && (
                <div className="flex gap-1 ml-auto">
                  <button
                    onClick={() => handleApproval('approved')}
                    disabled={approvalLoading !== null}
                    className="text-[9px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
                  >
                    {approvalLoading === 'approved' ? 'Approving...' : 'Approve'}
                  </button>
                  <button
                    onClick={() => handleApproval('rejected')}
                    disabled={approvalLoading !== null}
                    className="text-[9px] font-bold uppercase px-2 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50"
                  >
                    {approvalLoading === 'rejected' ? 'Rejecting...' : 'Reject'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Content */}
          <div className="p-4 space-y-3">
            {/* Comment */}
            {activeTag.comment && (
              <p className="text-gray-700 font-medium leading-relaxed">{activeTag.comment}</p>
            )}

            {/* Drawing Display */}
            {drawingSource && (
              <div className="space-y-2">
                <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-lg p-3 border border-gray-200">
                  <div className="relative group">
                    <img
                      src={drawingSource}
                      alt="Tag drawing"
                      className="max-w-full h-auto rounded-md shadow-sm transition-transform group-hover:scale-[1.02]"
                      style={{ maxHeight: '250px', objectFit: 'contain', width: '100%' }}
                    />
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="bg-black/50 text-white p-1 rounded-full">
                        <ZoomIn className="h-3 w-3" />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-200">
                    <div className="flex items-center gap-1 text-primary-600">
                      <Brush className="h-3 w-3" />
                      <span className="text-xs font-medium">Drawing attachment</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs px-2"
                      onClick={() => {
                        // XSS-safe: use Blob URL + DOM API instead of document.write() with string interpolation
                        const safeTitle = (activeTag.senderName || 'Unknown').replace(
                          /[<>&"']/g,
                          '',
                        );
                        const html = `<!DOCTYPE html><html><head><title>Drawing - ${safeTitle}</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f3f4f6;"></body></html>`;
                        const blob = new Blob([html], { type: 'text/html' });
                        const blobUrl = URL.createObjectURL(blob);
                        const win = window.open(blobUrl, '_blank');
                        if (win) {
                          win.addEventListener('load', () => {
                            URL.revokeObjectURL(blobUrl);
                            // Create image via DOM API - safe from injection
                            const img = win.document.createElement('img');
                            img.src = drawingSource;
                            img.alt = 'Full size drawing attachment';
                            img.style.cssText =
                              'max-width:100%;max-height:100vh;object-fit:contain;';
                            win.document.body.appendChild(img);
                          });
                        } else {
                          URL.revokeObjectURL(blobUrl);
                        }
                      }}
                    >
                      Full Size
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Image attachments — render the actual images, not just a label */}
            {(activeTag.attachments ?? [])
              .filter((a) => a.type === 'image' && a.url)
              .map((a, i) => (
                <a
                  key={i}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-lg border border-slate-200"
                >
                  <img
                    src={a.url}
                    alt="Tag attachment"
                    loading="lazy"
                    className="max-h-[260px] w-full object-contain bg-slate-50"
                  />
                </a>
              ))}

            {/* Non-image / non-drawing attachments — keep the label indicator */}
            {activeTag.mediaType &&
              activeTag.mediaType !== 'drawing' &&
              activeTag.mediaType !== 'image' && (
                <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex items-center gap-2 text-sm text-slate-700">
                    {getMediaIcon(activeTag.mediaType)}
                    <span className="capitalize font-medium">{activeTag.mediaType} attached</span>
                  </div>
                </div>
              )}

            {/* Actions */}
            <div className="flex gap-2 pt-2 border-t border-gray-100">
              <Button
                size="sm"
                onClick={handleReply}
                className="flex-1 gap-1 bg-gradient-to-r from-blue-600 to-slate-800 hover:from-blue-700 hover:to-slate-900 text-white font-semibold shadow-md"
              >
                <Reply className="h-3 w-3" />
                Reply
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-slate-300 text-slate-600 hover:bg-slate-50"
                onClick={handleReply}
                disabled={!onReply}
                title={
                  onReply ? 'Open tag thread' : 'Thread view is available when replies are enabled'
                }
              >
                Thread
              </Button>

              {/* Delete Button */}
              {canDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Tag</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to delete this tag? This action cannot be undone.
                        {activeTag.comment && (
                          <span className="block mt-2 p-2 bg-gray-100 rounded text-gray-700 text-sm">
                            "{activeTag.comment.substring(0, 100)}
                            {activeTag.comment.length > 100 ? '...' : ''}"
                          </span>
                        )}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModernTagOverlay;
