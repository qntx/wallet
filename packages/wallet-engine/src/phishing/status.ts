/**
 * `blocked`: on the list. `trusted`: on the list, but the user trusts that origin. `clear`: not on
 * the list, or not a web page. `unchecked`: no list has been loaded yet.
 */
export type PhishingStatus = "blocked" | "trusted" | "clear" | "unchecked";

export const PHISHING_BLOCKED_MESSAGE = "origin is on the phishing list";
