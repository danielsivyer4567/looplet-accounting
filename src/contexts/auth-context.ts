import { createContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  /** `metadata` is saved on the new user (for example the legal acceptance record). */
  signUp: (
    email: string,
    password: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{ error: Error | null; needsEmailConfirmation: boolean }>;
  resetPassword: (email: string) => Promise<{ error: Error | null }>;
  /**
   * Set (or change) the signed-in user's password. Used by the accept-invite
   * flow: a Supabase invite link signs the new user in passwordless, then they
   * choose a password before accepting their pending org invites.
   */
  setPassword: (password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
