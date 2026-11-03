export function canAssignMeetingTaskToUser(input: {
  isConfidential: boolean;
  isMeetingParticipant: boolean;
  isWorkspaceMember: boolean;
}): boolean {
  return input.isMeetingParticipant || (!input.isConfidential && input.isWorkspaceMember);
}
