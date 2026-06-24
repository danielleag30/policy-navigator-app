'use client';

import { useState, useCallback } from 'react';
import type { QueryResponseData, CitationChunk } from '@shared/types';
import CitationPanel from './CitationPanel';

interface Props {
  result: QueryResponseData;
}

interface MarkerClickHandler {
  (citationIndex: number): void;
}

// Split answer text on [N] markers; render clickable superscripts when citations are available.
function renderAnswerWithCitations(
  answer: string,
  citations: CitationChunk[],
  onMarkerClick: MarkerClickHandler,
) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const n = parseInt(match[1], 10);
      const hasCitation = n >= 1 && n <= citations.length;
      if (hasCitation) {
        return (
          <sup key={i}>
            <button
              type="button"
              onClick={() => onMarkerClick(n)}
              className="text-blue-600 font-medium text-xs hover:text-blue-800 underline decoration-dotted cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded-sm px-0.5"
              aria-label={`View citation ${n}`}
            >
              [{n}]
            </button>
          </sup>
        );
      }
      return (
        <sup key={i} className="text-blue-600 font-medium text-xs">
          [{n}]
        </sup>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function AnswerDisplay({ result }: Props) {
  const citations = result.citations ?? [];
  const [activeCitationIndex, setActiveCitationIndex] = useState<number | null>(null);

  const handleMarkerClick = useCallback((n: number) => {
    setActiveCitationIndex(n);
  }, []);

  const handlePanelClose = useCallback(() => {
    setActiveCitationIndex(null);
  }, []);

  const activeCitation =
    activeCitationIndex != null ? citations[activeCitationIndex - 1] : null;

  return (
    <div className="w-full max-w-2xl min-w-0 flex flex-col gap-4">
      {/* Answer */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        <p className="break-words text-gray-800 whitespace-pre-wrap leading-relaxed">
          {renderAnswerWithCitations(result.answer, citations, handleMarkerClick)}
        </p>

        {result.temporalFlag && (
          <p className="mt-3 break-words text-xs text-gray-500 italic">
            ⏱ This answer may be time-sensitive or reference outdated information.
          </p>
        )}
      </div>

      {/* Citations */}
      {citations.length > 0 && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-4 sm:px-5">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Sources
          </h2>
          <ol className="flex flex-col gap-2 list-none">
            {citations.map((c, idx) => (
              <li key={c.chunk_id} className="flex min-w-0 gap-2 text-sm text-gray-700">
                <span className="text-gray-400 font-medium shrink-0">[{idx + 1}]</span>
                {c.source_url ? (
                  <a
                    href={c.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 break-all text-blue-600 hover:underline"
                  >
                    {c.formatted}
                  </a>
                ) : (
                  <span className="min-w-0 break-all">{c.formatted}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Freshness */}
      <p className="break-words text-xs text-gray-400">
        {result.freshness ?? 'Source freshness unknown'}
      </p>

      {/* Caveats */}
      <div className="flex flex-col gap-2">
        {result.amendmentCaveat && (
          <div className="break-words rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="block font-semibold sm:inline">⚠ Amendment Notice</span>
            {' '}
            {result.amendmentCaveat}
          </div>
        )}

        {result.pendingChangeNotice && (
          <div className="break-words rounded-md border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-800">
            <span className="block font-semibold sm:inline">📋 Pending Change</span>
            {' '}
            {result.pendingChangeNotice}
          </div>
        )}

        {result.incompleteSearchWarning && (
          <div className="break-words rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <span className="block font-semibold sm:inline">ℹ Incomplete Search</span>
            {' '}
            Search returned fewer candidates than expected. Results may be incomplete.
          </div>
        )}
      </div>

      {/* Citation detail panel (bottom sheet) */}
      {activeCitation && activeCitationIndex != null && (
        <CitationPanel
          citation={activeCitation}
          chunkText={result.chunkText?.[activeCitation.chunk_id]}
          citationIndex={activeCitationIndex}
          onClose={handlePanelClose}
        />
      )}
    </div>
  );
}
