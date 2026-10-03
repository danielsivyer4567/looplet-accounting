import React, { memo, useMemo } from 'react';
import { Brush, Image as ImageIcon, Mic, Video, ShieldAlert } from 'lucide-react';
import { useTagState } from '@/hooks/useTagState';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { TAG_CONSTANTS, type AttachmentType } from '@/constants/tags';
import type { TagMarker } from './types';

interface ModernTagRendererProps {
  markers: TagMarker[];
  className?: string;
}

interface PositionedMarker extends TagMarker {
  displayX: number;
  displayY: number;
  clusterCount?: number;
  isClusterHead?: boolean;
  /** 1-based sequential pin number across all visible tags */
  pinNumber: number;
}

const getMediaIcon = (type?: string, size = 'h-3 w-3') => {
  const iconProps = { className: size };
  switch (type) {
    case 'image':
      return <ImageIcon {...iconProps} />;
    case 'drawing':
      return <Brush {...iconProps} />;
    case 'audio':
      return <Mic {...iconProps} />;
    case 'video':
      return <Video {...iconProps} />;
    default:
      return null;
  }
};

/**
 * Calculate distance between two points
 */
const distance = (x1: number, y1: number, x2: number, y2: number): number => {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
};

/**
 * Calculate display positions with overlap handling
 */
const calculatePositions = (markers: TagMarker[]): PositionedMarker[] => {
  if (!markers.length) return [];

  const clusterDistance = TAG_CONSTANTS.TAG_CLUSTER_DISTANCE_PX;
  const positioned: Omit<PositionedMarker, 'pinNumber'>[] = [];
  const processed = new Set<string>();

  // Sort markers by timestamp (newest first)
  const sorted = [...markers].sort((a, b) => b.timestamp - a.timestamp);

  for (const marker of sorted) {
    if (processed.has(marker.id)) continue;

    // Find all markers within cluster distance
    const nearbyMarkers = sorted.filter(
      (m) =>
        !processed.has(m.id) &&
        m.id !== marker.id &&
        distance(marker.x, marker.y, m.x, m.y) < clusterDistance,
    );

    if (nearbyMarkers.length === 0) {
      positioned.push({
        ...marker,
        displayX: marker.x,
        displayY: marker.y,
      });
      processed.add(marker.id);
    } else {
      // Create cluster - main marker shows count badge
      positioned.push({
        ...marker,
        displayX: marker.x,
        displayY: marker.y,
        clusterCount: nearbyMarkers.length + 1,
        isClusterHead: true,
      });
      processed.add(marker.id);

      // Position nearby markers in a circle around the cluster head
      const angleStep = (2 * Math.PI) / nearbyMarkers.length;
      const offsetRadius = clusterDistance * 0.8;

      nearbyMarkers.forEach((nearby, index) => {
        const angle = angleStep * index - Math.PI / 2;
        const offsetX = Math.cos(angle) * offsetRadius;
        const offsetY = Math.sin(angle) * offsetRadius;

        positioned.push({
          ...nearby,
          displayX: marker.x + offsetX,
          displayY: marker.y + offsetY,
        });
        processed.add(nearby.id);
      });
    }
  }

  // Assign 1-based pin numbers in chronological order (oldest = #1) so the
  // numbering matches the order tags were dropped, regardless of cluster
  // ordering above.
  const chronologicalIds = new Map<string, number>();
  [...markers]
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((m, i) => chronologicalIds.set(m.id, i + 1));

  return positioned.map((p) => ({
    ...p,
    pinNumber: chronologicalIds.get(p.id) ?? 0,
  })) as PositionedMarker[];
};

interface TagMarkerComponentProps {
  marker: PositionedMarker;
}

const TagMarkerComponent = memo<TagMarkerComponentProps>(({ marker }) => {
  const { showTagOverlay } = useTagState();

  const handleClick = () => {
    const tagData = {
      id: marker.id,
      comment: marker.comment,
      senderName: marker.senderName,
      senderAvatar: marker.senderAvatar,
      time: new Date(marker.timestamp).toLocaleTimeString(),
      coordinates: { x: marker.x, y: marker.y },
      mediaType: marker.mediaType as AttachmentType | undefined,
      drawingData: marker.drawingData,
      drawingUrl: marker.drawingUrl,
      attachments: marker.attachments?.map((a) => ({ ...a, type: a.type as AttachmentType })),
      approvalStatus: marker.approvalStatus,
      requiresApproval: marker.requiresApproval,
      creatorId: marker.creatorId,
    };

    showTagOverlay(tagData);
  };

  const isNew = Date.now() - marker.timestamp < TAG_CONSTANTS.NEW_TAG_THRESHOLD_MS;
  const hasDrawing =
    marker.drawingData ||
    marker.drawingUrl ||
    marker.attachments?.some((a) => a.type === 'drawing');
  const isPendingApproval = marker.requiresApproval && marker.approvalStatus === 'pending';
  const isApproved = marker.requiresApproval && marker.approvalStatus === 'approved';
  const isRejected = marker.requiresApproval && marker.approvalStatus === 'rejected';
  const drawingSource = marker.drawingUrl || marker.drawingData;

  // Color coding by approval status — falls back to neutral white for tags
  // that don't require approval.
  const statusBorder = isPendingApproval
    ? 'border-amber-400'
    : isApproved
      ? 'border-emerald-400'
      : isRejected
        ? 'border-rose-400'
        : 'border-white';

  return (
    <div
      className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-auto"
      style={{
        left: marker.displayX,
        top: marker.displayY,
        zIndex: TAG_CONSTANTS.TAG_MARKER_Z_INDEX + (isNew ? 10 : 0),
      }}
    >
      {/* Pulsing effect for new tags */}
      {isNew && (
        <div className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-30" />
      )}

      {/* Tag bubble */}
      <button
        onClick={handleClick}
        className="relative group"
        aria-label={`Tag: ${marker.comment || 'No comment'}`}
      >
        {/* Drawing preview or avatar */}
        {hasDrawing ? (
          <div
            className={cn(
              'w-12 h-12 rounded-full border-3 shadow-lg overflow-hidden bg-white transition-transform group-hover:scale-110',
              statusBorder,
            )}
          >
            {drawingSource ? (
              <img
                src={drawingSource}
                alt="Drawing preview"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary-500 to-pink-600">
                <Brush className="h-6 w-6 text-white" />
              </div>
            )}
          </div>
        ) : marker.senderAvatar ? (
          <img
            src={marker.senderAvatar}
            alt={marker.senderName}
            className={cn(
              'w-12 h-12 rounded-full border-3 shadow-lg transition-transform group-hover:scale-110',
              statusBorder,
            )}
          />
        ) : (
          <div
            className={cn(
              'w-12 h-12 rounded-full bg-gradient-to-br from-blue-600 to-slate-800 text-white border-3 shadow-lg flex items-center justify-center font-bold transition-transform group-hover:scale-110',
              statusBorder,
            )}
          >
            {marker.senderName?.charAt(0) || 'T'}
          </div>
        )}

        {/* Numbered pin badge — sits on the bottom-left so it doesn't fight
             the existing media indicator (bottom-right) or approval shield
             (top-left). Hidden inside clusters since the cluster count badge
             owns the top-right corner. */}
        {marker.pinNumber > 0 && !marker.isClusterHead && (
          <div className="absolute -bottom-1 -left-1 min-w-5 h-5 px-1 bg-slate-900/90 dark:bg-slate-100/90 rounded-full flex items-center justify-center shadow-md border-2 border-white">
            <span className="text-[11px] font-black text-white dark:text-slate-900 leading-none">
              {marker.pinNumber}
            </span>
          </div>
        )}

        {/* Pending approval indicator */}
        {isPendingApproval && (
          <div className="absolute -top-1 -left-1 w-5 h-5 bg-amber-400 rounded-full flex items-center justify-center shadow-md border border-amber-500">
            <ShieldAlert className="h-3 w-3 text-amber-900" />
          </div>
        )}

        {/* Media indicator */}
        {marker.mediaType && !isPendingApproval && (
          <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center shadow-md border border-gray-200">
            {getMediaIcon(marker.mediaType)}
          </div>
        )}

        {/* Cluster count badge */}
        {marker.isClusterHead && marker.clusterCount && marker.clusterCount > 1 && (
          <div className="absolute -top-1 -right-1 min-w-5 h-5 px-1 bg-blue-600 rounded-full flex items-center justify-center shadow-md border border-white">
            <span className="text-[11px] font-bold text-white">
              {marker.clusterCount > 9 ? '9+' : marker.clusterCount}
            </span>
          </div>
        )}

        {/* Hover tooltip */}
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 max-w-[200px] truncate">
          {isPendingApproval && <span className="text-amber-400 mr-1">-</span>}
          {marker.comment
            ? marker.comment.substring(0, 50) + (marker.comment.length > 50 ? '...' : '')
            : 'Click to view details'}
          {marker.isClusterHead && marker.clusterCount && marker.clusterCount > 1 && (
            <span className="ml-1 text-blue-300">+{marker.clusterCount - 1} more</span>
          )}
        </div>
      </button>
    </div>
  );
});

TagMarkerComponent.displayName = 'TagMarkerComponent';

export const ModernTagRenderer: React.FC<ModernTagRendererProps> = ({ markers, className }) => {
  const { tagsHidden, tagStatusFilter, tagsMineOnly } = useTagState();
  const { user } = useAuth();
  const myUserId = user?.id;

  const filteredMarkers = useMemo(() => {
    let list = markers;
    if (tagStatusFilter !== 'all') {
      list = list.filter((m) => {
        const status = m.approvalStatus;
        if (tagStatusFilter === 'no_approval') return !m.requiresApproval;
        if (!m.requiresApproval) return false;
        return status === tagStatusFilter;
      });
    }
    if (tagsMineOnly && myUserId) {
      list = list.filter((m) => m.creatorId === myUserId);
    }
    return list;
  }, [markers, tagStatusFilter, tagsMineOnly, myUserId]);

  const positionedMarkers = useMemo(() => calculatePositions(filteredMarkers), [filteredMarkers]);
  if (tagsHidden) return null;

  return (
    <div className={cn('absolute inset-0 pointer-events-none', className)}>
      {positionedMarkers.map((marker) => (
        <TagMarkerComponent key={marker.id} marker={marker} />
      ))}
    </div>
  );
};

export default ModernTagRenderer;
