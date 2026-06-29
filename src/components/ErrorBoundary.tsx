import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-wide error boundary.
 *
 * React error boundaries must be class components — there is no hook equivalent
 * for getDerivedStateFromError/componentDidCatch. When a descendant throws
 * during render, we swap the white-screen crash for a friendly fallback and a
 * Reset button that clears the error so children re-mount and re-render.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the crash in the console so it still shows up in error reporting.
    console.error('Unhandled render error caught by ErrorBoundary:', error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
            boxSizing: 'border-box',
            background: 'var(--bg-app)',
          }}
        >
          <div
            className="card"
            style={{ maxWidth: '460px', width: '100%', textAlign: 'center' }}
          >
            <h2 style={{ marginBottom: '0.75rem' }}>Something went wrong</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
              An unexpected error stopped this view from loading. You can try again — if it keeps
              happening, please refresh the page.
            </p>
            <button type="button" className="btn btn-primary" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
