/**
 * Tag Service
 *
 * Frontend service for interacting with the Tag Drop system.
 * Handles tag creation, fetching, deletion, and rate limiting.
 *
 * Ported from the CRM tag-drop system. Looplet remappings:
 *   - `@/lib/supabase-hardened` → `@/lib/supabase` (anon client + RLS).
 *   - No `profiles` table: creator/staff names come from the
 *     `get_taggable_staff` RPC (organization_memberships + auth.users), which
 *     SC-2C exposes. The old direct `profiles` query + fallback are dropped.
 */

import { supabase } from '@/lib/supabase';
import { TAG_CONSTANTS } from '@/constants/tags';

export interface ServiceResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

export interface CreateTagPayload {
  creatorId: string;
  comment?: string;
  taggedStaffIds?: string[];
  attachments?: { type: string; url: string }[];
  coords: { x: number; y: number };
  drawingData?: string;
  requiresApproval?: boolean;
  pageUrl?: string;
  organizationId?: string;
}

export interface FetchTagsOptions {
  pageUrl?: string;
  organizationId?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
}

export interface TagData {
  id: string;
  organization_id: string;
  creator_id: string;
  page_url: string;
  coords: { x: number; y: number };
  comment?: string;
  drawing_data?: string;
  drawing_url?: string;
  requires_approval: boolean;
  approval_status?: 'pending' | 'approved' | 'rejected';
  timestamp: number;
  created_at: string;
  senderName?: string;
  senderAvatar?: string;
  tag_staff?: {
    staff_id: string;
    notified_at: string;
    read_at?: string;
  }[];
  tag_attachments?: {
    id: string;
    attachment_type: string;
    storage_url: string;
    file_name?: string;
  }[];
}

export interface TaggableStaff {
  id: string;
  email: string;
  full_name: string;
  avatar_url?: string;
  role?: string;
}

/**
 * Check rate limit for tag creation
 */
export async function checkRateLimit(
  userId: string,
  pageUrl?: string,
): Promise<ServiceResult<{ allowed: boolean; message?: string; remaining_hourly?: number }>> {
  try {
    const { data, error } = await supabase.rpc('check_tag_rate_limit', {
      p_user_id: userId,
      p_page_url: pageUrl || null,
    });

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    return { data, error: null };
  } catch {
    return { data: null, error: { message: 'Failed to check rate limit' } };
  }
}

/**
 * Create a new tag
 */
export async function createTag(
  payload: CreateTagPayload,
): Promise<ServiceResult<{ id: string; timestamp: number; drawingData?: string }>> {
  try {
    // Validate payload
    if (
      !payload.coords ||
      typeof payload.coords.x !== 'number' ||
      typeof payload.coords.y !== 'number'
    ) {
      return { data: null, error: { message: 'Invalid coordinates' } };
    }

    if (payload.coords.x < 0 || payload.coords.y < 0) {
      return { data: null, error: { message: 'Coordinates must be non-negative' } };
    }

    if (payload.comment && payload.comment.length > TAG_CONSTANTS.MAX_COMMENT_LENGTH) {
      return {
        data: null,
        error: {
          message: `Comment exceeds maximum length of ${TAG_CONSTANTS.MAX_COMMENT_LENGTH} characters`,
        },
      };
    }

    if (payload.taggedStaffIds && payload.taggedStaffIds.length > TAG_CONSTANTS.MAX_TAGGED_STAFF) {
      return {
        data: null,
        error: { message: `Cannot tag more than ${TAG_CONSTANTS.MAX_TAGGED_STAFF} staff members` },
      };
    }

    if (
      payload.drawingData &&
      payload.drawingData.length > TAG_CONSTANTS.MAX_DRAWING_SIZE_BYTES * 1.4
    ) {
      return { data: null, error: { message: 'Drawing data exceeds maximum size' } };
    }

    // Call the database function
    const { data, error } = await supabase.rpc('create_tag_with_rate_limit', {
      p_organization_id: payload.organizationId,
      p_page_url: payload.pageUrl || window.location.pathname,
      p_coords: payload.coords,
      p_comment: payload.comment || null,
      p_drawing_data: payload.drawingData || null,
      p_tagged_staff_ids: payload.taggedStaffIds || [],
      p_requires_approval: payload.requiresApproval || false,
    });

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    if (!data.success) {
      return { data: null, error: { message: data.error?.message || 'Failed to create tag' } };
    }

    // If there are attachments, add them
    if (payload.attachments && payload.attachments.length > 0 && data.data?.id) {
      const attachmentRecords = payload.attachments.map((att) => ({
        tag_id: data.data.id,
        attachment_type: att.type,
        storage_url: att.url,
      }));

      const { error: attError } = await supabase.from('tag_attachments').insert(attachmentRecords);

      if (attError) {
        console.error('Error adding attachments:', attError);
      }
    }

    return {
      data: {
        id: data.data.id,
        timestamp: data.data.timestamp,
        ...(payload.drawingData !== undefined ? { drawingData: payload.drawingData } : {}),
      },
      error: null,
    };
  } catch (err) {
    console.error('Error creating tag:', err);
    return { data: null, error: { message: 'Failed to create tag' } };
  }
}

/**
 * Fetch tags with optional filters
 */
export async function fetchTags(
  filters: { pageUrl?: string; organizationId?: string },
  options: Omit<FetchTagsOptions, 'pageUrl' | 'organizationId'> = {},
): Promise<ServiceResult<TagData[]>> {
  try {
    const { limit = 50, offset = 0, orderBy = 'created_at', orderDirection = 'desc' } = options;

    // Build query
    let query = supabase
      .from('tags')
      .select(
        `
        id,
        organization_id,
        creator_id,
        page_url,
        coords,
        comment,
        drawing_data,
        drawing_url,
        requires_approval,
        approval_status,
        timestamp,
        created_at,
        tag_staff (
          staff_id,
          notified_at,
          read_at
        ),
        tag_attachments (
          id,
          attachment_type,
          storage_url,
          file_name
        )
      `,
      )
      .is('deleted_at', null);

    if (filters.pageUrl) {
      query = query.eq('page_url', filters.pageUrl);
    }

    if (filters.organizationId) {
      query = query.eq('organization_id', filters.organizationId);
    }

    // Apply ordering
    query = query.order(orderBy, { ascending: orderDirection === 'asc' });

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    // Enrich creator name/avatar from the org's taggable-staff list (no
    // `profiles` table in Looplet — names live in auth.users via the RPC).
    let creatorProfiles: Record<string, TaggableStaff> = {};
    if (filters.organizationId) {
      const { data: staff } = await getTaggableStaff(filters.organizationId);
      if (staff) {
        creatorProfiles = staff.reduce(
          (acc, s) => {
            acc[s.id] = s;
            return acc;
          },
          {} as Record<string, TaggableStaff>,
        );
      }
    }

    // Transform data
    const transformedData: TagData[] = ((data as TagData[]) || []).map((tag) => {
      const creator = creatorProfiles[tag.creator_id];
      return {
        ...tag,
        senderName: creator?.full_name || 'Unknown',
        ...(creator?.avatar_url ? { senderAvatar: creator.avatar_url } : {}),
      };
    });

    return { data: transformedData, error: null };
  } catch (err) {
    console.error('Error fetching tags:', err);
    return { data: null, error: { message: 'Failed to fetch tags' } };
  }
}

/**
 * Delete a tag (soft delete)
 */
export async function deleteTag(tagId: string): Promise<ServiceResult<{ success: boolean }>> {
  try {
    const { error } = await supabase
      .from('tags')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', tagId);

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    return { data: { success: true }, error: null };
  } catch (err) {
    console.error('Error deleting tag:', err);
    return { data: null, error: { message: 'Failed to delete tag' } };
  }
}

/**
 * Mark a tag notification as read
 */
export async function markTagAsRead(
  tagId: string,
  staffId: string,
): Promise<ServiceResult<{ success: boolean }>> {
  try {
    const { error } = await supabase
      .from('tag_staff')
      .update({ read_at: new Date().toISOString() })
      .eq('tag_id', tagId)
      .eq('staff_id', staffId);

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    return { data: { success: true }, error: null };
  } catch (err) {
    console.error('Error marking tag as read:', err);
    return { data: null, error: { message: 'Failed to mark tag as read' } };
  }
}

/**
 * Get unread tag count for a user
 */
export async function getUnreadTagCount(
  staffId: string,
): Promise<ServiceResult<{ count: number }>> {
  try {
    const { count, error } = await supabase
      .from('tag_staff')
      .select('*', { count: 'exact', head: true })
      .eq('staff_id', staffId)
      .is('read_at', null);

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    return { data: { count: count || 0 }, error: null };
  } catch (err) {
    console.error('Error getting unread count:', err);
    return { data: null, error: { message: 'Failed to get unread count' } };
  }
}

/**
 * Get taggable staff for an organization.
 *
 * Looplet has no `profiles` table — the `get_taggable_staff` RPC (SC-2C) reads
 * `organization_memberships` + `auth.users` and is caller-org-gated, so there
 * is no client-side fallback to fall back to.
 */
export async function getTaggableStaff(
  organizationId?: string,
): Promise<ServiceResult<TaggableStaff[]>> {
  try {
    const { data, error } = await supabase.rpc('get_taggable_staff', {
      p_organization_id: organizationId || null,
    });

    if (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }

    return { data: (data as TaggableStaff[]) || [], error: null };
  } catch (err) {
    console.error('Error getting taggable staff:', err);
    return { data: null, error: { message: 'Failed to get staff list' } };
  }
}

/**
 * Update the approval status of a tag
 */
export async function updateApprovalStatus(
  tagId: string,
  status: 'approved' | 'rejected',
): Promise<ServiceResult<{ success: boolean }>> {
  try {
    const { error } = await supabase
      .from('tags')
      .update({ approval_status: status })
      .eq('id', tagId);

    if (error) {
      console.error('[TagService] updateApprovalStatus error:', error.message);
      return { data: null, error: { message: error.message, code: error.code } };
    }

    return { data: { success: true }, error: null };
  } catch (err) {
    console.error('[TagService] updateApprovalStatus error:', err);
    return { data: null, error: { message: 'Failed to update approval status' } };
  }
}

/**
 * Save a tag draft
 */
export async function saveTagDraft(draft: {
  userId: string;
  organizationId: string;
  pageUrl?: string;
  comment?: string;
  drawingData?: string;
  taggedStaffIds?: string[];
  requiresApproval?: boolean;
  jobId?: string;
}): Promise<ServiceResult<{ id: string }>> {
  try {
    const { data, error } = await supabase
      .from('tag_drafts')
      .upsert(
        {
          user_id: draft.userId,
          organization_id: draft.organizationId,
          page_url: draft.pageUrl,
          comment: draft.comment,
          drawing_data: draft.drawingData,
          tagged_staff_ids: draft.taggedStaffIds || [],
          requires_approval: draft.requiresApproval || false,
          job_id: draft.jobId,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'user_id,organization_id,page_url',
        },
      )
      .select('id')
      .single();

    if (error) {
      return { data: null, error: { message: error.message } };
    }

    return { data: { id: data.id }, error: null };
  } catch (err) {
    console.error('Error saving draft:', err);
    return { data: null, error: { message: 'Failed to save draft' } };
  }
}

/**
 * Load a tag draft
 */
export async function loadTagDraft(
  userId: string,
  pageUrl?: string,
): Promise<
  ServiceResult<{
    id: string;
    comment?: string;
    drawingData?: string;
    taggedStaffIds?: string[];
    requiresApproval?: boolean;
    jobId?: string;
  } | null>
> {
  try {
    let query = supabase.from('tag_drafts').select('*').eq('user_id', userId);

    if (pageUrl) {
      query = query.eq('page_url', pageUrl);
    }

    const { data, error } = await query.order('updated_at', { ascending: false }).limit(1).single();

    if (error && error.code !== 'PGRST116') {
      // Not found is OK
      return { data: null, error: { message: error.message } };
    }

    if (!data) {
      return { data: null, error: null };
    }

    return {
      data: {
        id: data.id,
        comment: data.comment,
        drawingData: data.drawing_data,
        taggedStaffIds: data.tagged_staff_ids,
        requiresApproval: data.requires_approval,
        jobId: data.job_id,
      },
      error: null,
    };
  } catch (err) {
    console.error('Error loading draft:', err);
    return { data: null, error: { message: 'Failed to load draft' } };
  }
}
