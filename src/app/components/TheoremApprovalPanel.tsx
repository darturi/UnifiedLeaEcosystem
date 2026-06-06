import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { ApprovalDecision, PendingApproval } from '../api';

export function TheoremApprovalPanel({
  approval,
  isSubmitting,
  error,
  onSubmit,
}: {
  approval: PendingApproval;
  isSubmitting: boolean;
  error?: string;
  onSubmit: (decision: ApprovalDecision, feedback?: string) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const trimmedFeedback = feedback.trim();

  const reject = async () => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    if (!trimmedFeedback) {
      return;
    }
    await onSubmit('reject', trimmedFeedback);
  };

  return (
    <div className="rounded-md border border-primary/30 bg-accent/70 p-4 text-foreground">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Review theorem translation</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {approval.theorem_name || 'Unnamed theorem'} · Candidate {approval.candidate}
          </div>
        </div>
        <div className="shrink-0 rounded-md bg-background px-2 py-1 text-xs text-muted-foreground">
          {approval.tier}
        </div>
      </div>

      <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-sm text-foreground">
        <code>{approval.lean_code}</code>
      </pre>

      {approval.check_result && (
        <div className="mt-3 rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
          <div className="mb-1 font-semibold uppercase tracking-wide text-foreground/70">
            Lean check
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono">
            {approval.check_result}
          </pre>
        </div>
      )}

      {showFeedback && (
        <div className="mt-3">
          <label className="mb-1 block text-sm text-muted-foreground" htmlFor="approval-feedback">
            Feedback for revised translation
          </label>
          <textarea
            id="approval-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={3}
            className={[
              'w-full resize-none rounded-md border border-border bg-input-background px-3 py-2',
              'text-sm focus:outline-none focus:ring-2 focus:ring-ring',
            ].join(' ')}
          />
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={reject}
          disabled={isSubmitting || (showFeedback && !trimmedFeedback)}
          className={[
            'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm',
            'transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-50',
          ].join(' ')}
        >
          <X className="h-4 w-4" />
          Reject
        </button>
        <button
          type="button"
          onClick={() => onSubmit('accept')}
          disabled={isSubmitting}
          className={[
            'inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm',
            'text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50',
          ].join(' ')}
        >
          <Check className="h-4 w-4" />
          Accept
        </button>
      </div>
    </div>
  );
}
