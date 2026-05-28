/**
 * pending.ts — single-slot pending edit state.
 *
 * The REPL holds at most ONE pending edit at a time. When the backend
 * returns a code_edit, the REPL stores it here, renders the diff, prompts
 * the user, and on apply/reject/timeout fires the matching editor_event.
 *
 * After a successful apply, the AppliedEdit moves into `lastApplied` so
 * `/undo` can revert it.
 */

import type { CodeEditPayload, AppliedEdit } from "./diff.js";

export interface PendingEdit {
  payload:   CodeEditPayload;
  requestId: string;
  proposedAt: number;
}

export class PendingEditState {
  private pending: PendingEdit | null = null;
  private lastApplied: AppliedEdit | null = null;
  private lastAppliedRequestId: string | null = null;

  setPending(p: PendingEdit): void { this.pending = p; }
  getPending(): PendingEdit | null { return this.pending; }
  clearPending(): void { this.pending = null; }

  setLastApplied(applied: AppliedEdit, requestId: string): void {
    this.lastApplied = applied;
    this.lastAppliedRequestId = requestId;
  }
  getLastApplied(): { applied: AppliedEdit; requestId: string } | null {
    if (!this.lastApplied || !this.lastAppliedRequestId) return null;
    return { applied: this.lastApplied, requestId: this.lastAppliedRequestId };
  }
  clearLastApplied(): void {
    this.lastApplied = null;
    this.lastAppliedRequestId = null;
  }
}
