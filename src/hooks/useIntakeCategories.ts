import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

export interface IntakeCategory {
  code: string;
  label: string;
  xero_account_code: string | null;
  xero_tax_type: string | null;
  description: string | null;
  is_business: boolean;
  side: 'expense' | 'income' | 'liability';
  sort_order: number;
}

export function useIntakeCategories() {
  const [categories, setCategories] = useState<IntakeCategory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void supabase
      .from('intake_categories')
      .select('*')
      .order('sort_order')
      .then(({ data }) => {
        setCategories((data ?? []) as IntakeCategory[]);
        setLoading(false);
      });
  }, []);

  return { categories, loading };
}
