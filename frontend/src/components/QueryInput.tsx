'use client';

interface QueryInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (query: string) => void;
  disabled?: boolean;
}

export default function QueryInput({ value, onChange, onSubmit, disabled }: QueryInputProps) {
  const trimmed = value.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl min-w-0">
      <div className="flex flex-col gap-3">
        <label htmlFor="query-input" className="text-sm font-medium text-gray-700">
          Your question
        </label>
        <textarea
          id="query-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={4}
          placeholder="e.g. What are the setback requirements for residential fences in Fairfax County?"
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500 resize-none break-words"
          aria-describedby="query-hint"
        />
        <p id="query-hint" className="text-xs text-gray-500 break-words">
          Ask about zoning, permits, ordinances, or other Fairfax County policies.
        </p>
        <button
          type="submit"
          disabled={!trimmed || disabled}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-white font-semibold transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-300 disabled:cursor-not-allowed sm:px-6"
        >
          {disabled ? (
            <span className="flex min-w-0 items-center justify-center gap-2">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
              Searching…
            </span>
          ) : (
            'Ask'
          )}
        </button>
      </div>
    </form>
  );
}
