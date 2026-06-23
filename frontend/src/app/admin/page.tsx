// TODO task 3-10: render PendingAlert admin view

// Env var dependency established here; value is supplied by Vercel at build/runtime
const _supabaseUrl: string = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

export default function AdminPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-gray-900">Admin — Pending Alerts</h1>
      <p className="mt-4 text-xl text-gray-700">
        Alert management view (task 3-10)
      </p>
    </main>
  );
}
