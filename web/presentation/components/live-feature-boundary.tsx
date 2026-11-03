"use client";

import { Component, type ReactNode } from "react";

import { type OptionalLiveFeature, reportLiveFeatureRenderFailure } from "../lib/optional-live-feature-failure";

type LiveFeatureBoundaryProps = {
  feature: OptionalLiveFeature;
  children: ReactNode;
  onCatch?: () => void;
};

type LiveFeatureBoundaryState = {
  hasError: boolean;
};

export class LiveFeatureBoundary extends Component<LiveFeatureBoundaryProps, LiveFeatureBoundaryState> {
  state: LiveFeatureBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LiveFeatureBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    reportLiveFeatureRenderFailure({ error, feature: this.props.feature });
    this.props.onCatch?.();
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }

    return this.props.children;
  }
}
