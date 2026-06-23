// TODO task 3-2: replace with QueryInput component
import type { QueryRequest, QueryResponseData } from '@shared/types';

// Type references verify shared types are accessible from the frontend
type _QueryRequest = QueryRequest;
type _QueryResponseData = QueryResponseData;

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-gray-900">Policy Navigator</h1>
      <p className="mt-4 text-xl text-gray-700">
        Ask a question about Fairfax County policy
      </p>
    </main>
  );
}
