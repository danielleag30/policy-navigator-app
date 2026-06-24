import QueryForm from '../components/QueryForm';
import ProjectContext from '../components/ProjectContext';
import ErrorBoundary from '../components/ErrorBoundary';

export default function HomePage() {
  return (
    <ErrorBoundary>
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4 sm:gap-12 sm:p-8">
        <div className="w-full max-w-2xl min-w-0 flex flex-col items-center">
          <h1 className="text-center text-3xl font-bold text-gray-900 mb-2 sm:text-4xl">Policy Navigator</h1>
          <p className="text-center text-base text-gray-600 mb-6 sm:mb-8 sm:text-xl">Ask a question about Fairfax County policy</p>
          <QueryForm />
        </div>
        <ProjectContext />
      </main>
    </ErrorBoundary>
  );
}
