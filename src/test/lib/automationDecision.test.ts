import { describe, expect, it } from 'vitest';
import {
  canAutoPost,
  isDecisionBlocked,
  isMoreReviewNeeded,
  isValidConfidence,
  needsQuickConfirm,
  serializeReasonCodes,
} from '@/lib/automationDecision';

describe('automationDecision library', () => {
  describe('isValidConfidence', () => {
    it('returns true for known confidence bands', () => {
      expect(isValidConfidence('auto_post')).toBe(true);
      expect(isValidConfidence('quick_confirm')).toBe(true);
      expect(isValidConfidence('review_needed')).toBe(true);
      expect(isValidConfidence('advisor_required')).toBe(true);
      expect(isValidConfidence('blocked_external')).toBe(true);
    });

    it('returns false for unknown values', () => {
      expect(isValidConfidence('unknown')).toBe(false);
      expect(isValidConfidence('')).toBe(false);
      expect(isValidConfidence('auto_approve')).toBe(false);
    });
  });

  describe('canAutoPost', () => {
    it('returns true only for auto_post', () => {
      expect(canAutoPost('auto_post')).toBe(true);
      expect(canAutoPost('quick_confirm')).toBe(false);
      expect(canAutoPost('review_needed')).toBe(false);
      expect(canAutoPost('advisor_required')).toBe(false);
      expect(canAutoPost('blocked_external')).toBe(false);
    });
  });

  describe('needsQuickConfirm', () => {
    it('returns true only for quick_confirm', () => {
      expect(needsQuickConfirm('auto_post')).toBe(false);
      expect(needsQuickConfirm('quick_confirm')).toBe(true);
      expect(needsQuickConfirm('review_needed')).toBe(false);
      expect(needsQuickConfirm('advisor_required')).toBe(false);
      expect(needsQuickConfirm('blocked_external')).toBe(false);
    });
  });

  describe('isDecisionBlocked', () => {
    it('returns true only for blocked_external', () => {
      expect(isDecisionBlocked('auto_post')).toBe(false);
      expect(isDecisionBlocked('quick_confirm')).toBe(false);
      expect(isDecisionBlocked('review_needed')).toBe(false);
      expect(isDecisionBlocked('advisor_required')).toBe(false);
      expect(isDecisionBlocked('blocked_external')).toBe(true);
    });
  });

  describe('isMoreReviewNeeded', () => {
    it('ranks confidence correctly', () => {
      expect(isMoreReviewNeeded('review_needed', 'auto_post')).toBe(true);
      expect(isMoreReviewNeeded('auto_post', 'review_needed')).toBe(false);
      expect(isMoreReviewNeeded('advisor_required', 'review_needed')).toBe(true);
      expect(isMoreReviewNeeded('blocked_external', 'advisor_required')).toBe(true);
      expect(isMoreReviewNeeded('auto_post', 'quick_confirm')).toBe(false);
      expect(isMoreReviewNeeded('quick_confirm', 'auto_post')).toBe(true);
    });

    it('returns false for equal confidence', () => {
      expect(isMoreReviewNeeded('review_needed', 'review_needed')).toBe(false);
      expect(isMoreReviewNeeded('auto_post', 'auto_post')).toBe(false);
    });
  });

  describe('serializeReasonCodes', () => {
    it('filters empty strings', () => {
      expect(serializeReasonCodes(['a', '', 'b', '', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for empty input', () => {
      expect(serializeReasonCodes([])).toEqual([]);
    });

    it('passes through valid codes', () => {
      expect(serializeReasonCodes(['supplier_match_high', 'gst_free_treatment'])).toEqual([
        'supplier_match_high',
        'gst_free_treatment',
      ]);
    });
  });
});
