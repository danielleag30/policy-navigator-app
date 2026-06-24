import QueryForm from '../components/QueryForm';
import ProjectContext from '../components/ProjectContext';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-12 p-8">
      <div className="w-full max-w-2xl flex flex-col items-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">Policy Navigator</h1>
        <p className="text-xl text-gray-600 mb-8">Ask a question about Fairfax County policy</p>
        <QueryForm />
      </div>
      <ProjectContext />
    </main>
  );
}
