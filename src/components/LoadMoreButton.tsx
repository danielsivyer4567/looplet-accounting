interface LoadMoreButtonProps {
  label: string;
  loading: boolean;
  onClick: () => void;
}

export function LoadMoreButton({ label, loading, onClick }: LoadMoreButtonProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={loading}
        onClick={onClick}
        style={{ minWidth: '10rem', justifyContent: 'center' }}
      >
        {loading ? 'Loading more...' : label}
      </button>
    </div>
  );
}
