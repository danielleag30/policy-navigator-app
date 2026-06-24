export default function ProjectContext() {
  return (
    <section
      aria-labelledby="project-context-heading"
      className="w-full max-w-2xl min-w-0 break-words border-t border-gray-200 pt-6 text-sm leading-6 text-gray-500"
    >
      <h2 id="project-context-heading" className="mb-2 text-sm font-semibold text-gray-700">
        About this project
      </h2>
      <p>
        Policy Navigator is a hybrid RAG (retrieval-augmented generation) system for querying
        Fairfax County, Virginia government documents using semantic and keyword search.
      </p>
      <p className="mt-2">
        The corpus covers Fairfax County ordinances via the Municode API, Board of Supervisors
        meeting minutes and summaries, and county budget PDFs. This is a portfolio/demo project.
      </p>
      <a
        href="https://github.com/danielleag30/policy-navigator-app"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex max-w-full break-all font-medium text-gray-700 underline underline-offset-4 hover:text-gray-900 sm:break-words"
      >
        View the source on GitHub
      </a>
    </section>
  );
}
