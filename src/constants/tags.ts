/**
 * Tag Drop System Constants
 *
 * Centralized constants for the tag drop/annotation system.
 * This eliminates magic strings scattered across frontend and backend.
 *
 * Ported from the CRM tag-drop system. Looplet-specific additions:
 *   ACCOUNTANT_MATCH / isAccountant — identify the org's accountant member so
 *   the tag popup can pre-select them as the default notify target (SC-2F).
 */

/**
 * Special Looplet system tag for bug reporting and support.
 */
export const LOOPLET_TAG_ID = 'deadbeef-loop-let0-0000-000000000000' as const;

/**
 * Looplet system tag configuration
 * Used in staff selector to allow users to tag @looplet for support
 */
export const LOOPLET_SYSTEM_TAG = {
  id: LOOPLET_TAG_ID,
  email: 'support@looplet.com.au',
  full_name: '@looplet',
  role: 'Development Team',
  isSystemTag: true,
} as const;

/**
 * Tag system configuration
 */
export const TAG_CONSTANTS = {
  /** Maximum size for drawing data in bytes (5MB) */
  MAX_DRAWING_SIZE_BYTES: 5 * 1024 * 1024,

  /** Maximum comment length in characters */
  MAX_COMMENT_LENGTH: 5000,

  /** Maximum number of staff that can be tagged at once */
  MAX_TAGGED_STAFF: 20,

  /** Maximum tags per page to prevent spam */
  MAX_TAGS_PER_PAGE: 100,

  /** Rate limit: minimum seconds between tag creations per user */
  TAG_CREATION_COOLDOWN_SECONDS: 5,

  /** Rate limit: maximum tags per user per hour */
  MAX_TAGS_PER_HOUR: 50,

  /** Threshold for considering a tag "new" (show animation) */
  NEW_TAG_THRESHOLD_MS: 5000,

  /** Minimum distance between tags before clustering (pixels) */
  TAG_CLUSTER_DISTANCE_PX: 40,

  /** Staff list pagination size */
  STAFF_PAGE_SIZE: 20,

  /** Default z-index for tag markers */
  TAG_MARKER_Z_INDEX: 40,

  /** Z-index for tag overlay */
  TAG_OVERLAY_Z_INDEX: 9999,
} as const;

/**
 * Tag approval statuses
 */
export const TAG_APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

/**
 * Attachment types supported by the tag system
 */
export const TAG_ATTACHMENT_TYPES = {
  IMAGE: 'image',
  AUDIO: 'audio',
  DRAWING: 'drawing',
  VIDEO: 'video',
} as const;

/**
 * Supabase storage bucket for tag attachments
 */
export const TAG_STORAGE_BUCKET = 'tag-attachments' as const;

/**
 * Drawing tool types
 */
export const DRAWING_TOOLS = {
  PENCIL: 'pencil',
  LINE: 'line',
  RECTANGLE: 'rectangle',
  CIRCLE: 'circle',
  ARROW: 'arrow',
  TEXT: 'text',
  JOB_TAG: 'job_tag',
  ERASER: 'eraser',
  SMART_SHAPE: 'smart_shape',
  STAR: 'star',
} as const;

/**
 * Default drawing colors
 */
export const DRAWING_COLORS = [
  '#000000', // Black
  '#EF4444', // Red
  '#F97316', // Orange
  '#EAB308', // Yellow
  '#22C55E', // Green
  '#3B82F6', // Blue
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#FFFFFF', // White
] as const;

/**
 * Matches the role string Looplet uses for an accountant membership.
 *
 * `get_taggable_staff` returns `role` from `organization_memberships.role_enum`
 * (falling back to `role`), so for an accountant it is the literal `accountant`.
 * The word-boundary match also tolerates decorated labels like "Accountant (CPA)".
 */
export const ACCOUNTANT_MATCH = /\baccountant\b/i;

/**
 * True when a staff member is the org's accountant — used to pre-select them as
 * the default notify target in the tag popup (SC-2F) and to highlight their row.
 */
export function isAccountant(member: { role?: string | null }): boolean {
  return !!member.role && ACCOUNTANT_MATCH.test(member.role);
}

export type TagApprovalStatus = (typeof TAG_APPROVAL_STATUS)[keyof typeof TAG_APPROVAL_STATUS];
export type AttachmentType = (typeof TAG_ATTACHMENT_TYPES)[keyof typeof TAG_ATTACHMENT_TYPES];
export type DrawingTool = (typeof DRAWING_TOOLS)[keyof typeof DRAWING_TOOLS];
