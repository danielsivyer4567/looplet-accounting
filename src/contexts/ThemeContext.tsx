import React, { useEffect, useState } from 'react';
import { ThemeContext, type Theme } from './theme-context';

const THEME_VERSION = '2026-10-light';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // The October 2026 light redesign switches everyone to light once; a later choice is respected.
    if (localStorage.getItem('theme-version') !== THEME_VERSION) return 'light';
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
      root.style.colorScheme = 'light';
    } else {
      root.setAttribute('data-theme', 'dark');
      root.style.colorScheme = 'dark';
    }
    localStorage.setItem('theme', theme);
    localStorage.setItem('theme-version', THEME_VERSION);
  }, [theme]);

  const toggleTheme = () => {
    setThemeState((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
