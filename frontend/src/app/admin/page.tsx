'use client';

import { useCallback, useEffect, useState } from 'react';
import { ADMIN_SECRET, SUPABASE_URL } from '../../lib/env';

type Status = 'idle' | 'loading' | 'success' | 'error' | 'unauthorized';

interface PendingAlert {
  id: string;
  alert_type: string;
  source_url: string | null;
  triggered_at: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
  details: unknown;
}

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

type AdminAlertsResponse = SuccessEnvelope<PendingAlert[]> | ErrorEnvelope;
type AcknowledgeAlertResponse = SuccessEnvelope<PendingAlert> | ErrorEnvelope;

const ADMIN_ALERTS_URL = `${SUPABASE_URL}/functions/v1/admin-alerts`;
const ACKNOWLEDGE_ALERT_URL = `${SUPABASE_URL}/functions/v1/acknowledge-alert`;

/**
 * Secret rotation procedure:
 * 1. Generate a new shared admin secret.
 * 2. Update the Edge Function ADMIN_SECRET and Vercel NEXT_PUBLIC_ADMIN_SECRET.
 * 3. Redeploy admin-alerts, acknowledge-alert, and the frontend so client and
 *    server values match.
 * 4. Verify /admin can list alerts before retiring the previous value.
 */
export default function AdminPage() {
  const [alerts, setAlerts] = useState<PendingAlert[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);

  const hasConfig = Boolean(SUPABASE_URL && ADMIN_SECRET);

  const fetchAlerts = useCallback(async () => {
    if (!hasConfig) {
      setStatus('unauthorized');
      setErrorMessage(
        'Admin access is not configured. Set NEXT_PUBLIC_ADMIN_SECRET and NEXT_PUBLIC_SUPABASE_URL.',
      );
      return;
    }

    setStatus('loading');
    setErrorMessage(null);

    try {
      const response = await fetch(ADMIN_ALERTS_URL, {
        method: 'GET',
        headers: {
          'x-admin-secret': ADMIN_SECRET,
        },
      });

      if (response.status === 401 || response.status === 403) {
        setStatus('unauthorized');
        setErrorMessage('Unauthorized. Check the configured admin secret.');
        return;
      }

      const json = (await response.json()) as AdminAlertsResponse;

      if (!response.ok || !json.ok) {
        setStatus('error');
        setErrorMessage(
          json.ok === false
            ? json.error.message
            : 'Unable to load pending alerts.',
        );
        return;
      }

      setAlerts(json.data);
      setStatus('success');
    } catch {
      setStatus('error');
      setErrorMessage('Unable to load pending alerts.');
    }
  }, [hasConfig]);

  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);

  async function acknowledgeAlert(alertId: string) {
    if (!hasConfig) {
      setStatus('unauthorized');
      setErrorMessage(
        'Admin access is not configured. Set NEXT_PUBLIC_ADMIN_SECRET and NEXT_PUBLIC_SUPABASE_URL.',
      );
      return;
    }

    setAcknowledgingId(alertId);
    setErrorMessage(null);

    try {
      const response = await fetch(ACKNOWLEDGE_ALERT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': ADMIN_SECRET,
        },
        body: JSON.stringify({ id: alertId }),
      });

      if (response.status === 401 || response.status === 403) {
        setStatus('unauthorized');
        setErrorMessage('Unauthorized. Check the configured admin secret.');
        return;
      }

      const json = (await response.json()) as AcknowledgeAlertResponse;

      if (!response.ok || !json.ok) {
        setStatus('error');
        setErrorMessage(
          json.ok === false
            ? json.error.message
            : 'Unable to acknowledge pending alert.',
        );
        return;
      }

      await fetchAlerts();
    } catch {
      setStatus('error');
      setErrorMessage('Unable to acknowledge pending alert.');
    } finally {
      setAcknowledgingId(null);
    }
  }

  const isLoading = status === 'idle' || status === 'loading';
  const isUnauthorized = status === 'unauthorized';
  const showEmpty = status === 'success' && alerts.length === 0;
  const showAlerts = status === 'success' && alerts.length > 0;

  return (
    <main className="min-h-screen bg-gray-50 px-6 py-8 text-gray-950 sm:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-2 border-b border-gray-200 pb-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Admin
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-950">
                Pending Alerts
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-gray-600">
                Unacknowledged pending alerts from the admin-alerts Edge Function.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void fetchAlerts()}
              disabled={isLoading}
              className="inline-flex min-h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-900 shadow-sm transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </header>

        {isLoading && (
          <section
            aria-live="polite"
            className="rounded-md border border-gray-200 bg-white px-5 py-4 text-sm text-gray-600 shadow-sm"
          >
            Loading pending alerts...
          </section>
        )}

        {(status === 'error' || isUnauthorized) && errorMessage && (
          <section
            role="alert"
            className={`rounded-md border px-5 py-4 text-sm shadow-sm ${
              isUnauthorized
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            <p className="font-semibold">
              {isUnauthorized ? 'Unauthorized' : 'Unable to load admin alerts'}
            </p>
            <p className="mt-1">{errorMessage}</p>
          </section>
        )}

        {showEmpty && (
          <section className="rounded-md border border-gray-200 bg-white px-5 py-10 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-gray-950">
              No pending alerts
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              All pending alerts have been acknowledged.
            </p>
          </section>
        )}

        {showAlerts && (
          <section className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                <thead className="bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-600">
                  <tr>
                    <th scope="col" className="w-48 px-4 py-3">
                      Triggered
                    </th>
                    <th scope="col" className="w-48 px-4 py-3">
                      Type
                    </th>
                    <th scope="col" className="min-w-64 px-4 py-3">
                      Source URL
                    </th>
                    <th scope="col" className="min-w-96 px-4 py-3">
                      Details
                    </th>
                    <th scope="col" className="w-36 px-4 py-3">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {alerts.map((alert) => (
                    <tr key={alert.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-4 text-gray-700">
                        <time dateTime={alert.triggered_at}>
                          {formatDate(alert.triggered_at)}
                        </time>
                      </td>
                      <td className="px-4 py-4 font-medium text-gray-950">
                        {alert.alert_type}
                      </td>
                      <td className="max-w-sm px-4 py-4">
                        {alert.source_url ? (
                          <a
                            href={alert.source_url}
                            target="_blank"
                            rel="noreferrer"
                            className="break-words text-blue-700 underline underline-offset-2 hover:text-blue-900"
                          >
                            {alert.source_url}
                          </a>
                        ) : (
                          <span className="text-gray-500">None</span>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <pre className="max-h-80 min-w-80 overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-5 text-gray-100">
                          {JSON.stringify(alert.details, null, 2)}
                        </pre>
                      </td>
                      <td className="px-4 py-4">
                        <button
                          type="button"
                          onClick={() => void acknowledgeAlert(alert.id)}
                          disabled={acknowledgingId === alert.id}
                          className="inline-flex min-h-9 items-center justify-center rounded-md bg-gray-950 px-3 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
                        >
                          {acknowledgingId === alert.id
                            ? 'Acknowledging...'
                            : 'Acknowledge'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
