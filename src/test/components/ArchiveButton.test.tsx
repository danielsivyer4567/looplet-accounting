import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArchiveButton } from '@/components/ArchiveButton';
import { clearSupabaseOperations, getSupabaseOperations } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

describe('ArchiveButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSupabaseOperations();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('archives active rows by setting deleted_at and reports the new state', async () => {
    const onChange = vi.fn();
    render(<ArchiveButton table="bills" rowId="bill-1" isArchived={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(true);
    });
    expect(getSupabaseOperations()).toContainEqual({
      table: 'bills',
      method: 'update',
      payload: { deleted_at: expect.any(String) },
    });
  });

  it('restores archived rows by clearing deleted_at', async () => {
    const onChange = vi.fn();
    render(<ArchiveButton table="jobs" rowId="job-1" isArchived onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /^restore$/i }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(false);
    });
    expect(getSupabaseOperations()).toContainEqual({
      table: 'jobs',
      method: 'update',
      payload: { deleted_at: null },
    });
  });

  it('supports employee soft-delete rows', async () => {
    const onChange = vi.fn();
    render(
      <ArchiveButton table="employees" rowId="emp-1" isArchived={false} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(true);
    });
    expect(getSupabaseOperations()).toContainEqual({
      table: 'employees',
      method: 'update',
      payload: { deleted_at: expect.any(String) },
    });
  });

  it('supports debt soft-delete rows', async () => {
    const onChange = vi.fn();
    render(<ArchiveButton table="debts" rowId="debt-1" isArchived={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(true);
    });
    expect(getSupabaseOperations()).toContainEqual({
      table: 'debts',
      method: 'update',
      payload: { deleted_at: expect.any(String) },
    });
  });
});
