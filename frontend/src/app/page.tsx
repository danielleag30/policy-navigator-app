import QueryForm from '../components/QueryForm';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-gray-900 mb-2">Policy Navigator</h1>
      <p className="text-xl text-gray-600 mb-8">Ask a question about Fairfax County policy</p>
      <QueryForm />
    </main>
  );
}
