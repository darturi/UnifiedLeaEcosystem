import type { ApprovalEvent, ChatMessage, CodeStep, PendingApproval, StatusEvent } from './api';
import { buildStepTimeline } from './stepTimeline.mjs';

export interface RunAttempt {
  runId: string;
  attemptNumber: number | null;
}

export interface RunTimelineSection {
  id: string;
  attemptNumber: number | null;
  stepOffset: number;
  timeline: ReturnType<typeof buildStepTimeline>;
}

export function timelineIndexForCodeStep(
  sections: RunTimelineSection[],
  codeStepId: string,
): number | null {
  for (const section of sections) {
    const itemIndex = section.timeline.stepItems.findIndex(
      (item) => item.codeStep?.id === codeStepId,
    );
    if (itemIndex >= 0) {
      return section.stepOffset + itemIndex;
    }
  }
  return null;
}

export function buildRunAttempts({
  messages,
  codeSteps,
  statusEvents,
  approvalEvents,
  pendingApproval,
}: {
  messages: ChatMessage[];
  codeSteps: CodeStep[];
  statusEvents: StatusEvent[];
  approvalEvents: ApprovalEvent[];
  pendingApproval?: PendingApproval;
}): RunAttempt[] {
  const runIds: string[] = [];
  const runTimes = new Map<string, number>();

  const addRun = (runId?: string | null, createdAt?: string | null) => {
    if (!runId) {
      return;
    }
    if (!runIds.includes(runId)) {
      runIds.push(runId);
    }
    const parsed = Date.parse(createdAt || '');
    if (Number.isFinite(parsed)) {
      runTimes.set(runId, Math.min(runTimes.get(runId) ?? parsed, parsed));
    }
  };

  messages.forEach((message) => addRun(message.run_id, message.created_at));
  codeSteps.forEach((step) => addRun(step.run_id, step.created_at));
  statusEvents.forEach((event) => addRun(event.run_id, event.created_at));
  approvalEvents.forEach((approval) => addRun(approval.run_id, approval.resolved_at));
  addRun(pendingApproval?.run_id);

  runIds.sort((a, b) => (runTimes.get(a) ?? 0) - (runTimes.get(b) ?? 0));

  let proofAttemptNumber = 0;
  return runIds.map((runId) => {
    const hasProofActivity =
      codeSteps.some((step) => step.run_id === runId) ||
      statusEvents.some((event) => {
        if (event.run_id !== runId) {
          return false;
        }
        const status = String(event.status || '').toLowerCase();
        const message = String(event.message || '').toLowerCase();
        return status === 'turn_started' || message.includes('turn started');
      });
    if (hasProofActivity) {
      proofAttemptNumber += 1;
    }
    return {
      runId,
      attemptNumber: hasProofActivity ? proofAttemptNumber : null,
    };
  });
}

export function buildRunTimelineSections({
  messages,
  codeSteps,
  statusEvents,
  approvalEvents,
  pendingApproval,
  terminalMessageId,
}: {
  messages: ChatMessage[];
  codeSteps: CodeStep[];
  statusEvents: StatusEvent[];
  approvalEvents: ApprovalEvent[];
  pendingApproval?: PendingApproval;
  terminalMessageId: string | null;
}): RunTimelineSection[] {
  const runAttempts = buildRunAttempts({
    messages,
    codeSteps,
    statusEvents,
    approvalEvents,
    pendingApproval,
  });

  let stepOffset = 0;
  return runAttempts.map(({ runId, attemptNumber }) => {
    const runMessages = messages.filter((message) => message.run_id === runId);
    const runCodeSteps = codeSteps.filter((step) => step.run_id === runId);
    const runStatusEvents = statusEvents.filter((event) => event.run_id === runId);
    const runSystemTerminal = [...runMessages].reverse().find((message) => message.role === 'system');
    const runTerminalMessageId =
      terminalMessageId && runMessages.some((message) => message.id === terminalMessageId)
        ? terminalMessageId
        : runSystemTerminal?.id ?? null;
    const timeline = buildStepTimeline({
      messages: runMessages,
      codeSteps: runCodeSteps,
      statusEvents: runStatusEvents,
      terminalMessageId: runTerminalMessageId,
    });
    const section = {
      id: runId,
      attemptNumber,
      stepOffset,
      timeline,
    };
    stepOffset += timeline.stepItems.length;
    return section;
  });
}
