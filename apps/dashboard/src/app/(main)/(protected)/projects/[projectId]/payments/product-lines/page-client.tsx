"use client";

import { Link } from "@/components/link";
import { Button, cn } from "@/components/ui";
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import PageClientProductLinesView from "../products/page-client-product-lines-view";

// Welcome illustration: Floating payment elements spread across the full width
function WelcomeIllustration() {
  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* Central credit card */}
      <div className={cn(
        "relative z-10",
        "w-40 h-24 md:w-56 md:h-32 lg:w-64 lg:h-40",
        "rounded-2xl",
        "bg-gradient-to-br from-blue-500/20 via-purple-500/15 to-cyan-500/20",
        "backdrop-blur-xl",
        "ring-1 ring-white/20",
        "shadow-[0_0_40px_rgba(59,130,246,0.15)]",
        "flex flex-col justify-between p-3 md:p-4 lg:p-5"
      )}>
        <div className="flex justify-between items-start">
          <div className="w-8 h-6 md:w-10 md:h-7 lg:w-12 lg:h-8 rounded bg-gradient-to-br from-amber-400/60 to-amber-600/40 ring-1 ring-amber-500/30" />
          <div className="flex gap-0.5">
            <div className="w-4 h-4 md:w-5 md:h-5 rounded-full bg-red-500/40 -mr-2" />
            <div className="w-4 h-4 md:w-5 md:h-5 rounded-full bg-amber-500/40" />
          </div>
        </div>
        <div className="space-y-1 md:space-y-1.5">
          <div className="h-1.5 md:h-2 bg-white/20 rounded-full w-3/4" />
          <div className="h-1.5 md:h-2 bg-white/10 rounded-full w-1/2" />
        </div>
      </div>

      {/* === LEFT SIDE ELEMENTS === */}

      {/* Coin - near center left */}
      <div className={cn(
        "absolute z-20",
        "top-[25%] left-[20%] md:left-[15%] lg:left-[12%]",
        "w-10 h-10 md:w-14 md:h-14 lg:w-16 lg:h-16",
        "rounded-full",
        "bg-gradient-to-br from-amber-400/30 to-amber-600/20",
        "ring-1 ring-amber-500/30",
        "shadow-[0_0_20px_rgba(245,158,11,0.2)]",
        "flex items-center justify-center",
        "rotate-[-15deg]"
      )}>
        <span className="text-amber-500/60 font-bold text-sm md:text-lg lg:text-xl">$</span>
      </div>

      {/* Price tag - bottom left */}
      <div className={cn(
        "absolute z-20",
        "bottom-[30%] left-[8%] md:left-[10%] lg:left-[8%]",
        "px-3 py-1.5 md:px-4 md:py-2",
        "rounded-xl",
        "bg-gradient-to-r from-green-500/20 to-emerald-500/15",
        "ring-1 ring-green-500/25",
        "shadow-[0_0_15px_rgba(34,197,94,0.15)]",
        "rotate-[-8deg]"
      )}>
        <span className="text-green-500/70 font-semibold text-xs md:text-sm">$9.99</span>
      </div>

      {/* Mini card - far left */}
      <div className={cn(
        "absolute z-0 hidden md:block",
        "top-[40%] left-[2%] lg:left-[3%]",
        "w-20 h-12 lg:w-24 lg:h-14",
        "rounded-xl",
        "bg-gradient-to-br from-purple-500/12 to-blue-500/8",
        "ring-1 ring-purple-500/15",
        "rotate-[-12deg]",
        "opacity-40"
      )} />

      {/* Floating dot decoration - top far left */}
      <div className={cn(
        "absolute hidden lg:block",
        "top-[15%] left-[5%]",
        "w-3 h-3 rounded-full",
        "bg-cyan-500/20",
        "ring-1 ring-cyan-500/10"
      )} />

      {/* Small receipt - top left area */}
      <div className={cn(
        "absolute z-0 hidden lg:block",
        "top-[8%] left-[18%]",
        "w-10 h-14 rounded-lg",
        "bg-foreground/[0.03]",
        "ring-1 ring-foreground/[0.05]",
        "rotate-[-18deg]",
        "p-1.5",
        "opacity-35"
      )}>
        <div className="space-y-0.5">
          <div className="h-0.5 bg-foreground/[0.06] rounded-full w-full" />
          <div className="h-0.5 bg-foreground/[0.04] rounded-full w-2/3" />
          <div className="h-0.5 bg-foreground/[0.04] rounded-full w-full" />
        </div>
      </div>

      {/* Tiny coin - bottom far left */}
      <div className={cn(
        "absolute z-10 hidden lg:flex",
        "bottom-[15%] left-[3%]",
        "w-6 h-6 rounded-full",
        "bg-gradient-to-br from-amber-400/15 to-amber-600/8",
        "ring-1 ring-amber-500/15",
        "items-center justify-center",
        "rotate-[25deg]",
        "opacity-35"
      )}>
        <span className="text-amber-500/30 font-bold text-[8px]">$</span>
      </div>

      {/* Small price badge - left mid */}
      <div className={cn(
        "absolute z-10 hidden md:block",
        "top-[55%] left-[5%] lg:left-[6%]",
        "px-1.5 py-0.5",
        "rounded-md",
        "bg-gradient-to-r from-cyan-500/12 to-blue-500/8",
        "ring-1 ring-cyan-500/15",
        "rotate-[-5deg]",
        "opacity-35"
      )}>
        <span className="text-cyan-500/40 font-semibold text-[8px]">$24</span>
      </div>

      {/* Floating dot - left lower */}
      <div className={cn(
        "absolute hidden md:block",
        "bottom-[45%] left-[22%]",
        "w-2 h-2 rounded-full",
        "bg-purple-500/15",
        "ring-1 ring-purple-500/10"
      )} />

      {/* === RIGHT SIDE ELEMENTS === */}

      {/* Mini card - top right */}
      <div className={cn(
        "absolute z-0",
        "top-[20%] right-[15%] md:right-[12%] lg:right-[10%]",
        "w-16 h-10 md:w-24 md:h-14 lg:w-28 lg:h-16",
        "rounded-xl",
        "bg-gradient-to-br from-cyan-500/15 to-blue-500/10",
        "ring-1 ring-cyan-500/20",
        "rotate-[20deg]",
        "opacity-60"
      )} />

      {/* Receipt - bottom right */}
      <div className={cn(
        "absolute z-0",
        "bottom-[25%] right-[8%] md:right-[10%] lg:right-[8%]",
        "w-12 h-16 md:w-16 md:h-20 lg:w-20 lg:h-24",
        "rounded-lg",
        "bg-foreground/[0.04]",
        "ring-1 ring-foreground/[0.06]",
        "rotate-[12deg]",
        "p-2",
        "opacity-50"
      )}>
        <div className="space-y-1">
          <div className="h-1 bg-foreground/[0.08] rounded-full w-full" />
          <div className="h-1 bg-foreground/[0.06] rounded-full w-3/4" />
          <div className="h-1 bg-foreground/[0.06] rounded-full w-full" />
          <div className="h-1 bg-foreground/[0.04] rounded-full w-1/2" />
        </div>
      </div>

      {/* Another coin - far right */}
      <div className={cn(
        "absolute z-10 hidden md:flex",
        "top-[50%] right-[3%] lg:right-[5%]",
        "w-8 h-8 md:w-10 md:h-10 lg:w-12 lg:h-12",
        "rounded-full",
        "bg-gradient-to-br from-amber-400/20 to-amber-600/10",
        "ring-1 ring-amber-500/20",
        "items-center justify-center",
        "rotate-[10deg]",
        "opacity-50"
      )}>
        <span className="text-amber-500/40 font-bold text-xs md:text-sm">$</span>
      </div>

      {/* Price badge - far right top */}
      <div className={cn(
        "absolute z-10 hidden lg:block",
        "top-[35%] right-[2%]",
        "px-2 py-1",
        "rounded-lg",
        "bg-gradient-to-r from-blue-500/15 to-cyan-500/10",
        "ring-1 ring-blue-500/20",
        "rotate-[5deg]",
        "opacity-40"
      )}>
        <span className="text-blue-500/50 font-semibold text-[10px]">$49</span>
      </div>

      {/* Floating dot decoration - bottom far right */}
      <div className={cn(
        "absolute hidden lg:block",
        "bottom-[45%] right-[4%]",
        "w-2 h-2 rounded-full",
        "bg-purple-500/25",
        "ring-1 ring-purple-500/15"
      )} />

      {/* Small mini card - right mid area */}
      <div className={cn(
        "absolute z-0 hidden lg:block",
        "top-[60%] right-[15%]",
        "w-14 h-9 rounded-lg",
        "bg-gradient-to-br from-green-500/10 to-emerald-500/6",
        "ring-1 ring-green-500/12",
        "rotate-[-8deg]",
        "opacity-40"
      )} />

      {/* Tiny receipt - top right area */}
      <div className={cn(
        "absolute z-0 hidden lg:block",
        "top-[5%] right-[22%]",
        "w-8 h-11 rounded-md",
        "bg-foreground/[0.025]",
        "ring-1 ring-foreground/[0.04]",
        "rotate-[8deg]",
        "p-1",
        "opacity-30"
      )}>
        <div className="space-y-0.5">
          <div className="h-0.5 bg-foreground/[0.05] rounded-full w-full" />
          <div className="h-0.5 bg-foreground/[0.03] rounded-full w-3/4" />
        </div>
      </div>

      {/* Small coin - bottom right mid */}
      <div className={cn(
        "absolute z-10 hidden lg:flex",
        "bottom-[10%] right-[18%]",
        "w-7 h-7 rounded-full",
        "bg-gradient-to-br from-amber-400/18 to-amber-600/10",
        "ring-1 ring-amber-500/18",
        "items-center justify-center",
        "rotate-[-12deg]",
        "opacity-40"
      )}>
        <span className="text-amber-500/35 font-bold text-[9px]">$</span>
      </div>

      {/* Price tag - far right bottom */}
      <div className={cn(
        "absolute z-10 hidden lg:block",
        "bottom-[35%] right-[2%]",
        "px-2 py-1",
        "rounded-lg",
        "bg-gradient-to-r from-purple-500/12 to-pink-500/8",
        "ring-1 ring-purple-500/15",
        "rotate-[-10deg]",
        "opacity-35"
      )}>
        <span className="text-purple-500/45 font-semibold text-[9px]">$19</span>
      </div>

      {/* Floating dot - right upper */}
      <div className={cn(
        "absolute hidden md:block",
        "top-[40%] right-[25%]",
        "w-1.5 h-1.5 rounded-full",
        "bg-cyan-500/20",
        "ring-1 ring-cyan-500/10"
      )} />

      {/* === CENTER AREA DECORATIONS === */}

      {/* Floating dot decoration - top center-left */}
      <div className={cn(
        "absolute hidden md:block",
        "top-[10%] left-[35%]",
        "w-2 h-2 rounded-full",
        "bg-green-500/20",
        "ring-1 ring-green-500/10"
      )} />

      {/* Floating dot decoration - top center-right */}
      <div className={cn(
        "absolute hidden md:block",
        "top-[8%] right-[38%]",
        "w-1.5 h-1.5 rounded-full",
        "bg-blue-500/20",
        "ring-1 ring-blue-500/10"
      )} />

      {/* Floating dot decoration - bottom center-right */}
      <div className={cn(
        "absolute hidden md:block",
        "bottom-[15%] right-[35%]",
        "w-2.5 h-2.5 rounded-full",
        "bg-amber-500/20",
        "ring-1 ring-amber-500/10"
      )} />

      {/* Floating dot decoration - bottom center-left */}
      <div className={cn(
        "absolute hidden md:block",
        "bottom-[12%] left-[38%]",
        "w-2 h-2 rounded-full",
        "bg-purple-500/15",
        "ring-1 ring-purple-500/08"
      )} />

      {/* Small sparkle dots - scattered */}
      <div className={cn(
        "absolute hidden lg:block",
        "top-[25%] left-[28%]",
        "w-1 h-1 rounded-full",
        "bg-white/20"
      )} />
      <div className={cn(
        "absolute hidden lg:block",
        "top-[22%] right-[30%]",
        "w-1 h-1 rounded-full",
        "bg-white/15"
      )} />
      <div className={cn(
        "absolute hidden lg:block",
        "bottom-[28%] left-[30%]",
        "w-1 h-1 rounded-full",
        "bg-white/18"
      )} />
      <div className={cn(
        "absolute hidden lg:block",
        "bottom-[25%] right-[28%]",
        "w-1 h-1 rounded-full",
        "bg-white/15"
      )} />

      {/* === TOP AREA ELEMENTS === */}

      {/* Mini card - top center */}
      <div className={cn(
        "absolute z-0 hidden md:block",
        "top-[12%] left-[45%]",
        "w-12 h-7 lg:w-16 lg:h-9 rounded-lg",
        "bg-gradient-to-br from-blue-500/10 to-cyan-500/6",
        "ring-1 ring-blue-500/12",
        "rotate-[6deg]",
        "opacity-35"
      )} />

      {/* Floating dot - top area */}
      <div className={cn(
        "absolute hidden lg:block",
        "top-[15%] right-[42%]",
        "w-2 h-2 rounded-full",
        "bg-amber-500/15",
        "ring-1 ring-amber-500/10"
      )} />

      {/* === BOTTOM AREA ELEMENTS === */}

      {/* Small price tag - bottom center */}
      <div className={cn(
        "absolute z-10 hidden md:block",
        "bottom-[18%] left-[48%]",
        "px-2 py-0.5",
        "rounded-md",
        "bg-gradient-to-r from-green-500/12 to-emerald-500/8",
        "ring-1 ring-green-500/12",
        "rotate-[-4deg]",
        "opacity-35"
      )}>
        <span className="text-green-500/40 font-semibold text-[8px]">$5</span>
      </div>

      {/* Floating dot - bottom area */}
      <div className={cn(
        "absolute hidden lg:block",
        "bottom-[20%] right-[45%]",
        "w-1.5 h-1.5 rounded-full",
        "bg-purple-500/18",
        "ring-1 ring-purple-500/10"
      )} />

      {/* Tiny coin - bottom left of center */}
      <div className={cn(
        "absolute z-10 hidden lg:flex",
        "bottom-[15%] left-[35%]",
        "w-5 h-5 rounded-full",
        "bg-gradient-to-br from-amber-400/12 to-amber-600/6",
        "ring-1 ring-amber-500/12",
        "items-center justify-center",
        "rotate-[15deg]",
        "opacity-30"
      )}>
        <span className="text-amber-500/25 font-bold text-[7px]">$</span>
      </div>
    </div>
  );
}

// Illustration: A single product card with decorative background elements
function ProductIllustration() {
  return (
    <div className="relative w-full h-full flex justify-center items-center overflow-hidden">
      {/* Decorative background elements */}
      <div className={cn(
        "absolute hidden md:block",
        "top-[20%] left-[10%] lg:left-[15%]",
        "w-20 h-12 lg:w-24 lg:h-14 rounded-xl",
        "bg-foreground/[0.02] ring-1 ring-foreground/[0.04]",
        "rotate-[-8deg] opacity-50"
      )} />
      <div className={cn(
        "absolute hidden md:block",
        "bottom-[25%] left-[5%] lg:left-[10%]",
        "w-16 h-10 lg:w-20 lg:h-12 rounded-xl",
        "bg-blue-500/[0.04] ring-1 ring-blue-500/[0.08]",
        "rotate-[12deg] opacity-40"
      )} />
      <div className={cn(
        "absolute hidden md:block",
        "top-[30%] right-[8%] lg:right-[12%]",
        "w-14 h-9 lg:w-18 lg:h-11 rounded-xl",
        "bg-foreground/[0.02] ring-1 ring-foreground/[0.04]",
        "rotate-[15deg] opacity-40"
      )} />
      <div className={cn(
        "absolute hidden lg:block",
        "bottom-[20%] right-[10%]",
        "w-16 h-10 rounded-xl",
        "bg-cyan-500/[0.03] ring-1 ring-cyan-500/[0.06]",
        "rotate-[-5deg] opacity-50"
      )} />

      {/* Main product card */}
      <div className={cn(
        "relative z-10 rounded-2xl p-4 md:p-5 lg:p-6",
        "w-36 md:w-44 lg:w-52",
        "bg-background/60 backdrop-blur-xl",
        "ring-1 ring-foreground/[0.06]",
        "shadow-sm",
        "bg-gradient-to-br from-blue-500/[0.08] to-transparent"
      )}>
        <div className="h-3 md:h-4 bg-foreground/[0.08] rounded-lg mb-3 md:mb-4 w-16 md:w-20"></div>
        <div className={cn(
          "h-12 md:h-14 lg:h-16 rounded-xl mb-3 md:mb-4 flex items-center justify-center",
          "bg-gradient-to-r from-blue-500/[0.15] to-blue-500/[0.08]",
          "ring-1 ring-blue-500/20"
        )}>
          <span className="text-sm md:text-base lg:text-lg text-blue-600 dark:text-blue-400 font-semibold">$19/mo</span>
        </div>
        <div className="space-y-1.5 md:space-y-2">
          <div className="h-2 md:h-2.5 bg-foreground/[0.06] rounded-full w-full"></div>
          <div className="h-2 md:h-2.5 bg-foreground/[0.04] rounded-full w-3/4"></div>
        </div>
      </div>
    </div>
  );
}

// Illustration: An item with decorative background elements
function ItemIllustration() {
  return (
    <div className="relative w-full h-full flex justify-center items-center overflow-hidden">
      {/* Decorative background elements */}
      <div className={cn(
        "absolute hidden md:flex",
        "top-[25%] left-[8%] lg:left-[12%]",
        "w-8 h-8 lg:w-10 lg:h-10 rounded-xl",
        "bg-purple-500/[0.06] ring-1 ring-purple-500/[0.10]",
        "items-center justify-center",
        "rotate-[-10deg] opacity-50"
      )}>
        <div className="w-3 h-3 rounded-full bg-purple-500/20" />
      </div>
      <div className={cn(
        "absolute hidden md:flex",
        "bottom-[30%] left-[5%] lg:left-[8%]",
        "w-10 h-10 lg:w-12 lg:h-12 rounded-xl",
        "bg-foreground/[0.03] ring-1 ring-foreground/[0.05]",
        "items-center justify-center",
        "rotate-[8deg] opacity-40"
      )}>
        <div className="w-4 h-4 rounded-full bg-foreground/[0.06]" />
      </div>
      <div className={cn(
        "absolute hidden md:flex",
        "top-[20%] right-[10%] lg:right-[15%]",
        "w-9 h-9 lg:w-11 lg:h-11 rounded-xl",
        "bg-cyan-500/[0.05] ring-1 ring-cyan-500/[0.08]",
        "items-center justify-center",
        "rotate-[12deg] opacity-40"
      )}>
        <div className="w-3 h-3 rounded-full bg-cyan-500/15" />
      </div>
      <div className={cn(
        "absolute hidden lg:flex",
        "bottom-[25%] right-[8%]",
        "w-10 h-10 rounded-xl",
        "bg-green-500/[0.04] ring-1 ring-green-500/[0.08]",
        "items-center justify-center",
        "rotate-[-6deg] opacity-50"
      )}>
        <div className="w-4 h-4 rounded-full bg-green-500/15" />
      </div>

      {/* Main item card */}
      <div className={cn(
        "relative z-10 rounded-2xl p-4 md:p-5 lg:p-6",
        "w-52 md:w-64 lg:w-72",
        "bg-background/60 backdrop-blur-xl",
        "ring-1 ring-foreground/[0.06]",
        "shadow-sm"
      )}>
        <div className="flex items-center gap-3 md:gap-4">
          <div className={cn(
            "w-10 h-10 md:w-12 md:h-12 lg:w-14 lg:h-14 rounded-xl flex items-center justify-center",
            "bg-gradient-to-br from-purple-500/[0.15] to-purple-500/[0.08]",
            "ring-1 ring-purple-500/20"
          )}>
            <div className="w-4 h-4 md:w-5 md:h-5 lg:w-6 lg:h-6 rounded-full bg-purple-500/40"></div>
          </div>
          <div className="flex-1">
            <div className="h-2.5 md:h-3 bg-foreground/[0.10] rounded-full w-20 md:w-24 mb-2"></div>
            <div className="h-2 md:h-2.5 bg-foreground/[0.05] rounded-full w-14 md:w-16"></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Illustration: Pricing table with decorative background elements
function PricingTableIllustration() {
  return (
    <div className="relative w-full h-full flex justify-center items-center overflow-hidden">
      {/* Decorative background elements - mini tables */}
      <div className={cn(
        "absolute hidden md:grid",
        "top-[15%] left-[5%] lg:left-[10%]",
        "grid-cols-3 gap-1 p-2 rounded-xl",
        "bg-foreground/[0.02] ring-1 ring-foreground/[0.04]",
        "rotate-[-8deg] opacity-40"
      )}>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="w-4 h-3 lg:w-5 lg:h-4 bg-foreground/[0.04] rounded" />
        ))}
      </div>
      <div className={cn(
        "absolute hidden lg:grid",
        "bottom-[20%] left-[8%]",
        "grid-cols-2 gap-1 p-2 rounded-xl",
        "bg-blue-500/[0.03] ring-1 ring-blue-500/[0.06]",
        "rotate-[10deg] opacity-40"
      )}>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="w-5 h-4 bg-blue-500/[0.06] rounded" />
        ))}
      </div>
      <div className={cn(
        "absolute hidden md:grid",
        "top-[25%] right-[8%] lg:right-[12%]",
        "grid-cols-2 gap-1 p-2 rounded-xl",
        "bg-purple-500/[0.03] ring-1 ring-purple-500/[0.06]",
        "rotate-[12deg] opacity-40"
      )}>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="w-4 h-3 lg:w-5 lg:h-4 bg-purple-500/[0.05] rounded" />
        ))}
      </div>
      <div className={cn(
        "absolute hidden lg:grid",
        "bottom-[15%] right-[6%]",
        "grid-cols-3 gap-1 p-2 rounded-xl",
        "bg-foreground/[0.02] ring-1 ring-foreground/[0.04]",
        "rotate-[-5deg] opacity-35"
      )}>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="w-4 h-3 bg-foreground/[0.04] rounded" />
        ))}
      </div>

      {/* Main pricing table */}
      <div className={cn(
        "relative z-10 rounded-2xl p-3 md:p-4 lg:p-5",
        "bg-background/60 backdrop-blur-xl",
        "ring-1 ring-foreground/[0.06]",
        "shadow-sm"
      )}>
        {/* Grid container - relative for overlay positioning */}
        <div className="relative">
          {/* Main grid with cells */}
          <div className="grid grid-cols-4 gap-1.5 md:gap-2 lg:gap-2.5">
            {/* Row 0: Header row */}
            <div className="h-7 md:h-8 lg:h-10" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.04] rounded-lg flex items-center justify-center">
              <div className="h-2 md:h-2.5 bg-foreground/[0.08] rounded-full w-8 md:w-10" />
            </div>
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.04] rounded-lg flex items-center justify-center">
              <div className="h-2 md:h-2.5 bg-foreground/[0.08] rounded-full w-8 md:w-10" />
            </div>
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.04] rounded-lg flex items-center justify-center">
              <div className="h-2 md:h-2.5 bg-foreground/[0.08] rounded-full w-8 md:w-10" />
            </div>

            {/* Row 1 */}
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.04] rounded-lg flex items-center justify-center">
              <div className="h-2 md:h-2.5 bg-foreground/[0.08] rounded-full w-10 md:w-12" />
            </div>
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />

            {/* Row 2 */}
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.04] rounded-lg flex items-center justify-center">
              <div className="h-2 md:h-2.5 bg-foreground/[0.08] rounded-full w-10 md:w-12" />
            </div>
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />

            {/* Row 3 */}
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.04] rounded-lg flex items-center justify-center">
              <div className="h-2 md:h-2.5 bg-foreground/[0.08] rounded-full w-10 md:w-12" />
            </div>
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
            <div className="h-7 md:h-8 lg:h-10 bg-foreground/[0.03] rounded-lg" />
          </div>

          {/* Overlay grid for highlights - same structure, positioned on top */}
          <div className="absolute inset-0 grid grid-cols-4 gap-1.5 md:gap-2 lg:gap-2.5 pointer-events-none">
            {/* Column highlight (column 2) - uses grid placement to span all rows */}
            <div
              className="rounded-lg border-2 border-dashed border-blue-500/50"
              style={{ gridColumn: 2, gridRow: '1 / 5' }}
            />
            {/* Row highlight (row 2) - uses grid placement to span all columns */}
            <div
              className="rounded-lg border-2 border-dashed border-purple-500/50"
              style={{ gridColumn: '1 / 5', gridRow: 2 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

type Slide = {
  illustration: React.ReactNode,
  title: string,
  subtitle: React.ReactNode,
  isWelcome?: boolean,
};

const slides: Slide[] = [
  {
    illustration: <WelcomeIllustration />,
    title: "Welcome to Payments!",
    subtitle: (
      <span className="flex items-center gap-1.5">
        Click <ArrowRightIcon className="h-3.5 w-3.5 md:h-4 md:w-4" /> to get started
      </span>
    ),
    isWelcome: true,
  },
  {
    illustration: <ProductIllustration />,
    title: "Products",
    subtitle: <>
      Products are plans, goods, or offers your customers buy.<br />
      Each product can have multiple prices, like monthly vs. yearly billing.
    </>,
  },
  {
    illustration: <ItemIllustration />,
    title: "Items",
    subtitle: <>
      Items are what customers receive when they purchase a product.<br />
      This includes feature access, usage limits, and credit balances.
    </>,
  },
  {
    illustration: <PricingTableIllustration />,
    title: "Pricing Table",
    subtitle: <>
      Products are columns and items are rows in your pricing table.<br />
      Products can include many items, and items can be in multiple products.
    </>,
  },
];

function OnboardingSlideshow() {
  const projectId = useProjectId();
  const [currentSlide, setCurrentSlide] = useState(0);

  const isLastSlide = currentSlide === slides.length - 1;
  const isFirstSlide = currentSlide === 0;
  const slide = slides[currentSlide];

  const goToNextSlide = () => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide(currentSlide + 1);
    }
  };

  const goToPreviousSlide = () => {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  };

  return (
    <PageLayout>
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center">
        {/* Slide content container - fills available space */}
        <div className="relative w-full flex-1 min-h-0">
          {slides.map((s, index) => (
            <div
              key={index}
              className={cn(
                "absolute inset-0 flex flex-col transition-opacity duration-300",
                index === currentSlide ? "opacity-100" : "opacity-0 pointer-events-none"
              )}
            >
              {/* Illustration - fills width, takes most of the height */}
              <div className="w-full flex-1 min-h-0">
                {s.illustration}
              </div>
            </div>
          ))}
        </div>

        {/* Text content - fixed at bottom, compact */}
        <div className="w-full flex flex-col items-center px-4 pt-4 md:pt-6">
          {/* Title - responsive sizing */}
          <h2 className={cn(
            "text-center font-semibold tracking-tight",
            slide.isWelcome
              ? "text-2xl md:text-4xl lg:text-5xl whitespace-nowrap mb-2 md:mb-3"
              : "text-xl md:text-2xl lg:text-3xl mb-1.5 md:mb-2"
          )}>
            {slide.title}
          </h2>

          {/* Subtitle - wider max-width */}
          <p className={cn(
            "text-center max-w-2xl",
            slide.isWelcome
              ? "text-muted-foreground/60 text-sm md:text-base"
              : "text-muted-foreground text-sm md:text-base"
          )}>
            {slide.subtitle}
          </p>
        </div>

        {/* Navigation row: Back button, dots, Next button - tighter spacing */}
        <div className="flex items-center gap-4 md:gap-6 py-4 md:py-5">
          {/* Back button - always rendered but invisible on first slide to maintain layout */}
          <Button
            variant="ghost"
            size="sm"
            onClick={goToPreviousSlide}
            className={cn("md:h-10 md:w-10", isFirstSlide && "invisible")}
          >
            <ArrowLeftIcon className="h-4 w-4 md:h-5 md:w-5" />
          </Button>

          {/* Slide indicators */}
          <div className="flex gap-2 md:gap-3">
            {slides.map((_, index) => (
              <button
                key={index}
                onClick={() => setCurrentSlide(index)}
                className={cn(
                  "w-2 h-2 md:w-2.5 md:h-2.5 rounded-full transition-colors hover:transition-none",
                  index === currentSlide ? "bg-primary" : "bg-muted-foreground/30"
                )}
              />
            ))}
          </div>

          {/* Next button - always rendered but invisible on last slide to maintain layout */}
          <Button
            variant="ghost"
            size="sm"
            onClick={goToNextSlide}
            className={cn("md:h-10 md:w-10", isLastSlide && "invisible")}
          >
            <ArrowRightIcon className="h-4 w-4 md:h-5 md:w-5" />
          </Button>
        </div>

        {/* Create button - always rendered but invisible when not on last slide to prevent layout shift */}
        <Link href={`/projects/${projectId}/app-configuration/payments/products/new`}>
          <Button size="lg" className={cn("mb-4 md:mb-6", !isLastSlide && "invisible")}>
            <PlusIcon className="h-4 w-4 md:h-5 md:w-5 mr-2" />
            Create Your First Product
          </Button>
        </Link>
      </div>
    </PageLayout>
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const paymentsConfig = adminApp.useProject().useConfig().payments;

  const hasAnyProductsOrItems = useMemo(() => {
    return (
      Object.keys(paymentsConfig.products).length > 0 ||
      Object.keys(paymentsConfig.items).length > 0
    );
  }, [paymentsConfig.products, paymentsConfig.items]);

  if (!hasAnyProductsOrItems) {
    return <OnboardingSlideshow />;
  }

  return (
    <PageLayout title='Product Lines' description="Mutually exclusive sets of products. Customers can purchase one product of each product line.">
      <PageClientProductLinesView />
    </PageLayout>
  );
}

