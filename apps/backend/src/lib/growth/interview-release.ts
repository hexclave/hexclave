import type { Tenancy } from "@/lib/tenancies";
import { GrowthRunStatus } from "@/generated/prisma/enums";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { normalizeGrowthInterviewOptionalOther } from "./interview-question-options";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";

type ReleasableInterview = { releasedAt: Date | null };

export function isGrowthInterviewReleased(interview: ReleasableInterview): boolean {
  return interview.releasedAt != null;
}


async function requireLatestGrowthInterview(tenancy: Tenancy) {
  const run = await globalPrismaClient.growthAnalysisRun.findFirst({
    where: { projectId: tenancy.project.id, branchId: tenancy.branchId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { interview: { include: { questions: { orderBy: { orderIndex: "asc" } } } } },
  });
  // A cancelled run is treated like no run at all, mirroring getGrowthStatusBody.
  if (run == null || run.status === GrowthRunStatus.CANCELLED || run.interview == null) {
    throw new StatusError(404, "This project has no interview to review yet.");
  }
  return { ...run, interview: run.interview };
}


function assertInterviewIsEditable(interview: ReleasableInterview) {
  if (isGrowthInterviewReleased(interview)) {
    throw new StatusError(409, "This interview has already been released to the customer and can no longer be edited.");
  }
}

type StoredOption = { id: string, label: string, description?: string };

function parseAnswerOptionIds(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HexclaveAssertionError("GrowthInterviewQuestion.answerOptionIds contains an unexpected value", { value });
  }
  return value;
}

export type GrowthAdminInterviewQuestionInput = {
  prompt: string,
  options: StoredOption[],
  allowSkip: boolean,
};

/** GET /internal/growth/admin/interview — the plan, plus the run context a reviewer needs to judge it. */
export async function getGrowthAdminInterviewBody(tenancy: Tenancy) {
  const run = await requireLatestGrowthInterview(tenancy);
  const { interview } = run;
  return {
    interview: {
      id: interview.id,
      run_id: run.id,
      run_status: run.status.toLowerCase(),
      status: interview.status,
      created_at_millis: interview.createdAt.getTime(),
      released_at_millis: interview.releasedAt == null ? null : interview.releasedAt.getTime(),
      released_by_user_id: interview.releasedByUserId,
      questions: interview.questions.map((question) => ({
        id: question.id,
        order_index: question.orderIndex,
        question_key: question.questionKey,
        prompt: question.prompt,
        kind: question.kind,
        // Passed through as stored: the wire mapper for the customer's copy (questionToWire in
        // interview.ts) validates the shape, and a reviewer must see exactly what is stored, not a
        // repaired version of it — the whole point of the review is to catch a bad plan.
        options: question.options,
        allow_skip: question.allowSkip,
        origin: question.origin,
        answer_option_ids: parseAnswerOptionIds(question.answerOptionIds),
        answer_free_text: question.answerFreeText,
        answered_at_millis: question.answeredAt == null ? null : question.answeredAt.getTime(),
      })),
    },
  };
}

async function requireQuestionInInterview(tenancy: Tenancy, questionId: string) {
  if (!isUuid(questionId)) throw new StatusError(404, "Interview question not found.");
  const run = await requireLatestGrowthInterview(tenancy);
  const question = run.interview.questions.find((candidate) => candidate.id === questionId);
  if (question == null) throw new StatusError(404, "Interview question not found.");
  return { run, question };
}


export async function updateGrowthAdminInterviewQuestion(tenancy: Tenancy, questionId: string, input: GrowthAdminInterviewQuestionInput) {
  const { run, question } = await requireQuestionInInterview(tenancy, questionId);
  assertInterviewIsEditable(run.interview);
  const optionIds = new Set(input.options.map((option) => option.id));
  if (optionIds.size !== input.options.length) {
    throw new StatusError(400, "Answer options must have unique ids.");
  }
  await globalPrismaClient.growthInterviewQuestion.update({
    where: { id: question.id },
    data: {
      prompt: input.prompt,
      options: normalizeGrowthInterviewOptionalOther(input.options)
        .map((option) => ({ id: option.id, label: option.label, description: option.description ?? null })),
      allowSkip: input.allowSkip,
    },
  });
  return await getGrowthAdminInterviewBody(tenancy);
}


export async function deleteGrowthAdminInterviewQuestion(tenancy: Tenancy, questionId: string) {
  const { run, question } = await requireQuestionInInterview(tenancy, questionId);
  assertInterviewIsEditable(run.interview);
  if (run.interview.questions.length <= 1) {
    throw new StatusError(400, "An interview needs at least one question. Regenerate the plan instead.");
  }
  await retryTransaction(globalPrismaClient, async (tx) => {
    await tx.growthInterviewQuestion.delete({ where: { id: question.id } });
    await tx.growthInterviewQuestion.updateMany({
      where: { interviewId: run.interview.id, orderIndex: { gt: question.orderIndex } },
      data: { orderIndex: { decrement: 1 } },
    });
  });
  return await getGrowthAdminInterviewBody(tenancy);
}


export async function releaseGrowthInterview(tenancy: Tenancy, options: { releasedByUserId: string | null, now: Date }) {
  const run = await requireLatestGrowthInterview(tenancy);
  if (isGrowthInterviewReleased(run.interview)) {
    throw new StatusError(409, "This interview is already released.");
  }
  if (run.interview.questions.length === 0) {
    throw new StatusError(400, "This interview has no questions to release.");
  }
  await globalPrismaClient.growthInterview.update({
    where: { id: run.interview.id },
    data: { releasedAt: options.now, releasedByUserId: options.releasedByUserId },
  });
  return await getGrowthAdminInterviewBody(tenancy);
}
