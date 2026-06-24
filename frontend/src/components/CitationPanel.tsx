'use client';

import { useEffect, useRef } from 'react';
import type { CitationChunk } from '@shared/types';

interface Props {
  citation: CitationChunk;
  chunkText: string | undefined;
  citationIndex: number;
  onClose: () => void;
}

export default function CitationPanel({ citation, chunkText, citationIndex, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on tap/click outside the panel
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);

  // Dismiss on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const locationLabel =
    citation.page_number != null
      ? `Page ${citation.page_number}`
      : `Node: ${citation.chunk_id}`;

  return (
    /* Full-screen scrim */
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      aria-modal="true"
      role="dialog"
      aria-label={`Citation ${citationIndex} details`}
    >
      {/* Bottom sheet panel */}
      <div
        ref={panelRef}
        className="flex max-h-[70vh] w-full max-w-2xl min-w-0 flex-col rounded-t-2xl bg-white shadow-2xl"
      >
        {/* Handle + header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold">
              {citationIndex}
            </span>
            <h3 className="min-w-0 break-words text-sm font-semibold text-gray-800 leading-snug line-clamp-2">
              {citation.source_title}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close citation panel"
            className="ml-3 shrink-0 rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Location label */}
        <div className="px-4 pb-2 shrink-0 sm:px-5">
          <span className="inline-block max-w-full break-all text-xs text-gray-500 bg-gray-100 rounded px-2 py-0.5">
            {locationLabel}
          </span>
        </div>

        <hr className="border-gray-100 shrink-0" />

        {/* Chunk text */}
        <div className="overflow-y-auto px-4 py-4 flex-1 sm:px-5">
          {chunkText ? (
            <p className="break-words text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              {chunkText}
            </p>
          ) : (
            <p className="text-sm text-gray-400 italic">
              Chunk text not available.
            </p>
          )}
        </div>

        {/* Source link footer */}
        {citation.source_url && (
          <div className="px-4 py-3 border-t border-gray-100 shrink-0 sm:px-5">
            <a
              href={citation.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline break-all"
            >
              View source ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
