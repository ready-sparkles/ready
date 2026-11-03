import { z } from "zod";

const DAYS_IN_WEEK = 7;
const MONTHS_IN_HALF_YEAR = 6;
const MONTHS_IN_YEAR = 12;

export const MAX_SELECTED_DONE_TASKS = 10_000;

export const clearDoneTasksRangeSchema = z.enum(["all", "week", "month", "six_months", "year"]);
export type ClearDoneTasksRange = z.infer<typeof clearDoneTasksRangeSchema>;
export const clearDoneTasksRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  range: clearDoneTasksRangeSchema,
});
export const clearDoneTasksResponseSchema = z.object({ completedBefore: z.string().datetime() });
export const selectedDoneTaskSchema = z.object({
  sourceType: z.enum(["meeting", "workspace"]),
  taskId: z.string().uuid(),
});
export const clearSelectedDoneTasksRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  tasks: z
    .array(selectedDoneTaskSchema)
    .min(1)
    .max(MAX_SELECTED_DONE_TASKS, "Select at most 10,000 tasks at once, or use Clear all done."),
});
export const clearSelectedDoneTasksResponseSchema = z.object({ tasks: z.array(selectedDoneTaskSchema) });
export type SelectedDoneTask = z.infer<typeof selectedDoneTaskSchema>;

/** Calendar-month cutoffs, clamped at month end, shared by the menu and server. */
export function getDoneTasksCutoff(input: { range: ClearDoneTasksRange; now?: Date }): Date {
  const cutoff = new Date(input.now ?? new Date());
  if (input.range === "week") {
    cutoff.setUTCDate(cutoff.getUTCDate() - DAYS_IN_WEEK);
  }
  if (input.range === "month" || input.range === "six_months" || input.range === "year") {
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(
      cutoff.getUTCMonth() -
        (input.range === "month" ? 1 : input.range === "six_months" ? MONTHS_IN_HALF_YEAR : MONTHS_IN_YEAR),
    );
    const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
    cutoff.setUTCDate(Math.min(day, lastDay));
  }

  return cutoff;
}
