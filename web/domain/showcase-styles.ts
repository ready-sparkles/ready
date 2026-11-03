function isStylesheetElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement;
}

type StylesheetLoad = { loaded: Promise<boolean>; removeListeners: () => void };

function waitForStylesheetLoad(clone: HTMLElement): StylesheetLoad {
  if (clone.tagName !== "LINK") {
    return { loaded: Promise.resolve(true), removeListeners: () => {} };
  }
  const settle: { resolve: (isLoaded: boolean) => void } = { resolve: () => {} };
  const loaded = new Promise<boolean>((resolve) => {
    settle.resolve = resolve;
  });
  const handleLoad = (): void => {
    settle.resolve(true);
  };
  const handleError = (): void => {
    settle.resolve(false);
  };
  clone.addEventListener("load", handleLoad, { once: true });
  clone.addEventListener("error", handleError, { once: true });

  return {
    loaded,
    removeListeners: () => {
      clone.removeEventListener("load", handleLoad);
      clone.removeEventListener("error", handleError);
      settle.resolve(false);
    },
  };
}

// Keep the previous styles applied until every replacement stylesheet is ready.
export function copyShowcaseStyles(input: { source: Document; target: Document; onReady: () => void }): () => void {
  const previous = Array.from(input.target.head.querySelectorAll("[data-showcase-style]"));
  const clones = Array.from(input.source.head.querySelectorAll('style, link[rel="stylesheet"]')).flatMap((node) => {
    const clone = node.cloneNode(true);

    return isStylesheetElement(clone) ? [clone] : [];
  });
  const lifecycle = {
    isCancelled: false,
    isCommitted: false,
  };
  const loads = clones.map((clone) => {
    clone.setAttribute("data-showcase-style", "");

    return waitForStylesheetLoad(clone);
  });
  const removeAllListeners = (): void => {
    loads.forEach((load) => {
      load.removeListeners();
    });
  };
  const removeClones = (): void => {
    clones.forEach((clone) => {
      clone.remove();
    });
  };
  clones.forEach((clone) => {
    input.target.head.appendChild(clone);
  });

  const commitWhenLoaded = async (): Promise<void> => {
    const loadResults = await Promise.all(loads.map((load) => load.loaded));
    if (lifecycle.isCancelled) {
      return;
    }
    removeAllListeners();
    if (loadResults.some((isStylesheetLoaded) => !isStylesheetLoaded)) {
      removeClones();

      return;
    }
    lifecycle.isCommitted = true;
    previous.forEach((node) => {
      node.remove();
    });
    input.onReady();
  };
  void commitWhenLoaded();

  return (): void => {
    lifecycle.isCancelled = true;
    removeAllListeners();
    if (!lifecycle.isCommitted) {
      removeClones();
    }
  };
}
