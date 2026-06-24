'use client';

import { useState } from 'react';
import type { QueryResponseData } from '@shared/types';
import { SUPABASE_ANON_KEY, QUERY_PIPELINE_URL } from '../lib/env';
import QueryInput from './QueryInput';
import AnswerDisplay from './AnswerDisplay';
import EmptyState from './EmptyState';

type Status = 'idle' | 'loading' | 'success' | 'error';
type ErrorType = null | 'rate_limit' | 'exhausted' | 'generic';

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

interface SuccessEnvelope {
  ok: true;
  data: QueryResponseData;
}

type PipelineResponse = ErrorEnvelope | SuccessEnvelope;

export default function QueryForm() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorType, setErrorType] = useState<ErrorType>(null);
  const [result, setResult] = useState<QueryResponseData | null>(null);

  async function handleSubmit(trimmedQuery: string) {
    setStatus('loading');
    setErrorType(null);
    setResult(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    try {
      const res = await fetch(QUERY_PIPELINE_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ query: trimmedQuery }),
      });

      clearTimeout(timeoutId);

      if (res.status === 429) {
        setStatus('error');
        setErrorType('rate_limit');
        return;
      }

      const json: PipelineResponse = await res.json();

      if (!res.ok || !json.ok) {
        const code = json.ok === false ? json.error.code : '';
        if (res.status === 503 && code === 'OLLAMA_EXHAUSTED') {
          setErrorType('exhausted');
        } else {
          setErrorType('generic');
        }
        setStatus('error');
        return;
      }

      setResult(json.data);
      setStatus('success');
    } catch (err) {
      clearTimeout(timeoutId);
      setStatus('error');
      setErrorType('generic');
    }
  }

  const errorMessages: Record<NonNullable<ErrorType>, string> = {
    rate_limit: "You've sent too many requests. Please wait a moment and try again.",
    exhausted: 'Unable to process your query right now. Please try again in a moment.',
    generic: 'Something went wrong. Please try again.',
  };

  return (
    <div className="w-full max-w-2xl flex flex-col gap-6">
      <QueryInput
        value={query}
        onChange={setQuery}
        onSubmit={handleSubmit}
        disabled={status === 'loading'}
      />

      {status === 'idle' && <EmptyState />}

      {status === 'error' && errorType && (
        errorType === 'rate_limit' ? (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">Rate limit reached.</span>{' '}
            {errorMessages.rate_limit}
          </div>
        ) : (
          <p role="alert" className="text-red-600 text-sm font-medium">
            {errorMessages[errorType]}
          </p>
        )
      )}

      {status === 'success' && result && <AnswerDisplay result={result} />}
    </div>
  );
}
