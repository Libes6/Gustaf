import { deleteSetting } from "./api";

/** Global default: off (the agent edits the project folder directly). */
export const REVIEW_COPY_DEFAULT = false;
export const REVIEW_COPY_KEY = "reviewCopy";
/** Removed per-chat override (the composer chip is gone); its stored value is ignored and deleted at startup. */
export const LEGACY_OVERRIDES_KEY = "chatReviewOverrides";

/** Whether a chat run works in a shadow copy: only the global setting, off unless set to exactly true. */
export const resolveReviewCopy = (global: unknown): boolean => global === true;

/** One-time cleanup of the old per-chat overrides; a failure is harmless (the value is never read). */
export const removeLegacyReviewOverrides = (): Promise<void> =>
  deleteSetting(LEGACY_OVERRIDES_KEY).then(
    () => {},
    () => {},
  );
