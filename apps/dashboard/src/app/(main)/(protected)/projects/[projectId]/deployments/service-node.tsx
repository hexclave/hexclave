"use client";

import { cn } from "@/components/ui";
import { ArrowsOutCardinalIcon, GlobeSimpleIcon, LightningIcon } from "@phosphor-icons/react";
import { NODE_HEIGHT, NODE_WIDTH, getServiceTypeMeta, type BoardService } from "./board-model";
import { STATUS_META, getAccentClasses, type VariantConfig } from "./variants";

type ServiceNodeProps = {
  service: BoardService,
  variant: VariantConfig,
  selected: boolean,
  dragging: boolean,
  // Highlighted because the currently-selected node is connected to this one.
  linked: boolean,
  onPointerDown: (e: React.PointerEvent, serviceId: string) => void,
};

export function ServiceNode({ service, variant, selected, dragging, linked, onPointerDown }: ServiceNodeProps) {
  const meta = getServiceTypeMeta(service.type);
  // Colour comes from the service's deployment SOURCE, not its type — with
  // several repositories on one map, whose repository a service belongs to is
  // what a reader needs at a glance, and every container node has the same type.
  const accent = getAccentClasses(service.accent);
  const Icon = meta.icon;
  const status = STATUS_META.get(service.status);
  const referenceCount = service.envVars.filter((e) => e.type === "connection").length;

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={(e) => onPointerDown(e, service.id)}
      style={{ left: service.x, top: service.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "group absolute flex select-none overflow-hidden text-left outline-none",
        "transition-shadow duration-150 hover:transition-none",
        dragging ? "cursor-grabbing z-30" : "cursor-grab",
        variant.nodeRadiusClassName,
        variant.nodeClassName,
        selected && variant.nodeSelectedClassName,
        linked && !selected && "ring-2 ring-primary/30 dark:ring-primary/40",
        dragging && "scale-[1.02]",
      )}
    >
      {variant.showAccentBar && (
        <div className={cn("h-full w-1 shrink-0", accent.bar)} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", accent.chip)}>
            <Icon className="h-4 w-4" weight="fill" />
          </div>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-semibold text-foreground",
              variant.mono && "font-mono tracking-tight",
            )}
          >
            {service.name}
          </span>
          {status && (
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  status.color === "green" && "bg-emerald-500",
                  status.color === "cyan" && "bg-cyan-500",
                  status.color === "orange" && "bg-amber-500",
                  status.color === "red" && "bg-red-500",
                )}
              />
              {status.label}
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          {/* The deploy file this came from. Colour alone can't be read as an
              identity — it only groups — so the node names the source too. */}
          {service.sourceId != null && (
            <span
              className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", accent.chip)}
              title={`Deployment source: ${service.sourceId}`}
            >
              {service.sourceId}
            </span>
          )}
          <span className={cn("min-w-0 truncate text-xs text-muted-foreground", variant.mono && "font-mono")}>
            {service.source}
          </span>
        </div>

        <div className="mt-auto flex items-center gap-3 text-[11px] text-muted-foreground/80">
          {service.domain && (
            <span className="flex min-w-0 items-center gap-1">
              <GlobeSimpleIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{service.domain}</span>
            </span>
          )}
          {referenceCount > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <LightningIcon className="h-3 w-3" weight="fill" />
              {referenceCount}
            </span>
          )}
        </div>
      </div>

      {/* Drag affordance, subtle until hover. */}
      <div className="pointer-events-none absolute right-2 top-2 opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-hover:transition-none">
        <ArrowsOutCardinalIcon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}
