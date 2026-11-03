import type { z } from "zod";

const OPENAI_TEXT_FORMAT_NOT_CONFIGURED_MESSAGE = "OpenAI text format port is not configured.";

type OpenAITextFormatPort = {
  /* eslint-disable-next-line policy/named-parameters -- This matches the OpenAI zod text-format helper. */
  zodTextFormat(schema: z.ZodType, name: string): unknown;
};

const textFormatState: { port?: OpenAITextFormatPort } = {};

export function configureOpenAITextFormat(port: OpenAITextFormatPort): void {
  textFormatState.port = port;
}

/* eslint-disable-next-line policy/named-parameters -- Callers pass the OpenAI helper's schema and name. */
export function zodTextFormat(schema: z.ZodType, name: string): unknown {
  if (textFormatState.port === undefined) {
    throw new Error(OPENAI_TEXT_FORMAT_NOT_CONFIGURED_MESSAGE);
  }

  return textFormatState.port.zodTextFormat(schema, name);
}
