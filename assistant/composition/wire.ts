import "../adapters/secondary/node/env";

import { configureMeetingContentKeys, repositoryPort } from "@readymeet/db";

import { createOpenAIClient } from "../adapters/secondary/openai/client";
import { withOpenAIRetry } from "../adapters/secondary/openai/openai-retry";
import { zodTextFormat } from "../adapters/secondary/openai/text-format";
import { openAIMemoryFetch } from "../adapters/secondary/undici/memory-fetch";
import { configureMemoryFetch } from "../ports/memory-fetch";
import { configureOpenAIClient } from "../ports/openai-client";
import { configureOpenAIRetry } from "../ports/openai-retry";
import { configureOpenAITextFormat } from "../ports/openai-text-format";
import { configureRepositoryPort } from "../ports/repository-runtime";

configureMeetingContentKeys();
configureRepositoryPort(repositoryPort);
configureOpenAIClient({ createOpenAIClient });
configureOpenAIRetry({ withOpenAIRetry });
configureOpenAITextFormat({ zodTextFormat });
configureMemoryFetch(openAIMemoryFetch);
