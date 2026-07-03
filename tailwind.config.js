import animate from 'tailwindcss-animate';

/**
 * Tailwind is introduced ONLY for the tag-drop UI (shadcn primitives). It must
 * not touch the existing handcrafted `src/index.css`, so:
 *  - `corePlugins.preflight = false` — no global reset that would clobber the
 *    existing body/heading/anchor resets.
 *  - colours map onto looplet's existing CSS custom properties (`--bg-*`,
 *    `--text-*`, `--accent-*`) so Tailwind and the legacy stylesheet stay in
 *    visual lockstep and dark mode keeps working off `html[data-theme]`.
 * Tailwind utilities land in `@layer utilities`; the legacy unlayered rules in
 * `index.css` always win, so existing pages render unchanged (regression gate).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: ['class', "html[data-theme='dark']"],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: 'var(--border-subtle)',
        input: 'var(--border-subtle)',
        ring: 'var(--accent-primary)',
        background: 'var(--bg-app)',
        foreground: 'var(--text-body)',
        primary: {
          DEFAULT: 'var(--accent-primary)',
          foreground: 'var(--text-on-accent)',
        },
        secondary: {
          DEFAULT: 'var(--bg-hover)',
          foreground: 'var(--text-title)',
        },
        destructive: {
          DEFAULT: 'var(--accent-danger)',
          foreground: 'var(--text-on-accent)',
        },
        muted: {
          DEFAULT: 'var(--bg-hover)',
          foreground: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--bg-hover)',
          foreground: 'var(--text-title)',
        },
        popover: {
          DEFAULT: 'var(--bg-panel)',
          foreground: 'var(--text-body)',
        },
        card: {
          DEFAULT: 'var(--bg-card)',
          foreground: 'var(--text-body)',
        },
        success: {
          DEFAULT: 'var(--accent-success)',
          foreground: 'var(--text-on-accent)',
        },
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        title: 'var(--font-title)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
};
