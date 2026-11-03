import { z } from "zod";

export const stopConversationAckSchema = z.object({
  conversationModeActive: z.boolean(),
});
