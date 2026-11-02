"use client";

import { hexclaveClientApp } from "@/hexclave/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
if (typeof window !== "undefined") {
  convex.setAuth(
    hexclaveClientApp.getConvexClientAuth({})
  );
}

export default function ConvexClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
