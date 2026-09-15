"use client";

import {
  ArrowLeftIcon,
  BroadcastIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CloudSlashIcon,
  ConfettiIcon,
  CornersInIcon,
  CornersOutIcon,
  PauseIcon,
  PlayIcon,
  WarningCircleIcon,
  WifiHighIcon,
} from "@phosphor-icons/react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  TvPresentedEventHighlight,
  TvPresentedTakeover,
  TvScreenId,
  TvScreenSnapshot,
  TvSnapshot,
} from "@/lib/tv-mode/types";
import { getNextTvScreenIndex, selectTvPresentationView } from "./presentation-controller";
import { getTvScreenDefinition, renderTvScreen } from "./screen-registry";

function getScreen(snapshot: TvSnapshot, screenIndex: number): TvScreenSnapshot | null {
  const screenId = snapshot.profile.playlist.at(screenIndex);
  return screenId == null ? null : snapshot.screens.find((candidate) => candidate.id === screenId) ?? null;
}

function formatFixtureTime(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(isoDate));
}

function PresentationStatus({ snapshot }: { snapshot: TvSnapshot }) {
  if (snapshot.connectionStatus === "offline") {
    return (
      <div className="flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-4 py-2 text-[clamp(0.7rem,0.8vw,1.9rem)] font-medium text-amber-100">
        <CloudSlashIcon className="h-[1.15em] w-[1.15em]" weight="bold" />
        Offline · showing the last safe snapshot
      </div>
    );
  }
  if (snapshot.connectionStatus === "stale") {
    return (
      <div className="flex items-center gap-2 rounded-full border border-orange-300/20 bg-orange-300/10 px-4 py-2 text-[clamp(0.7rem,0.8vw,1.9rem)] font-medium text-orange-100">
        <WarningCircleIcon className="h-[1.15em] w-[1.15em]" weight="fill" />
        Data is stale
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[clamp(0.68rem,0.78vw,1.8rem)] text-white/[0.38]">
      <WifiHighIcon className="h-[1.15em] w-[1.15em] text-emerald-300/70" weight="bold" />
      Updated {formatFixtureTime(snapshot.generatedAt)}
    </div>
  );
}

function EventHighlight({ highlight }: { highlight: TvPresentedEventHighlight }) {
  const isCelebration = highlight.variant === "celebration";
  const isResolved = highlight.variant === "resolved-incident";
  const isCritical = highlight.event.presentationClass === "critical-incident";
  const usesWideLayout = highlight.event.title.length > 52 || highlight.event.summary.length > 88;
  const tone = isCelebration
    ? "border-amber-200/20 bg-[radial-gradient(circle_at_10%_10%,rgba(251,191,36,0.18),transparent_55%),rgba(24,18,9,0.84)] text-amber-100"
    : isResolved
      ? "border-emerald-200/20 bg-[radial-gradient(circle_at_10%_10%,rgba(52,211,153,0.15),transparent_55%),rgba(8,24,18,0.84)] text-emerald-100"
      : "border-rose-200/20 bg-[radial-gradient(circle_at_10%_10%,rgba(251,113,133,0.16),transparent_55%),rgba(28,10,15,0.86)] text-rose-100";
  return (
    <motion.aside
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      className={`pointer-events-none rounded-[clamp(1rem,1.2vw,2.5rem)] border p-[clamp(0.8rem,1vw,2.2rem)] shadow-2xl backdrop-blur-2xl ${
        usesWideLayout ? "w-[clamp(34rem,44vw,88rem)]" : "w-[clamp(28rem,36vw,72rem)]"
      } ${tone}`}
    >
      <div className="flex items-start gap-4">
        <div className="flex h-[clamp(2.5rem,3vw,6rem)] w-[clamp(2.5rem,3vw,6rem)] shrink-0 items-center justify-center rounded-xl bg-current/10">
          {isCelebration ? <ConfettiIcon className="h-1/2 w-1/2" weight="fill" /> : isResolved ? <CheckCircleIcon className="h-1/2 w-1/2" weight="fill" /> : <WarningCircleIcon className="h-1/2 w-1/2" weight="fill" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 text-[clamp(0.62rem,0.68vw,1.5rem)] font-semibold uppercase tracking-[0.16em]">
            <span>{isCelebration ? "Event Highlight" : isResolved ? "Restored" : isCritical ? "Active Critical Incident" : "Active Incident"}</span>
            <span className="text-white/35">{formatFixtureTime(highlight.event.updatedAt)}</span>
          </div>
          <h2 className="mt-[clamp(0.4rem,0.55vw,1rem)] line-clamp-2 text-[clamp(1rem,1.28vw,3rem)] font-semibold leading-[1.08] text-white">{highlight.event.title}</h2>
          <p className="mt-[clamp(0.35rem,0.5vw,0.9rem)] line-clamp-2 text-[clamp(0.72rem,0.8vw,1.85rem)] leading-snug text-white/55">{highlight.event.summary}</p>
          <div className="mt-[clamp(0.55rem,0.7vw,1.25rem)] flex items-end justify-between gap-4 border-t border-white/10 pt-[clamp(0.55rem,0.7vw,1.25rem)] text-[clamp(0.68rem,0.76vw,1.8rem)]">
            <span className="truncate text-white/40">{highlight.event.sourceLabel}</span>
            <span className="shrink-0 text-right font-semibold tabular-nums text-white/85">
              {highlight.event.metricLabel} · {highlight.event.metricValue}
              {highlight.event.expectedRange == null ? null : <span className="ml-2 font-normal text-white/[0.38]">· {highlight.event.expectedRange}</span>}
            </span>
          </div>
        </div>
      </div>
    </motion.aside>
  );
}

function EventTakeover({ takeover }: { takeover: TvPresentedTakeover }) {
  const isCelebration = takeover.variant === "celebration";
  const isRecovery = takeover.variant === "recovery-confirmation";
  const isCritical = takeover.variant === "critical-incident";
  return (
    <section className={`relative flex h-full flex-col overflow-hidden px-[clamp(2rem,6vw,8rem)] py-[clamp(2rem,6vh,6rem)] ${
      isCelebration
        ? "bg-[radial-gradient(circle_at_12%_42%,rgba(245,158,11,0.2),transparent_28%),radial-gradient(circle_at_88%_38%,rgba(251,191,36,0.18),transparent_30%),radial-gradient(circle_at_50%_0%,rgba(251,191,36,0.36),transparent_46%),linear-gradient(145deg,#2b1b06,#070912_62%)]"
        : isRecovery
          ? "bg-[radial-gradient(circle_at_50%_0%,rgba(52,211,153,0.25),transparent_45%),linear-gradient(145deg,#082019,#070912_60%)]"
          : "bg-[radial-gradient(circle_at_50%_0%,rgba(244,63,94,0.28),transparent_45%),linear-gradient(145deg,#240a12,#090910_60%)]"
    }`}>
      <div className={`absolute left-1/2 top-0 h-[45vw] w-[45vw] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl ${isCelebration ? "bg-amber-300/10" : isRecovery ? "bg-emerald-300/10" : "bg-rose-400/10"}`} />
      {isCelebration ? (
        <>
          <div className="absolute -left-[8vw] top-[18%] h-[32vw] w-[32vw] rounded-full bg-amber-400/[0.08] blur-[clamp(4rem,8vw,14rem)]" />
          <div className="absolute -right-[10vw] top-[24%] h-[34vw] w-[34vw] rounded-full bg-orange-300/[0.07] blur-[clamp(4rem,8vw,14rem)]" />
        </>
      ) : null}
      <div className="relative flex items-center justify-between">
        <div className={`flex items-center gap-3 text-[clamp(0.7rem,0.9vw,1.05rem)] font-semibold uppercase tracking-[0.25em] ${isCelebration ? "text-amber-200" : isRecovery ? "text-emerald-200" : "text-rose-200"}`}>
          {isCelebration ? <ConfettiIcon className="h-[1.4em] w-[1.4em]" weight="fill" /> : isRecovery ? <CheckCircleIcon className="h-[1.4em] w-[1.4em]" weight="fill" /> : <BroadcastIcon className="h-[1.4em] w-[1.4em]" weight="fill" />}
          {isCelebration ? "Company Milestone" : isRecovery ? "Recovery Confirmed" : isCritical ? "Critical Incident" : "Incident"}
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[clamp(0.68rem,0.8vw,0.95rem)] text-white/45">
          {takeover.event.sourceLabel}
        </div>
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center text-center">
        <div className={`mb-[clamp(1.5rem,3vh,3rem)] flex h-[clamp(4rem,7vw,8rem)] w-[clamp(4rem,7vw,8rem)] items-center justify-center rounded-[2rem] border ${
          isCelebration
            ? "border-amber-200/20 bg-amber-300/10 text-amber-100"
            : isRecovery
              ? "border-emerald-200/20 bg-emerald-300/10 text-emerald-100"
              : "border-rose-200/20 bg-rose-300/10 text-rose-100"
        }`}>
          {isCelebration ? <ConfettiIcon className="h-1/2 w-1/2" weight="fill" /> : isRecovery ? <CheckCircleIcon className="h-1/2 w-1/2" weight="fill" /> : <WarningCircleIcon className="h-1/2 w-1/2" weight="fill" />}
        </div>
        <h1 className="max-w-[14ch] text-[clamp(3rem,7vw,9rem)] font-semibold leading-[0.9] tracking-[-0.065em] text-white">
          {takeover.event.title}
        </h1>
        <p className="mt-[clamp(1.5rem,3vh,3rem)] max-w-[48rem] text-[clamp(1rem,1.5vw,1.8rem)] leading-relaxed text-white/[0.52]">
          {takeover.event.summary}
        </p>
        <div className="mt-[clamp(2rem,5vh,5rem)]">
          <p className="text-[clamp(0.68rem,0.85vw,1rem)] font-semibold uppercase tracking-[0.2em] text-white/[0.38]">{takeover.event.metricLabel}</p>
          <p className={`mt-2 text-[clamp(2.5rem,5vw,6rem)] font-semibold tabular-nums tracking-[-0.045em] ${isCelebration ? "text-amber-100" : isRecovery ? "text-emerald-100" : "text-rose-100"}`}>
            {takeover.event.metricValue}
          </p>
          {takeover.event.expectedRange == null ? null : <p className="mt-3 text-[clamp(0.75rem,0.9vw,1.25rem)] text-white/[0.42]">{takeover.event.expectedRange}</p>}
        </div>
      </div>

      <div className="relative flex items-center justify-between text-[clamp(0.7rem,0.8vw,0.95rem)] text-white/35">
        <span>Returning to the playlist automatically</span>
        <span>Observed {formatFixtureTime(takeover.event.occurredAt)}</span>
      </div>
    </section>
  );
}

type FireworkParticle = {
  x: number,
  y: number,
  previousX: number,
  previousY: number,
  velocityX: number,
  velocityY: number,
  age: number,
  lifetime: number,
  radius: number,
  color: string,
};

type FireworkRocket = {
  x: number,
  y: number,
  previousX: number,
  previousY: number,
  targetY: number,
  velocityY: number,
  color: string,
  burstSize: number,
};

type ConfettiParticle = FireworkParticle & {
  width: number,
  rotation: number,
  rotationVelocity: number,
};

function CelebrationFireworks({
  ambientActive,
  eventId,
  entryBurst,
  foreground = false,
  takeoverActive = false,
}: {
  ambientActive: boolean,
  eventId: string | null,
  entryBurst: boolean,
  foreground?: boolean,
  takeoverActive?: boolean,
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if ((!ambientActive && !entryBurst) || canvas == null) return;
    const context = canvas.getContext("2d");
    if (context == null) return;
    let animationFrame = 0;
    let previousFrameAt = performance.now();
    let nextBurstAt = ambientActive
      ? previousFrameAt + (takeoverActive ? 250 : foreground ? 3_800 : 650)
      : Number.POSITIVE_INFINITY;
    let visible = document.visibilityState === "visible";
    const particles: FireworkParticle[] = [];
    const rockets: FireworkRocket[] = [];
    const confetti: ConfettiParticle[] = [];
    const colors = ["#fef3c7", "#fde68a", "#fbbf24", "#f59e0b", "#fff7ed"];

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const getViewportScale = () => Math.min(2, Math.max(1, canvas.clientWidth / 1920));
    const burst = (x: number, y: number, count: number, scale = 1) => {
      const particleCap = takeoverActive ? 260 : foreground ? 42 : 220;
      const available = Math.max(0, particleCap - particles.length);
      const visualScale = scale * getViewportScale();
      for (let index = 0; index < Math.min(count, available); index += 1) {
        const angle = (Math.PI * 2 * index) / count + Math.random() * 0.18;
        const speed = (34 + Math.random() * 74) * visualScale;
        particles.push({
          x,
          y,
          previousX: x,
          previousY: y,
          velocityX: Math.cos(angle) * speed,
          velocityY: Math.sin(angle) * speed,
          age: 0,
          lifetime: 1.9 + Math.random() * 1.35,
          radius: (1.15 + Math.random() * 2.1) * visualScale,
          color: colors[Math.floor(Math.random() * colors.length)] ?? "#fde68a",
        });
      }
    };
    const launchRocket = (x: number, targetY: number, burstSize: number) => {
      if (rockets.length >= (takeoverActive ? 7 : foreground ? 3 : 5)) return;
      const visualScale = getViewportScale();
      const color = colors[Math.floor(Math.random() * colors.length)] ?? "#fde68a";
      rockets.push({
        x,
        y: canvas.clientHeight * (0.96 + Math.random() * 0.08),
        previousX: x,
        previousY: canvas.clientHeight,
        targetY,
        velocityY: -(260 + Math.random() * 90) * visualScale,
        color,
        burstSize,
      });
    };
    const launchConfetti = (side: "left" | "right") => {
      const visualScale = getViewportScale();
      const direction = side === "left" ? 1 : -1;
      const x = side === "left" ? canvas.clientWidth * 0.025 : canvas.clientWidth * 0.975;
      const available = Math.max(0, 150 - confetti.length);
      for (let index = 0; index < Math.min(68, available); index += 1) {
        const y = canvas.clientHeight * (0.48 + Math.random() * 0.32);
        confetti.push({
          x,
          y,
          previousX: x,
          previousY: y,
          velocityX: direction * (125 + Math.random() * 240) * visualScale,
          velocityY: -(170 + Math.random() * 300) * visualScale,
          age: 0,
          lifetime: 2.8 + Math.random() * 1.6,
          radius: 1,
          width: (5 + Math.random() * 8) * visualScale,
          rotation: Math.random() * Math.PI,
          rotationVelocity: (Math.random() - 0.5) * 12,
          color: colors[Math.floor(Math.random() * colors.length)] ?? "#fde68a",
        });
      }
    };
    resize();
    if (entryBurst) {
      launchConfetti("left");
      launchConfetti("right");
      launchRocket(canvas.clientWidth * 0.14, canvas.clientHeight * 0.28, 72);
      launchRocket(canvas.clientWidth * 0.32, canvas.clientHeight * 0.18, 64);
      launchRocket(canvas.clientWidth * 0.68, canvas.clientHeight * 0.2, 64);
      launchRocket(canvas.clientWidth * 0.86, canvas.clientHeight * 0.3, 72);
    }

    const handleVisibility = () => {
      visible = document.visibilityState === "visible";
      previousFrameAt = performance.now();
    };
    const render = (now: number) => {
      animationFrame = window.requestAnimationFrame(render);
      if (!visible || now - previousFrameAt < 1000 / 30) return;
      const elapsed = Math.min((now - previousFrameAt) / 1000, 0.08);
      previousFrameAt = now;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const viewportScale = getViewportScale();
      context.clearRect(0, 0, width, height);
      if (now >= nextBurstAt) {
        const edgeBiasedX = takeoverActive
          ? width * (Math.random() < 0.5 ? 0.08 + Math.random() * 0.28 : 0.64 + Math.random() * 0.28)
          : width * (0.08 + Math.random() * 0.84);
        launchRocket(
          edgeBiasedX,
          height * (0.12 + Math.random() * 0.48),
          takeoverActive ? 60 + Math.floor(Math.random() * 34) : foreground ? 12 + Math.floor(Math.random() * 10) : 42 + Math.floor(Math.random() * 28),
        );
        if (!takeoverActive && !foreground) {
          launchRocket(
            width * (0.08 + Math.random() * 0.84),
            height * (0.12 + Math.random() * 0.48),
            42 + Math.floor(Math.random() * 28),
          );
        }
        nextBurstAt = now + (foreground
          ? takeoverActive ? 1_350 + Math.random() * 2_250 : 6_000 + Math.random() * 5_000
          : 2_100 + Math.random() * 3_900);
      }
      context.globalCompositeOperation = "lighter";
      for (let index = rockets.length - 1; index >= 0; index -= 1) {
        const rocket = rockets[index];
        rocket.previousX = rocket.x;
        rocket.previousY = rocket.y;
        rocket.y += rocket.velocityY * elapsed;
        rocket.velocityY += 55 * viewportScale * elapsed;
        context.beginPath();
        context.strokeStyle = rocket.color;
        context.globalAlpha = takeoverActive ? 0.8 : foreground ? 0.35 : 0.62;
        context.lineWidth = (takeoverActive ? 2.8 : 1.8) * getViewportScale();
        context.shadowColor = rocket.color;
        context.shadowBlur = takeoverActive ? 18 : 10;
        context.moveTo(rocket.previousX, rocket.previousY + 18);
        context.lineTo(rocket.x, rocket.y);
        context.stroke();
        if (rocket.y <= rocket.targetY || rocket.velocityY >= -25) {
          burst(rocket.x, rocket.y, rocket.burstSize, takeoverActive ? 1.22 : 1);
          rockets.splice(index, 1);
        }
      }
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.age += elapsed;
        if (particle.age >= particle.lifetime) {
          particles.splice(index, 1);
          continue;
        }
        particle.velocityY += 24 * viewportScale * elapsed;
        particle.previousX = particle.x;
        particle.previousY = particle.y;
        particle.x += particle.velocityX * elapsed;
        particle.y += particle.velocityY * elapsed;
        particle.velocityX *= 0.992;
        const opacity = Math.max(0, 1 - particle.age / particle.lifetime) * (takeoverActive ? 0.78 : foreground ? 0.22 : 0.58);
        context.beginPath();
        context.strokeStyle = particle.color;
        context.globalAlpha = opacity * 0.45;
        context.lineWidth = Math.max(0.75, particle.radius * 0.62);
        context.moveTo(particle.previousX, particle.previousY);
        context.lineTo(particle.x, particle.y);
        context.stroke();
        context.beginPath();
        context.fillStyle = particle.color;
        context.globalAlpha = opacity;
        context.shadowColor = particle.color;
        context.shadowBlur = takeoverActive ? 16 : 9;
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalCompositeOperation = "source-over";
      context.shadowBlur = 0;
      for (let index = confetti.length - 1; index >= 0; index -= 1) {
        const particle = confetti[index];
        particle.age += elapsed;
        if (particle.age >= particle.lifetime) {
          confetti.splice(index, 1);
          continue;
        }
        particle.velocityY += 190 * viewportScale * elapsed;
        particle.velocityX *= 0.986;
        particle.x += particle.velocityX * elapsed;
        particle.y += particle.velocityY * elapsed;
        particle.rotation += particle.rotationVelocity * elapsed;
        const opacity = Math.max(0, 1 - particle.age / particle.lifetime);
        context.save();
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.fillStyle = particle.color;
        context.globalAlpha = opacity * 0.88;
        context.fillRect(-particle.width / 2, -2, particle.width, 4);
        context.restore();
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    };

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibility);
    animationFrame = window.requestAnimationFrame(render);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    };
  }, [ambientActive, entryBurst, eventId, foreground, takeoverActive]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-celebration-layer={foreground ? "foreground" : "background"}
      data-ambient-effects={ambientActive ? "active" : "inactive"}
      data-entry-burst={entryBurst ? "active" : "inactive"}
      data-takeover-effects={takeoverActive ? "active" : "inactive"}
      className={`pointer-events-none absolute inset-0 h-full w-full ${foreground ? "z-[15] opacity-80" : "z-[5] opacity-100"}`}
    />
  );
}

function getDeadlineReferenceTime(generatedAt: string | null, previewData: boolean): number {
  return previewData && generatedAt != null
    ? new Date(generatedAt).getTime()
    : new Date().getTime();
}

function useAuthoritativeDeadlineActive(
  deadline: string | null,
  generatedAt: string | null,
  previewData: boolean,
): boolean {
  const [active, setActive] = useState(() => (
    deadline != null
    && generatedAt != null
    && new Date(deadline).getTime() > getDeadlineReferenceTime(generatedAt, previewData)
  ));
  useEffect(() => {
    if (deadline == null || generatedAt == null) {
      setActive(false);
      return;
    }
    // Synthetic previews use their deterministic fixture clock. Live playback
    // compares with receipt-time wall clock so transport latency cannot extend
    // a server-assigned absolute presentation deadline.
    const remainingMilliseconds = Math.max(
      0,
      new Date(deadline).getTime() - getDeadlineReferenceTime(generatedAt, previewData),
    );
    setActive(remainingMilliseconds > 0);
    if (remainingMilliseconds === 0) return;
    const timeout = window.setTimeout(() => setActive(false), remainingMilliseconds);
    return () => window.clearTimeout(timeout);
  }, [deadline, generatedAt, previewData]);
  return active;
}

function PresentationMessage({
  type,
  title,
  message,
}: {
  type: "loading" | "empty" | "error",
  title: string,
  message: string,
}) {
  const Icon = type === "error" ? WarningCircleIcon : type === "empty" ? CheckCircleIcon : BroadcastIcon;
  return (
    <div className="flex h-full items-center justify-center bg-[#070910] px-8 text-center text-white">
      <div className="max-w-2xl">
        <div className={`mx-auto flex h-20 w-20 items-center justify-center rounded-[1.75rem] border ${
          type === "error" ? "border-rose-300/20 bg-rose-300/10 text-rose-200" : "border-white/10 bg-white/[0.04] text-white/65"
        }`}>
          <Icon className={`h-10 w-10 ${type === "loading" ? "animate-pulse motion-reduce:animate-none" : ""}`} weight="fill" />
        </div>
        <h1 className="mt-8 text-[clamp(2.4rem,5vw,5.5rem)] font-semibold tracking-[-0.055em]">{title}</h1>
        <p className="mt-5 text-[clamp(0.95rem,1.35vw,1.5rem)] leading-relaxed text-white/45">{message}</p>
      </div>
    </div>
  );
}

export function TvPresentation({
  snapshot,
  loading = false,
  unavailableReason = null,
  onExit,
  initialScreenId,
  previewData = false,
}: {
  snapshot: TvSnapshot | null,
  loading?: boolean,
  unavailableReason?: "offline" | "error" | "unauthorized" | null,
  onExit?: () => void,
  initialScreenId?: TvScreenId,
  previewData?: boolean,
}) {
  const reducedMotion = useReducedMotion();
  const [screenIndex, setScreenIndex] = useState(0);
  const [completedTakeoverKey, setCompletedTakeoverKey] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [controlsShowVersion, setControlsShowVersion] = useState(0);
  const [rotationPaused, setRotationPaused] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const missingScreenReportKeyRef = useRef<string | null>(null);
  const profileId = snapshot?.profile.id;
  const playlistKey = snapshot?.profile.playlist.join("\u0000");

  // Polling replaces the snapshot object every 15 seconds. Reset only when the
  // presentation configuration changes so a data refresh cannot restart the
  // rotation timer or send a manually selected screen back to the first slide.
  useEffect(() => {
    const requestedIndex = initialScreenId == null
      ? 0
      : playlistKey?.split("\u0000").indexOf(initialScreenId) ?? -1;
    setScreenIndex(requestedIndex < 0 ? 0 : requestedIndex);
    setRotationPaused(false);
  }, [initialScreenId, playlistKey, profileId]);

  const assignedTakeover = snapshot?.presentation.takeover ?? null;
  const takeoverKey = assignedTakeover == null
    ? null
    : [
      assignedTakeover.event.id,
      assignedTakeover.variant,
      assignedTakeover.startedAt,
      assignedTakeover.endsAt,
    ].join("\u0000");
  const boundedTakeoverCompleted = takeoverKey != null && completedTakeoverKey === takeoverKey;
  const view = useMemo(
    () => snapshot == null
      ? null
      : selectTvPresentationView(snapshot, screenIndex, boundedTakeoverCompleted),
    [boundedTakeoverCompleted, screenIndex, snapshot],
  );
  const viewType = view?.type;
  const takeoverEndsAt = view?.type === "takeover" ? view.presentedTakeover.endsAt : null;
  const takeoverEventId = view?.type === "takeover"
    ? view.presentedTakeover.event.id
    : null;
  const generatedAt = snapshot?.generatedAt ?? null;
  const highlight = snapshot?.presentation.highlight ?? null;
  const timedHighlightVisible = useAuthoritativeDeadlineActive(highlight?.expiresAt ?? null, generatedAt, previewData);
  const highlightVisible = highlight != null
    && (highlight.expiresAt == null || timedHighlightVisible);
  const animationVisible = useAuthoritativeDeadlineActive(highlight?.animationExpiresAt ?? null, generatedAt, previewData);
  const takeoverIsCelebration = view?.type === "takeover" && view.presentedTakeover.variant === "celebration";
  const celebrationAnimationEligible = highlight?.variant === "celebration" && animationVisible;
  const celebrationAnimationActive = reducedMotion !== true
    && celebrationAnimationEligible
    && (view?.type !== "takeover" || takeoverIsCelebration);
  const playlistLength = snapshot?.profile.playlist.length;
  const activeScreenId = snapshot?.profile.playlist.at(screenIndex);
  const missingScreenId = snapshot == null || view?.type !== "screen"
    ? null
    : snapshot.profile.playlist.at(view.screenIndex) ?? "<missing-playlist-entry>";
  const missingScreenReportKey = missingScreenId == null || snapshot == null || view?.type !== "screen" || getScreen(snapshot, view.screenIndex) != null
    ? null
    : `${snapshot.profile.id}\u0000${view.screenIndex}\u0000${missingScreenId}`;
  const rotationDurationSeconds = activeScreenId == null
    ? snapshot?.profile.defaultDurationSeconds
    : snapshot?.profile.screenDurations?.find((entry) => entry.screenId === activeScreenId)?.durationSeconds
      ?? snapshot?.profile.defaultDurationSeconds;

  useEffect(() => {
    if (viewType !== "takeover" || takeoverEndsAt == null || generatedAt == null || takeoverKey == null) return;
    const referenceTime = previewData ? new Date(generatedAt).getTime() : new Date().getTime();
    const remainingMilliseconds = Math.max(0, new Date(takeoverEndsAt).getTime() - referenceTime);
    if (remainingMilliseconds === 0) {
      setCompletedTakeoverKey(takeoverKey);
      return;
    }
    const timeout = window.setTimeout(() => setCompletedTakeoverKey(takeoverKey), remainingMilliseconds);
    return () => window.clearTimeout(timeout);
  }, [generatedAt, previewData, takeoverEndsAt, takeoverKey, viewType]);

  useEffect(() => {
    if (viewType !== "screen" || playlistLength == null || rotationDurationSeconds == null) return;
    if (rotationPaused) return;
    const timeout = window.setTimeout(
      () => setScreenIndex((current) => getNextTvScreenIndex(current, playlistLength)),
      rotationDurationSeconds * 1000,
    );
    return () => window.clearTimeout(timeout);
  }, [
    playlistLength,
    rotationDurationSeconds,
    rotationPaused,
    screenIndex,
    viewType,
  ]);

  useEffect(() => {
    if (!controlsVisible) return;
    const timeout = window.setTimeout(() => setControlsVisible(false), 2800);
    return () => window.clearTimeout(timeout);
  }, [controlsShowVersion, controlsVisible]);

  useEffect(() => {
    if (missingScreenReportKey == null) {
      missingScreenReportKeyRef.current = null;
      return;
    }
    if (missingScreenReportKeyRef.current === missingScreenReportKey) return;
    missingScreenReportKeyRef.current = missingScreenReportKey;
    if (snapshot == null || view?.type !== "screen") return;
    const screenId = snapshot.profile.playlist.at(view.screenIndex);
    captureError("tv-presentation-missing-screen", new HexclaveAssertionError(
      "TV presentation snapshot references a configured screen that is not available.",
      {
        profileId: snapshot.profile.id,
        screenId: screenId ?? null,
        screenIndex: view.screenIndex,
      },
    ));
  }, [missingScreenReportKey, snapshot, view]);

  useEffect(() => {
    const available = typeof document.documentElement.requestFullscreen === "function"
      && typeof document.exitFullscreen === "function";
    setFullscreenAvailable(available);
    if (!available) return;
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const showControls = () => {
      setControlsVisible(true);
      setControlsShowVersion((version) => version + 1);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      showControls();
      if (snapshot == null || view?.type !== "screen") return;
      const target = event.target;
      const isInteractiveTarget = target instanceof HTMLElement
        && target.closest("button, a, input, select, textarea, [contenteditable='true']") != null;
      if (event.key === "ArrowLeft") {
        setScreenIndex((current) => (current - 1 + snapshot.profile.playlist.length) % snapshot.profile.playlist.length);
      } else if (event.key === "ArrowRight") {
        setScreenIndex((current) => getNextTvScreenIndex(current, snapshot.profile.playlist.length));
      } else if (event.key === " " && !isInteractiveTarget) {
        event.preventDefault();
        setRotationPaused((current) => !current);
      } else if (event.key.toLowerCase() === "f" && fullscreenAvailable) {
        runAsynchronously(document.fullscreenElement == null
          ? document.documentElement.requestFullscreen()
          : document.exitFullscreen());
      }
    };
    window.addEventListener("mousemove", showControls);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", showControls);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fullscreenAvailable, snapshot, view]);

  if (loading) {
    return <div className="h-dvh w-full"><PresentationMessage type="loading" title="Preparing TV Mode" message="Assembling the latest office-safe snapshot…" /></div>;
  }
  if (snapshot == null && unavailableReason === "offline") {
    return <div className="h-dvh w-full"><PresentationMessage type="error" title="TV Mode Is Offline" message="Check the connection. TV Mode will resume automatically when it is back online." /></div>;
  }
  if (snapshot == null && unavailableReason === "unauthorized") {
    return <div className="h-dvh w-full"><PresentationMessage type="error" title="TV Mode Authorization Required" message="This display is no longer authorized to view the presentation. Pair it again to resume TV Mode." /></div>;
  }
  if (snapshot == null || view == null) {
    return <div className="h-dvh w-full"><PresentationMessage type="error" title="TV Mode Is Temporarily Unavailable" message="We couldn’t load the latest presentation. Please try again shortly." /></div>;
  }

  let content;
  let activeScreen: TvScreenSnapshot | null = null;
  const headerAccessory = highlight == null || !highlightVisible || view.type === "takeover"
    ? undefined
    : (
      <AnimatePresence>
        <EventHighlight highlight={highlight} />
      </AnimatePresence>
    );
  if (view.type === "fatal-error") {
    content = <PresentationMessage type="error" title="TV Mode Is Temporarily Unavailable" message={view.message} />;
  } else if (view.type === "empty") {
    content = <PresentationMessage type="empty" title="Waiting for Activity" message="This profile is ready. The presentation will update automatically when activity arrives." />;
  } else if (view.type === "takeover") {
    content = <EventTakeover takeover={view.presentedTakeover} />;
  } else {
    activeScreen = getScreen(snapshot, view.screenIndex);
    content = activeScreen == null
      ? <PresentationMessage type="empty" title="Waiting for Activity" message="This profile is ready. The presentation will update automatically when activity arrives." />
      : renderTvScreen(activeScreen, headerAccessory);
  }

  return (
    <div
      className="relative h-dvh min-h-[36rem] w-full overflow-hidden bg-[#070910] font-sans text-white"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(99,102,241,0.09),transparent_32%),radial-gradient(circle_at_85%_75%,rgba(34,211,238,0.06),transparent_30%)]" />
      {previewData ? (
        <div data-tv-preview-label className="pointer-events-none absolute left-1/2 top-5 z-30 -translate-x-1/2 rounded-full border border-amber-200/20 bg-black/65 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-100/80 backdrop-blur-xl">
          Preview · Synthetic Data
        </div>
      ) : null}
      <CelebrationFireworks
        ambientActive={celebrationAnimationActive && !takeoverIsCelebration}
        eventId={takeoverIsCelebration ? takeoverEventId : highlight?.event.id ?? null}
        entryBurst={false}
      />
      <CelebrationFireworks
        ambientActive={celebrationAnimationActive}
        eventId={takeoverIsCelebration ? takeoverEventId : highlight?.event.id ?? null}
        entryBurst={reducedMotion !== true && takeoverIsCelebration && animationVisible}
        foreground
        takeoverActive={takeoverIsCelebration}
      />
      <AnimatePresence mode="wait">
        <motion.div
          key={view.type === "screen" && activeScreen != null ? activeScreen.id : view.type}
          initial={reducedMotion ? false : { opacity: 0, scale: 1.008 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.35, ease: "easeOut" }}
          className="pointer-events-none relative z-10 h-full"
        >
          {content}
        </motion.div>
      </AnimatePresence>

      {view.type === "screen" && activeScreen != null ? (
        <footer className="pointer-events-none absolute inset-x-[clamp(2rem,5vw,14rem)] bottom-[clamp(1rem,2.5vh,5rem)] z-20 flex items-center justify-between">
          <div className="flex min-w-0 max-w-[34%] items-center gap-3">
            <span className="truncate text-[clamp(0.68rem,0.8vw,1.9rem)] font-medium text-white/55">{snapshot.project.displayName}</span>
            <span className="h-1 w-1 rounded-full bg-white/20" />
            <span className="truncate text-[clamp(0.68rem,0.8vw,1.9rem)] text-white/30">{snapshot.profile.displayName}</span>
          </div>
          <div className="flex items-center gap-2" aria-label={`Screen ${screenIndex + 1} of ${snapshot.profile.playlist.length}`}>
            {snapshot.profile.playlist.map((screenId, index) => (
              <span key={screenId} className={`h-1.5 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none ${index === screenIndex ? "w-8 bg-white/75" : "w-1.5 bg-white/[0.18]"}`} />
            ))}
          </div>
          <PresentationStatus snapshot={snapshot} />
        </footer>
      ) : null}

      {onExit == null ? null : (
        <div className={`absolute left-5 top-5 z-40 transition-opacity duration-200 hover:transition-none motion-reduce:transition-none ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <button type="button" tabIndex={controlsVisible ? 0 : -1} onClick={onExit} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/55 px-4 py-2 text-sm font-medium text-white/75 backdrop-blur-xl hover:bg-black/75">
            <ArrowLeftIcon className="h-4 w-4" weight="bold" />
            Exit TV Mode
          </button>
        </div>
      )}

      {view.type === "screen" ? (
        <div className={`absolute bottom-[clamp(3.5rem,7vh,6rem)] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-white/10 bg-black/65 p-1.5 shadow-2xl backdrop-blur-xl transition-opacity duration-200 hover:transition-none motion-reduce:transition-none ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <button
            type="button"
            tabIndex={controlsVisible ? 0 : -1}
            onClick={() => setScreenIndex((current) => (current - 1 + snapshot.profile.playlist.length) % snapshot.profile.playlist.length)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-white/65 hover:bg-white/10 hover:text-white"
            aria-label="Previous screen"
          >
            <CaretLeftIcon className="h-5 w-5" weight="bold" />
          </button>
          <button
            type="button"
            tabIndex={controlsVisible ? 0 : -1}
            onClick={() => setRotationPaused((current) => !current)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-white/65 hover:bg-white/10 hover:text-white"
            aria-label={rotationPaused ? "Resume rotation" : "Pause rotation"}
          >
            {rotationPaused ? <PlayIcon className="h-5 w-5" weight="fill" /> : <PauseIcon className="h-5 w-5" weight="fill" />}
          </button>
          <button
            type="button"
            tabIndex={controlsVisible ? 0 : -1}
            onClick={() => setScreenIndex((current) => getNextTvScreenIndex(current, snapshot.profile.playlist.length))}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-white/65 hover:bg-white/10 hover:text-white"
            aria-label="Next screen"
          >
            <CaretRightIcon className="h-5 w-5" weight="bold" />
          </button>
          {fullscreenAvailable ? (
            <>
              <span className="mx-1 h-6 w-px bg-white/10" />
              <button
                type="button"
                tabIndex={controlsVisible ? 0 : -1}
                onClick={() => runAsynchronously(document.fullscreenElement == null
                  ? document.documentElement.requestFullscreen()
                  : document.exitFullscreen())}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-white/65 hover:bg-white/10 hover:text-white"
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                {isFullscreen ? <CornersInIcon className="h-5 w-5" weight="bold" /> : <CornersOutIcon className="h-5 w-5" weight="bold" />}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
