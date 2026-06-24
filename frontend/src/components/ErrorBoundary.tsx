'use client';
import { Component, ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="w-full max-w-2xl rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <p className="font-semibold text-red-700">Something went wrong.</p>
          <p className="mt-1 text-sm text-red-600">
            Reload the page to try again.
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-4 rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
