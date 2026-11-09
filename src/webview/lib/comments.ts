import { request } from "./bridge";
import type { Comment } from "../../shared/review";
export type { Comment };

export function listComments(plan: string): Promise<Comment[]> {
  return request<Comment[]>("listComments", { name: plan });
}

export function saveComments(plan: string, comments: Comment[]): Promise<void> {
  return request<void>("saveComments", { name: plan, comments });
}

/**
 * Ask the host to write `<plan>.review.md`, copy the refine prompt to the
 * clipboard, and type the apply trigger into the terminal. `injected` is true if
 * a terminal received the text; `command` is the text it received, which differs
 * per CLI (`/waypoint-apply` for Claude, `$waypoint-apply` for Codex), and
 * `agent` is which CLI the host believed was listening.
 */
export function sendReview(plan: string): Promise<{
  path: string;
  injected: boolean;
  sealedVersion: number;
  command?: string;
  agent?: string;
}> {
  return request("sendReview", { name: plan });
}
