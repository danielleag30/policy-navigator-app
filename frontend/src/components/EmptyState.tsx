const EXAMPLES = [
  'What are the setback requirements for residential fences in Fairfax County?',
  'How does Fairfax County define a home occupation permit?',
  'What zoning districts allow short-term rentals in Fairfax County?',
];

export default function EmptyState() {
  return (
    <div className="w-full text-center">
      <p className="text-sm text-gray-500 mb-3">Try asking something like:</p>
      <ul className="flex flex-col gap-2">
        {EXAMPLES.map((q) => (
          <li key={q} className="text-sm text-gray-600 italic">
            &ldquo;{q}&rdquo;
          </li>
        ))}
      </ul>
    </div>
  );
}
