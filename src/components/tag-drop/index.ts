/**
 * Tag Drop System
 *
 * A comprehensive annotation and notification system that allows users to:
 * - Drop tags anywhere on the page
 * - Draw annotations with various tools
 * - Notify team members with context
 * - Attach files, recordings, and drawings
 * - Request approvals
 */

// Components
export { default as DrawingCanvas, DrawingToolbar } from './DrawingCanvas';
export { default as ModernTagRenderer } from './ModernTagRenderer';
export { default as ModernTagOverlay } from './ModernTagOverlay';
export { default as TagDropPopup } from './TagDropPopup';
export { TagDropManager, TagDropManagerContent } from './TagDropManager';

// Types
export type {
  Point,
  DrawingTool,
  DrawingState,
  DrawingAction,
  JobTag,
  PanelSize,
  ActiveTab,
  PanelDrawingTool,
  TagMarker,
  StaffMember,
  UploadedFile,
  TagPopupPosition,
  TagDropManagerProps,
  TagDropPopupProps,
} from './types';
export type { TagDropManagerProps as TagDropManagerComponentProps } from './TagDropManager';
