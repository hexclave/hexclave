import { urlString } from "@hexclave/shared/dist/utils/urls";
import { z } from "zod";
import { requestGrowthAdminJson } from "./growth-api";
import { GROWTH_INTERVIEW_QUESTION_KINDS, GROWTH_INTERVIEW_QUESTION_ORIGINS, GROWTH_INTERVIEW_STATUSES, type GrowthInterviewQuestionKind, type GrowthInterviewQuestionOrigin, type GrowthInterviewStatus } from "./growth-types";

const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullish(),
});

const questionSchema = z.object({
  id: z.string(),
  order_index: z.number().int().min(0),
  question_key: z.string(),
  prompt: z.string(),
  kind: z.enum(GROWTH_INTERVIEW_QUESTION_KINDS),
  options: z.array(optionSchema),
  allow_skip: z.boolean(),
  origin: z.enum(GROWTH_INTERVIEW_QUESTION_ORIGINS),
  answer_option_ids: z.array(z.string()).nullable(),
  answer_free_text: z.string().nullable(),
  answered_at_millis: z.number().nullable(),
});

const bodySchema = z.object({
  interview: z.object({
    id: z.string(),
    run_id: z.string(),
    run_status: z.string(),
    status: z.enum(GROWTH_INTERVIEW_STATUSES),
    created_at_millis: z.number(),
    released_at_millis: z.number().nullable(),
    released_by_user_id: z.string().nullable(),
    questions: z.array(questionSchema),
  }),
});

export type GrowthAdminInterviewOption = { id: string, label: string, description: string | null };

export type GrowthAdminInterviewQuestion = {
  id: string,
  orderIndex: number,
  questionKey: string,
  prompt: string,
  kind: GrowthInterviewQuestionKind,
  options: GrowthAdminInterviewOption[],
  allowSkip: boolean,
  origin: GrowthInterviewQuestionOrigin,
  answerOptionIds: string[] | null,
  answerFreeText: string | null,
  answeredAtMillis: number | null,
};

export type GrowthAdminInterview = {
  id: string,
  runId: string,
  runStatus: string,
  status: GrowthInterviewStatus,
  createdAtMillis: number,
  /** null means held: generated, but the customer has not been shown it. */
  releasedAtMillis: number | null,
  releasedByUserId: string | null,
  questions: GrowthAdminInterviewQuestion[],
};

function mapBody(value: z.infer<typeof bodySchema>): GrowthAdminInterview {
  const { interview } = value;
  return {
    id: interview.id,
    runId: interview.run_id,
    runStatus: interview.run_status,
    status: interview.status,
    createdAtMillis: interview.created_at_millis,
    releasedAtMillis: interview.released_at_millis,
    releasedByUserId: interview.released_by_user_id,
    questions: interview.questions.map((question) => ({
      id: question.id,
      orderIndex: question.order_index,
      questionKey: question.question_key,
      prompt: question.prompt,
      kind: question.kind,
      options: question.options.map((option) => ({ id: option.id, label: option.label, description: option.description ?? null })),
      allowSkip: question.allow_skip,
      origin: question.origin,
      answerOptionIds: question.answer_option_ids,
      answerFreeText: question.answer_free_text,
      answeredAtMillis: question.answered_at_millis,
    })),
  };
}

async function interviewBody(promise: Promise<unknown>): Promise<GrowthAdminInterview> {
  return mapBody(bodySchema.parse(await promise));
}

export async function getGrowthAdminInterview(app: object, projectId: string): Promise<GrowthAdminInterview> {
  return await interviewBody(requestGrowthAdminJson(app, urlString`/interview?project_id=${projectId}`));
}

export async function updateGrowthAdminInterviewQuestion(app: object, projectId: string, questionId: string, input: {
  prompt: string,
  options: GrowthAdminInterviewOption[],
  allowSkip: boolean,
}): Promise<GrowthAdminInterview> {
  return await interviewBody(requestGrowthAdminJson(app, urlString`/interview/questions/${questionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      target_project_id: projectId,
      prompt: input.prompt,
      // Dropped rather than sent as null: the wire schema takes an optional string, and a null would
      // fail validation on a question whose options carry no hint.
      options: input.options.map((option) => ({ id: option.id, label: option.label, ...option.description == null ? {} : { description: option.description } })),
      allow_skip: input.allowSkip,
    }),
  }));
}

export async function deleteGrowthAdminInterviewQuestion(app: object, projectId: string, questionId: string): Promise<GrowthAdminInterview> {
  return await interviewBody(requestGrowthAdminJson(app, urlString`/interview/questions/${questionId}`, {
    method: "DELETE",
    body: JSON.stringify({ target_project_id: projectId }),
  }));
}

export async function releaseGrowthAdminInterview(app: object, projectId: string): Promise<GrowthAdminInterview> {
  return await interviewBody(requestGrowthAdminJson(app, "/interview/release", {
    method: "POST",
    body: JSON.stringify({ target_project_id: projectId }),
  }));
}

/**
 * Throws the plan away and re-runs the questions phase. Returns the run's new state rather than the
 * plan, because there is no plan for a moment: the phase writes the replacement asynchronously, so
 * the card reloads until questions reappear (same contract as the customer's retake).
 */
export async function regenerateGrowthAdminInterview(app: object, projectId: string): Promise<{ status: string, runId: string }> {
  const parsed = z.object({ status: z.string(), run_id: z.string() }).parse(await requestGrowthAdminJson(app, "/interview/regenerate", {
    method: "POST",
    body: JSON.stringify({ target_project_id: projectId }),
  }));
  return { status: parsed.status, runId: parsed.run_id };
}
