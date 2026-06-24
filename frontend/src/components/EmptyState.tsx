const EXAMPLES = [
  'What are the setback requirements for residential fences in Fairfax County?',
  'How does Fairfax County define a home occupation permit?',
  'What zoning districts allow short-term rentals in Fairfax County?',
];

export default function EmptyState() {
  return (
    <div className="w-full min-w-0 text-center">
      <p className="text-sm text-gray-500 mb-3 break-words">Try asking something like:</p>
      <ul className="flex flex-col gap-2">
        {EXAMPLES.map((q) => (
          <li key={q} className="break-words text-sm text-gray-600 italic">
            &ldquo;{q}&rdquo;
          </li>
        ))}
      </ul>
    </div>
  );
}
