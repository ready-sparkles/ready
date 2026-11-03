import { z } from "zod";

const openAiResponseTextSchema = z.object({
  output_text: z.string().optional(),
});

const openAiOutputTextContentSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
});

const openAiMessageOutputSchema = z.object({
  type: z.literal("message"),
  content: z.array(z.unknown()),
});

const openAiResponseOutputSchema = z.object({
  output: z.array(z.unknown()).optional(),
});

export function parseResponseText(response: unknown): string {
  const parsedText = openAiResponseTextSchema.safeParse(response);
  const outputText = parsedText.success ? parsedText.data.output_text : undefined;
  if (outputText !== undefined && outputText.trim().length > 0) {
    return outputText;
  }

  const parsedOutput = openAiResponseOutputSchema.safeParse(response);
  const output = parsedOutput.success && parsedOutput.data.output !== undefined ? parsedOutput.data.output : [];

  return output
    .flatMap((item) => {
      const message = openAiMessageOutputSchema.safeParse(item);
      if (!message.success) {
        return [];
      }

      return message.data.content.flatMap((contentItem) => {
        const textContent = openAiOutputTextContentSchema.safeParse(contentItem);
        if (!textContent.success) {
          return [];
        }

        return [textContent.data.text];
      });
    })
    .join("\n")
    .trim();
}
