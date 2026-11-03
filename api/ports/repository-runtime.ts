import type { RepositoryPort } from "@readymeet/db/ports/repository";

const REPOSITORY_PORT_IS_NOT_CONFIGURED_MESSAGE = "Repository port is not configured.";

const repositoryState: { port: RepositoryPort | undefined } = { port: undefined };

export function configureRepositoryPort(port: RepositoryPort): void {
  repositoryState.port = port;
}

export function repositories(): RepositoryPort {
  if (repositoryState.port === undefined) {
    throw new Error(REPOSITORY_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return repositoryState.port;
}
