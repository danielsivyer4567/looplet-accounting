/**
 * Centralised z-index scale.
 *
 * The tag-drop system (ported from the CRM) layers a few floating surfaces over
 * the live page; keeping their stacking values in one place avoids the usual
 * "magic z-index" drift. Values leave room above the app chrome but below the
 * tag overlay / drawing modal, which use their own high constants in
 * `TAG_CONSTANTS` (overlay 9999) and inline (drawing modal 10000).
 */
export const Z_INDEX = {
  /** Notification panel / tag-drop popup base layer. */
  NOTIFICATION_PANEL: 9000,
} as const;
