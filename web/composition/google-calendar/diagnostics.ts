import { addon } from "./addon";

export const debugIdentityAudience = (): string | string[] => addon().debugIdentityAudience();

export const debugVerify = (): void => {
  addon().debugVerify();
};
