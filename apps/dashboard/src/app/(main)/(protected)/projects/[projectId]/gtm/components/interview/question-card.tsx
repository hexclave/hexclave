"use client";

import { DesignBadge, DesignChoiceChip } from "@/components/design-components";
import { getPlanAnswer, type InterviewQuestionCard } from "@/lib/growth/growth-interview-chat";
import { GROWTH_INTERVIEW_OTHER_OPTION_ID, type GrowthInterviewQuestion } from "@/lib/growth/growth-types";
import { useState } from "react";
import { InterviewComposer } from "./composer";

export type InterviewAnswerDraft = {
  optionIds: string[],
  freeText: string | null,
  skipped: boolean,
};

const LEGACY_OTHER_OPTION_ID = "__growth_other__";

function isInterviewOtherOptionId(optionId: string): boolean {
  return optionId === LEGACY_OTHER_OPTION_ID || optionId.toLowerCase() === GROWTH_INTERVIEW_OTHER_OPTION_ID;
}

export function interviewOptionsWithOther(options: InterviewQuestionCard["options"], allowOther = true): InterviewQuestionCard["options"] {
  const existing = options.find((option) => option.id.toLowerCase() === GROWTH_INTERVIEW_OTHER_OPTION_ID);
  const ordinaryOptions = options.filter((option) => option.id.toLowerCase() !== GROWTH_INTERVIEW_OTHER_OPTION_ID);
  if (!allowOther) return ordinaryOptions;
  return [
    ...ordinaryOptions,
    {
      id: existing?.id ?? LEGACY_OTHER_OPTION_ID,
      label: "Other",
      description: existing?.description ?? "Write your own answer",
    },
  ];
}

export function buildInterviewAnswerDraft(selectedOptionIds: string[], freeText: string): InterviewAnswerDraft {
  const otherSelected = selectedOptionIds.some(isInterviewOtherOptionId);
  const optionIds = selectedOptionIds.filter((optionId) => optionId !== LEGACY_OTHER_OPTION_ID);
  const trimmedFreeText = freeText.trim();
  return {
    optionIds,
    freeText: otherSelected && trimmedFreeText.length > 0 ? trimmedFreeText : null,
    skipped: false,
  };
}

/**
 * One `present-interview-question` card in the transcript. The latest unanswered question renders
 * interactively (option chips + composer); every earlier card renders read-only with the answer the
 * plan recorded for it.
 */
export function InterviewQuestionCardView(props: {
  card: InterviewQuestionCard,
  /** The matching question-plan row; null when the card's key is missing from the plan (render-only fallback). */
  planQuestion: GrowthInterviewQuestion | null,
  interactive: boolean,
  disabled: boolean,
  onSubmit?: (draft: InterviewAnswerDraft) => Promise<void>,
}) {
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  // The stored plan is authoritative for whether staff enabled the free-text escape hatch. When a
  // legacy transcript cannot be matched to a plan row, retain the old always-Other render fallback.
  const allowOther = props.planQuestion == null
    ? true
    : props.planQuestion.options.some((option) => isInterviewOtherOptionId(option.id));
  const options = interviewOptionsWithOther(props.card.options, allowOther);
  const otherOptionId = options.find((option) => isInterviewOtherOptionId(option.id))?.id
    ?? null;

  const planAnswer = props.planQuestion == null ? null : getPlanAnswer(props.planQuestion);
  const answeredOptionIds = props.planQuestion?.answerOptionIds ?? [];
  const shownSelectedIds = props.interactive
    ? selectedOptionIds
    : otherOptionId != null && planAnswer?.freeText != null && !answeredOptionIds.some(isInterviewOtherOptionId)
      ? [...answeredOptionIds, otherOptionId]
      : answeredOptionIds;

  const toggleOption = (optionId: string) => {
    const deselectingOther = otherOptionId != null && optionId === otherOptionId && selectedOptionIds.includes(otherOptionId);
    const replacingOtherInSingleChoice = props.card.kind === "single" && (otherOptionId == null || optionId !== otherOptionId);
    if (deselectingOther || replacingOtherInSingleChoice) setFreeText("");
    setSelectedOptionIds((previous) => {
      return props.card.kind === "single"
        ? previous.includes(optionId) ? [] : [optionId]
        : previous.includes(optionId) ? previous.filter((id) => id !== optionId) : [...previous, optionId];
    });
  };

  const trimmedFreeText = freeText.trim();
  const otherSelected = otherOptionId != null && selectedOptionIds.includes(otherOptionId);
  const canConfirm = otherSelected ? trimmedFreeText.length > 0 : selectedOptionIds.length > 0;

  return (
    <div className="max-w-xl rounded-2xl border border-foreground/[0.08] bg-foreground/[0.02] p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-[65ch] text-pretty text-sm font-medium leading-6">{props.card.text}</p>
        {props.card.kind === "multi" && props.interactive && (
          <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">Select all that apply</span>
        )}
      </div>
      {options.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {options.map((option) => (
            <DesignChoiceChip
              key={option.id}
              label={option.label}
              description={option.description}
              selected={shownSelectedIds.includes(option.id)}
              interactive={props.interactive}
              disabled={props.disabled}
              onToggle={() => toggleOption(option.id)}
            />
          ))}
        </div>
      )}
      {props.interactive ? (
        <div className="mt-3">
          <InterviewComposer
            showOtherAnswer={otherSelected}
            allowSkip={props.card.allowSkip}
            canConfirm={canConfirm}
            freeText={freeText}
            onFreeTextChange={setFreeText}
            disabled={props.disabled}
            onConfirm={async () => {
              if (props.onSubmit == null) return;
              await props.onSubmit(buildInterviewAnswerDraft(selectedOptionIds, freeText));
            }}
            onSkip={async () => {
              if (props.onSubmit == null) return;
              await props.onSubmit({ optionIds: [], freeText: null, skipped: true });
            }}
          />
        </div>
      ) : (
        planAnswer != null && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {planAnswer.skipped ? (
              <DesignBadge label="Skipped" color="orange" size="sm" />
            ) : (
              <>
                <DesignBadge label="Answered" color="green" size="sm" />
                {planAnswer.freeText != null && <span className="italic">&ldquo;{planAnswer.freeText}&rdquo;</span>}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
