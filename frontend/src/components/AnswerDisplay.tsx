'use client';

import type { QueryResponseData } from '@shared/types';

interface Props {
  result: QueryResponseData;
}

// Split answer text on [N] citation markers and render them as superscripts.
function renderAnswerWithCitations(answer: string) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      return (
        <sup key={i} className="text-blue-600 font-medium text-xs">
          [{match[1]}]
        </sup>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function AnswerDisplay({ result }: Props) {
  const citations = result.citations ?? [];

  return (
    <div className="w-full max-w-2xl flex flex-col gap-4">
      {/* Answer */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-gray-800 whitespace-pre-wrap leading-relaxed">
          {renderAnswerWithCitations(result.answer)}
        </p>

        {result.temporalFlag && (
          <p className="mt-3 text-xs text-gray-500 italic">
            ⏱ This answer may be time-sensitive or reference outdated information.
          </p>
        )}
      </div>

      {/* Citations */}
      {citations.length > 0 && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 px-5 py-4">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Sources
          </h2>
          <ol className="flex flex-col gap-2 list-none">
            {citations.map((c, idx) => (
              <li key={c.chunk_id} className="text-sm text-gray-700 flex gap-2">
                <span className="text-gray-400 font-medium shrink-0">[{idx + 1}]</span>
                {c.source_url ? (
                  <a
                    href={c.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {c.formatted}
                  </a>
                ) : (
                  <span>{c.formatted}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Freshness */}
      <p className="text-xs text-gray-400">
        {result.freshness ?? 'Source freshness unknown'}
      </p>

      {/* Caveats */}
      <div className="flex flex-col gap-2">
        {result.amendmentCaveat && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">⚠ Amendment Notice</span>
            {' '}
            {result.amendmentCaveat}
          </div>
        )}

        {result.pendingChangeNotice && (
          <div className="rounded-md border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-800">
            <span className="font-semibold">📋 Pending Change</span>
            {' '}
            {result.pendingChangeNotice}
          </div>
        )}

        {result.incompleteSearchWarning && (
          <div className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <span className="font-semibold">ℹ Incomplete Search</span>
            {' '}
            Search returned fewer candidates than expected. Results may be incomplete.
          </div>
        )}
      </div>
    </div>
  );
}
