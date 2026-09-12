"use client";

import { useAtomValue } from "jotai";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { connectionStateAtom } from "~/lib/data/atoms";
import { isChunkLoadError } from "~/lib/pwa/chunk-load-error";

type PageErrorBoundaryProps = {
  children: ReactNode;
  /** Changing this key clears a caught error, e.g. the current pathname. */
  resetKey: string;
};

type PageErrorBoundaryState = {
  error: unknown;
  resetKey: string;
};

/**
 * Keeps the app frame (header, sidebars) mounted when a page fails to
 * render, in place of the router's full-page default error component. The
 * most common failure is a code-split chunk that cannot be fetched while
 * offline; the copy distinguishes that case so real bugs are not hidden
 * behind an offline message.
 */
export class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromProps(
    props: PageErrorBoundaryProps,
    state: PageErrorBoundaryState,
  ): PageErrorBoundaryState | null {
    if (state.resetKey !== props.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error("Page render failed:", error, errorInfo.componentStack);
  }

  render() {
    if (this.state.error !== null) {
      return <PageErrorMessage error={this.state.error} />;
    }
    return this.props.children;
  }
}

export function getPageErrorCopy(input: {
  error: unknown;
  isDisconnected: boolean;
}) {
  if (isChunkLoadError(input.error)) {
    return input.isDisconnected
      ? "This content isn't available offline."
      : "This content couldn't load. Check your connection and try again.";
  }
  return "Something went wrong.";
}

function PageErrorMessage({ error }: { error: unknown }) {
  const connectionState = useAtomValue(connectionStateAtom);
  const copy = getPageErrorCopy({
    error,
    isDisconnected: connectionState === "disconnected",
  });

  return (
    <div className="flex flex-col items-center gap-4 p-6 text-center">
      <p>{copy}</p>
      {!isChunkLoadError(error) && (
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      )}
    </div>
  );
}
