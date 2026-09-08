"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard, DesignDialog, DesignDialogClose } from "@/components/design-components";
import { useRouter } from "@/components/router";
import { useGrowthStatus } from "@/lib/growth/growth-data";
import {
  countAnsweredQuestions,
  useGrowthInterviewChat,
  type InterviewAnswerInput,
  type UseGrowthInterviewChatResult,
} from "@/lib/growth/growth-interview-chat";
import { getGrowthDemoPhase } from "@/lib/growth/growth-mode";
import type { GrowthInterviewQuestion } from "@/lib/growth/growth-types";
import { ArrowRightIcon, ChatCircleDotsIcon, CheckCircleIcon, HourglassIcon, SkipForwardIcon } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { GrowthAppFrame } from "../components/frame";
import { InterviewTranscript } from "../components/interview/transcript";
import { GROWTH_HOLD_BODY } from "../components/report-hold";
import type { InterviewAnswerDraft } from "../components/interview/question-card";

export default function PageClient() {
  return (
    <GrowthAppFrame>
      <InterviewPage />
    </GrowthAppFrame>
  );
}

/**
 * Owns the interview chat state so the page header can host the skip action. It used to
 * sit in a row below the transcript, but the transcript grows by a question-and-answer pair every
 * turn, which pushed it further off-screen the longer the interview ran. The header keeps it at a
 * fixed, findable place.
 *
 * The "start/continue the interview" button deliberately stays at the bottom: it is the primary
 * flow action and belongs where the reader's eye already is, at the end of the transcript.
 */
function InterviewPage() {
  const app = useAdminApp();
  const projectId = useProjectId();
  const searchParams = useSearchParams();
  const { demo } = useGrowthStatus();
  const demoPhase = getGrowthDemoPhase(projectId, searchParams.get("demoPhase"));
  const chat = useGrowthInterviewChat({ app, demo, demoPhase });
  // Only offer skipping once there is an interview in progress: while loading, erroring, not-ready,
  // or already finished, it has nothing to act on.
  const actionable = chat.base.status === "loaded" && chat.view != null && !chat.view.completed;

  return (
    <PageLayout
      title="Growth Interview"
      description="A short interview so your report fits your business"
      actions={actionable
        ? <SkipInterviewDialog onConfirm={async () => await chat.skipAll()} disabled={chat.turn.status === "streaming"} />
        : undefined}
    >
      <InterviewPageBody chat={chat} />
    </PageLayout>
  );
}

/** Growth-internal links keep the query string so demo mode survives navigation between growth pages. */
function useGrowthHref() {
  const projectId = useProjectId();
  const searchParams = useSearchParams();
  return (subPath: string) => {
    const query = searchParams.toString();
    return `/projects/${projectId}/gtm${subPath}${query.length === 0 ? "" : `?${query}`}`;
  };
}

function GoToButton(props: { href: string, variant?: "default" | "outline", children: React.ReactNode }) {
  const router = useRouter();
  return (
    <DesignButton variant={props.variant ?? "default"} onClick={() => router.push(props.href)}>
      {props.children}
      <ArrowRightIcon className="ml-2 h-4 w-4" />
    </DesignButton>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the interview">
      <div className="h-12 w-2/3 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
      <div className="ml-auto h-10 w-1/3 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
      <div className="h-44 w-2/3 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
    </div>
  );
}

function NotReadyPanel() {
  const growthHref = useGrowthHref();
  return (
    <DesignCard title="Your interview is not ready yet" subtitle="The analysis is still preparing your questions" icon={HourglassIcon} gradient="cyan">
      <div className="flex max-w-xl flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          The interview questions are tailored to your product, so they are generated as part of the growth
          analysis. Once the analysis finishes, this page turns into a short chat.
        </p>
        <div>
          <GoToButton href={growthHref("")}>Back to the overview</GoToButton>
        </div>
      </div>
    </DesignCard>
  );
}

function CompletionPanel(props: { skipped: boolean, answeredCount: number, totalCount: number }) {
  const growthHref = useGrowthHref();
  const { data } = useGrowthStatus();
  const reportAvailable = data.status === "loaded" && data.value.latestReport != null;
  const held = data.status === "loaded" && data.value.release.state === "preparing";
  return (
    <DesignCard
      title={props.skipped ? "Interview skipped" : "Interview complete"}
      subtitle={props.skipped
        ? "Your report will be based on the analysis alone"
        : "Your answers are shaping your growth report"}
      icon={CheckCircleIcon}
      gradient="green"
    >
      <div className="flex max-w-xl flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <DesignBadge
            label={`${props.answeredCount} of ${props.totalCount} answered`}
            color={props.skipped ? "orange" : "green"}
            size="sm"
          />
          {!props.skipped && <span>Thanks — that context makes the report much sharper.</span>}
        </div>
        {/* The customer entered the loading state when deep analysis began. Repeat its expectation
          * here after submission so the handoff back to the overview does not look like the process
          * stopped. A later interview retake on an already-released workspace must not promise
          * another day of waiting. */}
        {!reportAvailable && held && <p className="text-sm text-muted-foreground">{GROWTH_HOLD_BODY}</p>}
        <div className="flex flex-wrap gap-2">
          {reportAvailable ? (
            <GoToButton href={growthHref("/report")}>Read your report</GoToButton>
          ) : (
            <GoToButton href={growthHref("")}>Back to the overview</GoToButton>
          )}
        </div>
      </div>
    </DesignCard>
  );
}

function SkipInterviewDialog(props: { onConfirm: () => Promise<void>, disabled: boolean }) {
  return (
    <DesignDialog
      trigger={
        <DesignButton variant="ghost" size="sm" disabled={props.disabled}>
          <SkipForwardIcon className="mr-1.5 h-4 w-4" />
          Skip the interview
        </DesignButton>
      }
      size="md"
      icon={SkipForwardIcon}
      title="Skip the interview?"
      description="Your growth report will be composed from the analysis alone."
      footer={
        <>
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm">Keep answering</DesignButton>
          </DesignDialogClose>
          <DesignDialogClose asChild>
            <DesignButton variant="destructive" size="sm" onClick={async () => await props.onConfirm()}>
              Skip interview
            </DesignButton>
          </DesignDialogClose>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        The answers you have already given are kept and will still be used. You cannot resume the interview
        after skipping it.
      </p>
    </DesignDialog>
  );
}

function InterviewPageBody(props: { chat: UseGrowthInterviewChatResult }) {
  const { chat } = props;
  const demo = chat.demo;

  if (chat.base.status === "loading") return <LoadingSkeleton />;
  if (chat.base.status === "error") {
    return (
      <DesignAlert variant="error" title="Could not load the interview" description={chat.base.message}>
        <div className="mt-2">
          <DesignButton variant="outline" size="sm" onClick={async () => await chat.reload()}>Retry</DesignButton>
        </div>
      </DesignAlert>
    );
  }
  if (chat.base.status === "not-ready") return <NotReadyPanel />;

  const view = chat.view;
  if (view == null) {
    // The hook guarantees a non-null view whenever base is loaded; encode that instead of rendering nothing.
    throw new Error("The interview view was missing despite the interview being loaded.");
  }
  const questions = chat.base.questions;
  const streaming = chat.turn.status === "streaming";
  const skipped = chat.base.interviewStatus === "skipped";

  const submitAnswer = async (planQuestion: GrowthInterviewQuestion, draft: InterviewAnswerDraft) => {
    const answer: InterviewAnswerInput = {
      orderIndex: planQuestion.orderIndex,
      ...draft.skipped ? { skipped: true } : {},
      ...draft.optionIds.length > 0 ? { optionIds: draft.optionIds } : {},
      ...draft.freeText != null ? { freeText: draft.freeText } : {},
    };
    await chat.sendAnswer(answer);
  };

  return (
    <div className="flex flex-col gap-5">
      {demo && (
        <p className="text-xs text-muted-foreground">
          Demo mode: answers are simulated locally and nothing is sent to the interview assistant.
        </p>
      )}
      <InterviewTranscript
        entries={view.entries}
        streamingEntries={chat.turn.status === "streaming" ? chat.turn.entries : []}
        thinking={streaming}
        questions={questions}
        planQuestionByEntryId={view.planQuestionByEntryId}
        activeQuestion={streaming ? null : view.activeQuestion}
        disabled={streaming}
        onSubmitAnswer={submitAnswer}
      />
      {chat.turn.status === "error" && (
        <DesignAlert
          variant="error"
          title="The interview assistant could not respond"
          description="Any answer you just confirmed was already saved before the assistant replied, so nothing is lost — reload to continue where you left off."
        >
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <DesignButton variant="outline" size="sm" onClick={async () => await chat.reload()}>Reload interview</DesignButton>
            <span className="text-xs text-muted-foreground">{chat.turn.message}</span>
          </div>
        </DesignAlert>
      )}
      {view.completed && (
        <CompletionPanel skipped={skipped} answeredCount={countAnsweredQuestions(questions)} totalCount={questions.length} />
      )}
      {/*
        Skip now lives in the page header (see InterviewPage); only the primary flow action
        stays here, at the end of the transcript the reader just finished. Rendered as its own
        conditional rather than a wrapper that can come out empty — an empty child would still eat
        one of the parent's gap-5 rows and leave a phantom gap under the transcript.
      */}
      {!view.completed && view.needsAssistantTurn && !streaming && chat.turn.status !== "error" && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <DesignButton size="sm" onClick={async () => await chat.requestAssistantTurn()}>
            <ChatCircleDotsIcon className="mr-1.5 h-4 w-4" />
            {view.entries.length === 0 ? "Start the interview" : "Continue the interview"}
          </DesignButton>
        </div>
      )}
    </div>
  );
}
